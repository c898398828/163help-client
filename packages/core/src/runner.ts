/**
 * ClientRuntime：core 编排器（把 auth/heartbeat/dispatch/logger 串成完整运行循环）
 * 各端仅需：实现 PlatformAdapter + ApiTransport + 播放器回调 → 交给 runtime。
 */
import { AuthManager } from './auth.js';
import { JobStateMachine, type CurrentJob } from './dispatch.js';
import { HeartbeatEngine } from './heartbeat.js';
import { ClientLogger } from './logger.js';
import { EventBus } from './events.js';
import type { ApiResult, ClientType, FinishInput, MePayload, NextPayload, PlatformAdapter } from './types.js';

/** 端侧必须提供的四件套 */
export interface RuntimeDeps {
  adapter: PlatformAdapter;
  transport: {
    next(token: string): Promise<ApiResult<NextPayload>>;
    finish(token: string, input: FinishInput): Promise<ApiResult<{ settled?: boolean }>>;
    abandon(token: string, reason: string, detail: string): Promise<void>;
    heartbeat(token: string, input: { jobId: string; playedMs: number; positionMs: number; durationMs: number; monotonic: boolean }): Promise<boolean>;
    refresh(token: string): Promise<import('./types.js').LoginPayload | null>;
    me(): Promise<ApiResult<MePayload>>;
    sendLog(payload: import('./types.js').ClientLogPayload): Promise<void>;
    /** 是否支持 session refresh；false（如 docker key 模式）时 401 直接停循环，不做刷新重试 */
    canRefresh?: boolean;
  };
  player: {
    /** 命令播放器开始播 target（返回 false=加载失败，走放弃分支） */
    play(musicId: string, durationMs: number, ownerName: string): Promise<boolean>;
    /** 播放器停止（放弃/结算后） */
    stop(): void;
    /** 订阅播放进度（接入心跳 pulse） */
    onProgress(cb: (playedMs: number, positionMs: number, durationMs: number) => void): void;
  };
}

export class ClientRuntime {
  readonly bus = new EventBus();
  readonly auth: AuthManager;
  readonly job: JobStateMachine;
  readonly heart: HeartbeatEngine;
  readonly log: ClientLogger;

  constructor(private deps: RuntimeDeps) {
    this.log = new ClientLogger((p) => this.deps.transport.sendLog(p), {
      // B5：log:append 真正发射（每次 log.push → core bus → 面板 logCount）
      // 载荷保持 msg/ts 兼容既有端点，额外附 text/event 供新消费方
      onAppend: (p) => this.bus.emit('log:append', { level: p.level, ts: Date.now(), msg: p.msg, text: p.msg, event: p.event }),
    });
    this.auth = new AuthManager(deps.adapter, {
      refresh: (t) => deps.transport.refresh(t),
      me: () => deps.transport.me(),
      login: async () => null, // 登录走页面 oauth
    }, this.bus);

    this.job = new JobStateMachine({
      next: async () => {
        const token = await this.auth.ensureToken();
        if (!token) return { status: 401, payload: null, error: 'no_token' };
        const r = await this.deps.transport.next(token);
        this.on401(r.status);
        return r;
      },
      finish: async (input) => {
        const token = await this.auth.ensureToken();
        if (!token) return { status: 401, payload: null, error: 'no_token' };
        const r = await this.deps.transport.finish(token, input);
        this.on401(r.status);
        return r;
      },
      abandon: async (r, d) => {
        const token = await this.auth.ensureToken();
        if (token) { try { await this.deps.transport.abandon(token, r, d); } catch { /* 静默 */ } }
        this.log.push('warn', 'job_abandon', r, { detail: d });
      },
      onPlaying: (job) => {
        this.heart.start(job.jobId);
        void this.deps.player.play(job.musicId, job.targetMs, '').then((ok) => {
          if (!ok) this.failStart(job.jobId, '播放器加载失败');
        }).catch((e) => this.failStart(job.jobId, '播放器异常：' + String(e)));
      },
      onSettleFailed: (code, msg) => {
        this.log.push('error', 'settle_failed', msg, { code });
        this.bus.emit('job:phase', 'settle_failed');
      },
    }, this.bus);

    this.heart = new HeartbeatEngine(this.bus, {
      heartbeat: async (input) => {
        const token = await this.auth.ensureToken();
        if (!token) return false;
        try { return await this.deps.transport.heartbeat(token, input); } catch { return false; }
      },
    }, deps.adapter, {
      onAbandon: (reason, detail) => {
        this.log.push('error', 'heartbeat_abandon', reason, { detail });
        void this.job.abandon(reason, detail);
      },
      onResume: () => this.log.push('info', 'hb_resume', '恢复续听'),
    });

    deps.player.onProgress((playedMs, positionMs, durationMs) => {
      this.job.updateProgress(playedMs);
      void this.heart.pulse(playedMs, positionMs, durationMs, true);
      void this.maybeFinish(positionMs, durationMs);
    });

    // UI 镜像事件
    this.bus.on('job:current', (j: CurrentJob | null) => { if (j) this.log.push('info', 'job_start', j.musicName); });
  }

  async start(autostart: boolean): Promise<void> {
    await this.auth.refreshUser();
    if (autostart && this.auth.hasToken()) {
      this.running = true;
      void this.cycle();
    }
  }

  private running = false;
  private cycling = false;
  private finishing = false;
  private authFailed = false;
  private lastNoTargetReason = '';

  /** 401 处理：标记循环停止；支持 refresh 的端（油猴/扩展 session）再走刷新重试 */
  private on401(status: number): void {
    if (status !== 401) return;
    this.authFailed = true;
    if (this.deps.transport.canRefresh !== false) void this.auth.onUnauthorized();
  }

  /** 停止主循环与心跳（进程退出/测试用；已提交的 finish 不受影响） */
  stop(): void {
    this.running = false;
    this.heart.stop();
    try { this.deps.player.stop(); } catch { /* 播放器已销毁 */ }
  }

  /** 主循环：领单 → 播 → 结束/失败 → 下一单（带 3s 间隔与退出） */
  private async cycle(): Promise<void> {
    if (this.cycling) return; // 防重复循环（重复 start / 保存配置后重启）
    this.cycling = true;
    this.running = true;
    this.authFailed = false; // 新一轮循环：重新尝试凭证（重存配置后可自动恢复）
    try {
      while (this.running) {
        if (!this.auth.hasToken()) {
          this.log.push('warn', 'cycle_stop', '无可用凭证，停止领单循环');
          return;
        }
        if (this.authFailed) {
          this.log.push('warn', 'cycle_stop', '凭证被服务端拒绝（401），停止领单循环（重新保存配置后自动恢复）');
          return;
        }
        if (this.auth.status === 'logged_out') {
          this.log.push('warn', 'cycle_stop', '凭证失效，停止领单循环（重新保存配置后自动恢复）');
          return;
        }
        const p = await this.job.fetchNext();
        if (p && p.noTargetReason) {
          const reason = String(p.noTargetReason);
          if (reason !== this.lastNoTargetReason) { // 去重：避免每 3s 刷同一条
            this.lastNoTargetReason = reason;
            this.log.push('info', 'no_target', reason);
          }
        } else if (p) {
          this.lastNoTargetReason = '';
        }
        await sleep(3000);
      }
    } finally {
      this.cycling = false;
    }
  }

  /** 播放未开始（加载失败/播放器异常）：停心跳、放弃本单，让主循环继续领下一单 */
  private failStart(jobId: string, detail: string): void {
    if (this.job.current?.jobId !== jobId) return; // 已被结算/放弃
    this.heart.stop();
    void this.job.abandon('play_start_fail', detail);
  }

  /** 播放完成判定：达到目标时长，或歌曲先于目标播完（避免永久卡单）→ 结算并让主循环领下一单 */
  private async maybeFinish(positionMs: number, durationMs: number): Promise<void> {
    const job = this.job.current;
    if (!job || this.finishing || !this.running) return;
    const playedMs = job.playedMs;
    const reachedTarget = job.targetMs > 0 && playedMs >= job.targetMs;
    const songEnded = durationMs > 0 && playedMs >= durationMs;
    if (!reachedTarget && !songEnded) return;
    this.finishing = true;
    try {
      this.heart.stop();
      const r = await this.job.submitFinish({
        jobId: job.jobId, playedMs, positionMs, durationMs,
        playbackRate: 1, jumpCount: 0, backwardJumpCount: 0,
        listenDriftMs: 0, recoveryAttempts: 0, stallDetected: false,
      });
      this.log.push(r === 'settled' ? 'info' : 'warn', 'job_finish', `本单结算：${r}`, { playedMs, targetMs: job.targetMs });
      this.deps.player.stop();
    } finally {
      this.finishing = false;
    }
  }

  private _sessionAccepted = false;
  /** 登录页回调（oauth 成功后） */
  acceptSession(p: import('./types.js').LoginPayload): void {
    this.auth.acceptSession(p);
    this.log.push('info', 'session', '会话已建立'); // B5：触发 log:append
    if (!this._sessionAccepted) { this._sessionAccepted = true; void this.cycle(); }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
