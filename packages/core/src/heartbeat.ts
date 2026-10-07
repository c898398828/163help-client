/**
 * 心跳引擎（严格协议 §4）：
 * - 播放期间每 10s 上报
 * - 首心跳：领取后 30s 内必须出现，否则 abandon('play_start_fail')
 * - 中断：距上次心跳 >45s → abandon('heartbeat_lost')
 * - freeze/resume：冻结前补帧；恢复后任务仍有效→续听；已过期→自动重接
 * - 无心跳 = 无效播放（服务端不补结算，客户端明示重听）
 */
import { EventBus } from './events.js';
import type { HeartbeatInput, PlatformAdapter } from './types.js';

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const FIRST_HB_GRACE_MS = 30_000;
export const HB_STALL_MS = 45_000;

/** 纯函数：心跳当前状态（供单测与 UI 提示；无 timers） */
export function hbState(lastAt: number, now: number, stallMs: number): 'ok' | 'stall' {
  return lastAt > 0 && now - lastAt > stallMs ? 'stall' : 'ok';
}

export interface HeartbeatEvents {
  onAbandon(reason: 'play_start_fail' | 'heartbeat_lost', detail: string): void;
  onResume(): void; // 恢复续听
}

export class HeartbeatEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAckAt = -1; // 上次「成功」心跳（服务端确认）时间；-1 = 尚未成功过（失败不计入，避免掩盖心跳被拒）
  private firstAttemptAt = -1; // 首次上报尝试时间（用于「从未成功」时的中断判定）
  private jobId = '';
  private stopped = true;
  private lastProgress = { playedMs: 0, positionMs: 0, durationMs: 0 };
  private opts: { firstHbGraceMs: number; hbStallMs: number; intervalMs: number };

  constructor(
    private bus: EventBus,
    private api: { heartbeat(input: HeartbeatInput): Promise<boolean> },
    private adapter: PlatformAdapter,
    private events: HeartbeatEvents,
    opts: Partial<{ firstHbGraceMs: number; hbStallMs: number; intervalMs: number }> = {},
  ) {
    this.opts = {
      firstHbGraceMs: opts.firstHbGraceMs ?? FIRST_HB_GRACE_MS,
      hbStallMs: opts.hbStallMs ?? HB_STALL_MS,
      intervalMs: opts.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    };
    this.adapter.onLifecycle?.('freeze', () => { void this.flush().catch(() => {}); });
    this.adapter.onLifecycle?.('resume', () => { void this.onResumeLifecycle(); });
  }

  get job(): string { return this.jobId; }

  start(jobId: string): void {
    this.stop();
    this.jobId = jobId;
    this.stopped = false;
    // 首心跳宽限
    this.graceTimer = setTimeout(() => {
      if (!this.stopped && this.lastAckAt < 0) {
        this.stop(); // 只放弃一次：避免后续 tick 重复触发
        this.events.onAbandon('play_start_fail', `首心跳 30s 内未获服务端确认`);
      }
    }, this.opts.firstHbGraceMs);
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs);
  }

  /** 播放器进度更新（不发请求）：按协议每 intervalMs 由 tick 带上「最近一次进度」上报 */
  update(playedMs: number, positionMs: number, durationMs: number): void {
    this.lastProgress = { playedMs, positionMs, durationMs };
  }

  /** 立即补报一次（freeze 前等场景）；是否成功以服务端确认为准 */
  async pulse(playedMs?: number, positionMs?: number, durationMs?: number): Promise<void> {
    if (playedMs !== undefined) this.update(playedMs, positionMs ?? playedMs, durationMs ?? 0);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.jobId) return;
    const p = this.lastProgress;
    if (this.firstAttemptAt < 0) this.firstAttemptAt = Date.now();
    const ok = await this.api.heartbeat({
      jobId: this.jobId, playedMs: p.playedMs, positionMs: p.positionMs, durationMs: p.durationMs, monotonic: true,
    });
    if (ok) {
      const now = Date.now();
      const intervalMs = this.lastAckAt >= 0 ? now - this.lastAckAt : HEARTBEAT_INTERVAL_MS;
      this.lastAckAt = now; // 只有服务端确认才算「有心跳」
      this.bus.emit('heartbeat:tick', { jobId: this.jobId, intervalMs, lastAtMs: now });
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.jobId) return;
    if (this.lastProgress.playedMs <= 0) return; // 播放尚未开始：不发 0 进度心跳（与 4.x 一致）
    // 中断判定：以「上次确认」为基准；从未确认过则从首次尝试算起
    const ref = this.lastAckAt >= 0 ? this.lastAckAt : this.firstAttemptAt;
    if (ref >= 0 && Date.now() - ref > this.opts.hbStallMs) {
      this.stop(); // 只放弃一次：避免后续 tick 重复触发
      this.events.onAbandon('heartbeat_lost', `距上次有效心跳 ${Math.round((Date.now() - ref) / 1000)}s`);
      return;
    }
    await this.flush();
  }

  private async onResumeLifecycle(): Promise<void> {
    if (this.stopped || !this.jobId) return;
    // 恢复：tick 会立即续听；事件告知 UI
    this.bus.emit('heartbeat:tick', { jobId: this.jobId, intervalMs: 0, lastAtMs: Date.now() });
    this.events.onResume();
  }

  stop(): void {
    this.stopped = true;
    this.jobId = '';
    this.lastAckAt = -1;
    this.firstAttemptAt = -1;
    this.lastProgress = { playedMs: 0, positionMs: 0, durationMs: 0 };
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  }
}
