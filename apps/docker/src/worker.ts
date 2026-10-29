import { ClientRuntime } from '../../../packages/core/src/index.ts';
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
  helpLimit: number | null;
  recv: number;
  recvLimit: number | null;
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
    onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number, observation?: any) => void) => (() => void) | void;
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
  private clientVersion: string;
  private currentReleaseTurn: (() => void) | null = null;
  private unregisterProgress: (() => void) | null = null;

  constructor(deps: WorkerDeps) {
    this.config = deps.config;
    this.scheduler = deps.scheduler;
    this.pushLog = deps.pushLog;
    this.clientVersion = deps.clientVersion || '4.6.11';

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
      helpLimit: null,
      recv: 0,
      recvLimit: null,
      jobsDone: 0,
      lastApi: null,
      cooldownUntil: 0,
    };

    const setLastApi = (r: { ok: boolean; status: number; at: number; error?: string }) => {
      this.state.lastApi = { ok: r.ok, status: r.status, at: r.at, error: r.error };
      if (!r.ok) {
        if (r.status === 401) {
          this.pushLog('error', `[${this.config.name}] 凭证被拒绝 (401)，已停止本服领单`);
        } else if (r.status === 403) {
          if (r.error === 'client_upgrade_required') {
            this.pushLog('error', `[${this.config.name}] 服务端要求升级客户端（403 client_upgrade_required），尝试自动探测版本`);
            void this.probeServerVersion();
          } else {
            this.pushLog('warn', `[${this.config.name}] 服务端拒绝请求（403 ${r.error || '无权限'}）`);
          }
        } else if (r.status === 0) {
          this.pushLog('warn', `[${this.config.name}] 网络不可达 (${r.error || '超时'})`);
        }
      }
    };

    const api = createApi({
      base: deps.config.baseUrl,
      version: () => this.clientVersion,
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
      me: async () => {
        const res = await transport.me();
        if (res.status === 200 && res.payload) {
          this.updateLimitsAndAccount(res.payload);
        }
        return res;
      },
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
          if (res.status === 200 && res.payload) {
            this.updateLimitsAndAccount(res.payload);
          }
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
          const res = await transport.finish(token, input);
          if (res.status === 200 && res.payload) {
            this.updateLimitsAndAccount(res.payload);
          }
          return res;
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

    const wrappedPlayer = {
      ...deps.player,
      onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number, observation?: any) => void) => {
        const unregister = deps.player.onProgress(cb);
        if (typeof unregister === 'function') {
          this.unregisterProgress = unregister;
        }
        return unregister;
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
      player: wrappedPlayer,
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

  updateLimitsAndAccount(data: any): void {
    if (!data || typeof data !== 'object') return;
    const pt = data.participant ?? data;
    const hLimit = pt.help_seconds_limit ?? pt.effective_help_seconds_limit ?? pt.today_helped_limit ?? pt.effectiveHelpSecondsLimit ?? data.helpedLimit;
    const rLimit = pt.today_received_limit ?? pt.received_limit ?? pt.receivedLimit ?? data.receivedLimit;
    const hUsed = pt.help_seconds_used ?? pt.today_helped_seconds ?? pt.today_helped_count ?? pt.todayHelpedSeconds ?? data.helpedToday;
    const rUsed = pt.received_finished_count_24h ?? pt.today_received_help_count ?? pt.received_today ?? pt.receivedToday ?? data.receivedToday;
    const cred = pt.available_credits ?? pt.availableCredits ?? pt.credits ?? data.credits;
    const name = data.user?.displayName || pt.user?.displayName || data.displayName;

    if (typeof hLimit === 'number' && Number.isFinite(hLimit) && hLimit > 0) this.state.helpLimit = hLimit;
    if (typeof rLimit === 'number' && Number.isFinite(rLimit) && rLimit > 0) this.state.recvLimit = rLimit;
    if (typeof hUsed === 'number' && Number.isFinite(hUsed)) this.state.helpUsed = hUsed;
    if (typeof rUsed === 'number' && Number.isFinite(rUsed)) this.state.recv = rUsed;
    if (typeof cred === 'number' && Number.isFinite(cred)) this.state.credits = cred;
    if (typeof name === 'string' && name.trim()) this.state.acctName = name.trim();
  }

  private releaseCurrentTurn(): void {
    if (this.currentReleaseTurn) {
      const rel = this.currentReleaseTurn;
      this.currentReleaseTurn = null;
      rel();
    }
  }

  async probeServerVersion(): Promise<void> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/client-version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const d = (await res.json()) as any;
        const target = typeof d?.minVersion === 'string' && d.minVersion.trim()
          ? d.minVersion.trim()
          : (typeof d?.version === 'string' && d.version.trim() ? d.version.trim() : '');
        if (target && target !== this.clientVersion) {
          const prev = this.clientVersion;
          this.clientVersion = target;
          this.pushLog('info', `[${this.config.name}] 成功探测服务端版本，已自适应上报版本：${prev} → ${this.clientVersion}`);
        }
      }
    } catch { /* 忽略探测失败 */ }
  }

  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.clientKey.trim()) return;
    try {
      await Promise.race([
        this.probeServerVersion(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch { /* 忽略预探测超时或异常 */ }
    await this.runtime.start(true);
  }

  async stop(): Promise<void> {
    if (this.unregisterProgress) {
      this.unregisterProgress();
      this.unregisterProgress = null;
    }
    this.releaseCurrentTurn();
    this.scheduler.unregisterServer(this.config.id);
    await this.runtime.suspend('worker_stopped');
  }

  getState(): ServerRuntimeState {
    this.state.name = this.config.name;
    this.state.baseUrl = this.config.baseUrl;
    this.state.enabled = this.config.enabled;
    this.state.configured = Boolean(this.config.clientKey.trim());
    this.state.cooldownUntil = this.scheduler.getCooldownUntil(this.config.id);
    return { ...this.state };
  }
}
