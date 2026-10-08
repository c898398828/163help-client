/**
 * 心跳引擎（严格协议 §4）：
 * - 首个真实正进度立即上报，之后播放期间每 10s 上报
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
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private lastSampleAt = -1;
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

  /** 首个真实正进度立即上报；之后仅更新采样，由 tick 按 intervalMs 上报。 */
  update(playedMs: number, positionMs: number, durationMs: number): void {
    if (this.stopped || ![playedMs, positionMs, durationMs].every(Number.isFinite)) return;
    this.lastProgress = { playedMs, positionMs, durationMs };
    this.lastSampleAt = Date.now();
    // 避免刚错过 20s tick 的起播等到 30s，先被首心跳宽限期放弃。
    // 首次尝试即置位；失败仍等后续 tick，不随每秒进度高频重试。
    if (playedMs > 0 && this.firstAttemptAt < 0) void this.flush().catch(() => {});
  }

  /** 立即补报一次（freeze 前等场景）；是否成功以服务端确认为准 */
  async pulse(playedMs?: number, positionMs?: number, durationMs?: number): Promise<void> {
    if (playedMs !== undefined) this.update(playedMs, positionMs ?? playedMs, durationMs ?? 0);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.jobId || this.lastProgress.playedMs <= 0) return;
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const jobId = this.jobId;
    const p = this.lastProgress;
    if (this.firstAttemptAt < 0) {
      this.firstAttemptAt = Date.now();
      // 从首发时刻重新计算周期，避免紧接着领取时刻的旧 tick 再次上报。
      // 只重置 interval，领取后的首心跳确认宽限期保持不变。
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs);
    }
    const request = (async () => {
      try {
        const ok = await this.api.heartbeat({ jobId, ...p, monotonic: true });
        if (!ok || this.stopped || generation !== this.generation) return;
        const now = Date.now();
        const intervalMs = this.lastAckAt >= 0 ? now - this.lastAckAt : this.opts.intervalMs;
        this.lastAckAt = now;
        this.bus.emit('heartbeat:tick', { jobId, intervalMs, lastAtMs: now });
      } catch { /* 失败不确认；由首心跳/中断窗口收敛 */ }
    })();
    this.inFlight = request;
    try { await request; }
    finally { if (generation === this.generation) this.inFlight = null; }
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.jobId) return;
    if (this.lastSampleAt >= 0 && Date.now() - this.lastSampleAt > this.opts.hbStallMs) {
      this.stop();
      this.events.onAbandon('heartbeat_lost', '播放器进度采样已中断，不再重发旧进度');
      return;
    }
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
    // 恢复后重新校验时间窗口；不能伪造一条成功心跳。
    await this.tick();
    if (!this.stopped) this.events.onResume();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.inFlight = null;
    this.lastSampleAt = -1;
    this.jobId = '';
    this.lastAckAt = -1;
    this.firstAttemptAt = -1;
    this.lastProgress = { playedMs: 0, positionMs: 0, durationMs: 0 };
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  }
}
