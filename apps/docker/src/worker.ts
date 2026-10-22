import { ClientRuntime } from '../../../packages/core/dist/index.js';
import type { ServerConfigItem } from './settings.ts';
import { createApi } from './api.ts';
import { createTransport } from './transport.ts';
import { MultiServerScheduler } from './scheduler.ts';

export interface ServerRuntimeState {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  configured: boolean;
  authStatus: string;
  acctName: string;
  credits: number;
  helpUsed: number;
  helpLimit: number;
  recv: number;
  recvLimit: number;
  jobsDone: number;
  lastApi: { ok: boolean; status: number; at: number; error?: string } | null;
  cooldownUntil: number;
}

export interface WorkerDeps {
  config: ServerConfigItem;
  scheduler: MultiServerScheduler;
  clientVersion: string;
  getIdentity: () => Promise<{ id: string; name: string; vipType: number }>;
  player: {
    play: (musicId: string, durationMs: number, ownerName: string) => Promise<any>;
    stop: () => Promise<void> | void;
    onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number) => void) => void;
  };
  pushLog: (level: string, msg: string) => void;
  extraHeaders?: () => Record<string, string>;
  onHeartbeatRejected?: (failure: { jobId: string; status: number; error: string }) => void;
}

export class ServerWorker {
  readonly config: ServerConfigItem;
  readonly runtime: ClientRuntime;
  readonly transport: any;
  private scheduler: MultiServerScheduler;
  private pushLog: (level: string, msg: string) => void;
  private state: ServerRuntimeState;
  private currentReleaseTurn: (() => void) | null = null;

  constructor(deps: WorkerDeps) {
    this.config = deps.config;
    this.scheduler = deps.scheduler;
    this.pushLog = deps.pushLog;

    this.state = {
      id: deps.config.id,
      name: deps.config.name,
      baseUrl: deps.config.baseUrl,
      enabled: deps.config.enabled,
      configured: Boolean(deps.config.clientKey.trim()),
      authStatus: '',
      acctName: '',
      credits: 0,
      helpUsed: 0,
      helpLimit: 9000,
      recv: 0,
      recvLimit: 26,
      jobsDone: 0,
      lastApi: null,
      cooldownUntil: 0,
    };

    const setLastApi = (r: { ok: boolean; status: number; at: number; error?: string }) => {
      this.state.lastApi = { ok: r.ok, status: r.status, at: r.at, error: r.error };
      if (!r.ok) {
        if (r.status === 401) {
          this.pushLog('error', `[${this.config.name}] 凭证被拒绝 (401)，已停止本服领单`);
        } else if (r.status === 0) {
          this.pushLog('warn', `[${this.config.name}] 网络不可达 (${r.error || '超时'})`);
        }
      }
    };

    const api = createApi({
      base: deps.config.baseUrl,
      version: deps.clientVersion,
      clientType: 'docker',
      getToken: () => this.config.clientKey,
      extraHeaders: deps.extraHeaders ?? (() => ({})),
      onResult: setLastApi,
    });

    const transport = createTransport({
      api,
      getIdentity: deps.getIdentity,
      onHeartbeatRejected: (f) => {
        if (deps.onHeartbeatRejected) {
          deps.onHeartbeatRejected(f);
        } else {
          this.pushLog('warn', `[${this.config.name}] 心跳未获确认：${f.error}（任务 ${f.jobId}）`);
        }
      },
    });

    const gatedTransport = {
      ...transport,
      next: async (token: string) => {
        if (!this.config.enabled) {
          return { status: 200, payload: { musicId: null, noTargetReason: 'server_disabled' } };
        }
        const releaseTurn = await this.scheduler.acquireTurn(this.config.id);
        if (!releaseTurn) {
          return { status: 200, payload: { musicId: null, noTargetReason: 'scheduler_paused' } };
        }
        this.releaseCurrentTurn();
        this.currentReleaseTurn = releaseTurn;
        try {
          const res = await transport.next(token);
          if (!res.payload || !res.payload.jobId || !res.payload.musicId) {
            // 无单或失败，立即让出播放权
            if (res.payload?.noTargetReason) {
              this.scheduler.setCooldown(this.config.id);
              this.state.cooldownUntil = this.scheduler.getCooldownUntil(this.config.id);
            }
            this.releaseCurrentTurn();
          }
          return res;
        } catch (e) {
          this.releaseCurrentTurn();
          throw e;
        }
      },
      finish: async (token: string, input: any) => {
        try {
          return await transport.finish(token, input);
        } finally {
          this.releaseCurrentTurn();
        }
      },
      abandon: async (token: string, r: string, d: string, jobId?: string) => {
        try {
          await transport.abandon(token, r, d, jobId);
        } finally {
          this.releaseCurrentTurn();
        }
      },
    };

    this.runtime = new ClientRuntime({
      adapter: {
        clientType: 'docker',
        version: deps.clientVersion,
        storage: {
          getToken: () => this.config.clientKey,
          setToken: () => {},
          clearToken: () => {},
          getExpires: () => 0,
          setExpires: () => {},
        },
        probeNetwork: async () => true,
        hasPage: false,
      },
      transport: gatedTransport,
      player: deps.player,
    } as any);

    this.transport = gatedTransport;

    this.scheduler.registerServer(this.config.id, () => ({
      enabled: this.config.enabled,
      eligible: Boolean(this.config.clientKey.trim()) && this.state.authStatus !== 'logged_out',
    }));

    this.runtime.bus.on('job:settled', (s: any) => { if (s?.credited) this.state.jobsDone++; });
    this.runtime.bus.on('auth:user', (u: any) => {
      this.state.acctName = u?.displayName || '';
      this.state.credits = u?.credits || 0;
    });
    this.runtime.bus.on('auth:status', (s: string) => { this.state.authStatus = s; });
    this.runtime.bus.on('limits:updated', (s: any) => {
      this.state.helpUsed = s?.helpedToday || 0;
      this.state.helpLimit = s?.helpedLimit || 9000;
      this.state.recv = s?.receivedToday || 0;
      this.state.recvLimit = s?.receivedLimit || 26;
    });
    this.runtime.bus.on('log:append', (e: any) => {
      this.pushLog(e.level, `[${this.config.name}] ${e.msg}`);
    });
  }

  private releaseCurrentTurn(): void {
    if (this.currentReleaseTurn) {
      const rel = this.currentReleaseTurn;
      this.currentReleaseTurn = null;
      rel();
    }
  }

  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.clientKey.trim()) return;
    await this.runtime.start(true);
  }

  async stop(): Promise<void> {
    this.releaseCurrentTurn();
    this.scheduler.unregisterServer(this.config.id);
    await this.runtime.suspend('worker_stopped');
  }

  getState(): ServerRuntimeState {
    this.state.cooldownUntil = this.scheduler.getCooldownUntil(this.config.id);
    return { ...this.state };
  }
}
