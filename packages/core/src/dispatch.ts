/**
 * 任务状态机：next / finish / abandon 的本地编排（防重入、防并发双发）
 * 状态：idle → fetching → playing → (settle) → idle
 * finish 被拒（job_expired 等）→ 明示并进入下一单（无宽容语义）
 */
import { EventBus } from './events.js';
import type { ApiResult, FinishInput, FinishPayload, JobPhase, NextPayload } from './types.js';

export interface DispatchDeps {
  next(): Promise<ApiResult<NextPayload>>;
  finish(input: FinishInput): Promise<ApiResult<FinishPayload>>;
  abandon(reason: string, detail: string, jobId: string): Promise<void>;
  /** 播放开始回调：由 UI/播放器拉起心跳 */
  onPlaying(job: CurrentJob): void;
  /** 结算失败提示（403/过期等）——明示「无心跳未结算，请重新听」 */
  onSettleFailed(code: string, msg: string): void;
}

export interface CurrentJob {
  jobId: string;
  /** 可播放的音乐 id（song:xxx / 数字），播放器必须用它，不要用展示名 */
  musicId: string;
  musicName: string;
  targetMs: number;
  playedMs: number;
}

export class JobStateMachine {
  phase: JobPhase = 'idle';
  current: CurrentJob | null = null;
  private busy = false; // 防重入
  private idleWaiters: Array<() => void> = [];

  /** 配置切换必须等旧任务领取/结算/放弃完成，再替换凭证。 */
  waitForIdle(): Promise<void> {
    if (this.phase === 'idle') return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  constructor(private deps: DispatchDeps, private bus: EventBus) {}

  private setPhase(p: JobPhase): void {
    this.phase = p;
    this.bus.emit('job:phase', p);
    if (p === 'idle') this.idleWaiters.splice(0).forEach(resolve => resolve());
  }

  /** 领取下一单（空闲时调用；防并发） */
  async fetchNext(): Promise<NextPayload | null> {
    if (this.busy || this.phase !== 'idle') return null;
    this.busy = true;
    this.setPhase('fetching');
    try {
      const r = await this.deps.next();
      if (r.status === 200 && r.payload && r.payload.jobId && r.payload.musicId) {
        this.current = {
          jobId: r.payload.jobId,
          musicId: String(r.payload.musicId),
          musicName: String(r.payload.musicId),
          targetMs: r.payload.targetDurationMs ?? 0,
          playedMs: 0,
        };
        this.setPhase('playing');
        this.bus.emit('job:current', this.current);
        this.deps.onPlaying(this.current);
        return r.payload;
      }
      // noTarget / 无单：回 idle（reason 由调用方展示）
      this.setPhase('idle');
      return r.payload ?? null;
    } catch (e) {
      // 传输异常（网络重置等）：必须回 idle，否则 phase 卡在 fetching 会「永远不再领单」且无任何日志
      this.setPhase('idle');
      throw e;
    } finally {
      this.busy = false;
    }
  }

  updateProgress(playedMs: number): void {
    if (!this.current) return;
    this.current.playedMs = Math.max(this.current.playedMs, playedMs);
    this.bus.emit('job:progress', { jobId: this.current.jobId, playedMs, positionMs: playedMs });
  }

  /** 播放完成提交；与放弃互斥，只有服务端明确确认才算成功。 */
  async submitFinish(input: FinishInput): Promise<'settled' | 'rejected' | 'error'> {
    const job = this.current;
    if (!job || this.phase !== 'playing' || input.jobId !== job.jobId) return 'error';
    this.setPhase('settling');
    try {
      const r = await this.deps.finish(input);
      if (r.status === 200 && r.payload?.ok !== false && !r.payload?.error
          && (r.payload?.ok === true || r.payload?.settled === true)) {
        this.bus.emit('job:settled', { jobId: job.jobId, credited: r.payload.credited !== false });
        return 'settled';
      }
      const code = r.error || r.payload?.error || `finish_http_${r.status}`;
      // 带上已播/目标秒数：409 job_not_active 这类服务端裁决必须能一眼看出播了多久
      const played = Math.round((Number(input.playedMs) || 0) / 1000);
      const target = Math.round(job.targetMs / 1000);
      this.deps.onSettleFailed(code, `结算未确认：${code}（已播 ${played}s / 目标 ${target}s）`);
      return r.status >= 400 && r.status < 500 ? 'rejected' : 'error';
    } catch {
      this.deps.onSettleFailed('finish_failed', '结算请求异常，未确认入账');
      return 'error';
    } finally {
      if (this.current === job) this.clear();
    }
  }

  /** 主动放弃：同一任务只发送一次，结算中不得同时取消。 */
  async abandon(reason: string, detail: string): Promise<void> {
    const job = this.current;
    if (!job || this.phase !== 'playing') return;
    this.setPhase('abandoning');
    try {
      await this.deps.abandon(reason, detail, job.jobId);
    } finally {
      if (this.current === job) this.clear();
    }
  }

  private clear(): void {
    this.current = null;
    this.setPhase('idle');
    this.bus.emit('job:current', null);
  }
}
