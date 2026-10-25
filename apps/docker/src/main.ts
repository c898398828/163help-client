/**
 * docker 主进程：Node 侧运行 core runtime；浏览器仅作播放器（Playwright）
 * 凭证：配置的 portal 客户端密钥作为存储 token（服务端 key 认证）
 * 管理端：server.js（:3000 容器内，宿主映射 13000）
 * 启动顺序：先起管理端（浏览器/网络异常时也能进 UI 看日志、改配置）→ 再拉起浏览器与任务循环。
 * 配置流：管理页保存 → 旧任务排空 → session.json 落盘 → 应用变更（仅 Cookie 变化时重载；任一步失败均报错）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ClientRuntime } from '../../../packages/core/src/index.ts';
import { DockBrowser } from './browser.ts';
import { createApi } from './api.ts';
import { createTransport } from './transport.ts';
import { createStatusServer } from './server.ts';
import { applyConfigPatch, migrateLegacyConfig, normalizeServerUrl, type ConfigPatch, type ServerConfigItem, type SessionConfig } from './settings.ts';
import { MultiServerScheduler } from './scheduler.ts';
import { ServerWorker, type ServerRuntimeState } from './worker.ts';

const DATA_DIR = process.env.DATA_DIR || '/data';
const BASE = normalizeServerUrl(process.env.API_BASE || 'https://163music.linyu.qzz.io');
const VERSION = '5.1';
const CLIENT_VERSION = process.env.CLIENT_VERSION || '4.3.5';

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** 配置持久化（cookie/key 由管理端写入） */
const cfg = {
  load(): Record<string, any> { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return {}; } },
  save(c: object): void { fs.writeFileSync(SESSION_FILE, JSON.stringify(c, null, 2)); }, // 写盘失败会抛出 → 管理端 500
};

/** 环境变量合并注入与向前兼容迁移 */
function injectEnvConfig(cur: SessionConfig, defaultBase: string): boolean {
  let changed = false;
  if (!cur.clientKey && process.env.CLIENT_KEY?.trim()) {
    cur.clientKey = process.env.CLIENT_KEY.trim();
    changed = true;
  }
  migrateLegacyConfig(cur, defaultBase);
  if (!cur.servers) cur.servers = [];
  for (let i = 1; ; i++) {
    const url = process.env[`SERVER_${i}_URL`];
    const key = process.env[`SERVER_${i}_KEY`];
    const name = process.env[`SERVER_${i}_NAME`] || `服务端 ${i}`;
    if (!url && !key) break;
    if (url && key) {
      const normUrl = normalizeServerUrl(url);
      const sKey = key.trim();
      const existing = cur.servers.find((s) => s.baseUrl === normUrl || s.id === `env-${i}`);
      if (!existing) {
        cur.servers.push({
          id: `env-${i}`,
          name,
          baseUrl: normUrl,
          clientKey: sKey,
          enabled: true,
        });
        changed = true;
      }
    }
  }
  if (cur.servers.length > 0 && !cur.clientKey && cur.servers[0].clientKey) {
    cur.clientKey = cur.servers[0].clientKey;
  }
  return changed;
}

const boot = cfg.load();
if (injectEnvConfig(boot, BASE)) {
  cfg.save(boot);
}

function isConfigured(c: SessionConfig): boolean {
  const cookie = String(c.neteaseCookie || '').trim();
  const hasKey = Boolean(String(c.clientKey || '').trim());
  const hasServer = Boolean(c.servers?.some((s) => s.enabled && String(s.clientKey || '').trim()));
  return Boolean(cookie && (hasServer || hasKey));
}

const scheduler = new MultiServerScheduler();
const workers = new Map<string, ServerWorker>();

function getBeijingDateStr(ts = Date.now()): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

let lastBeijingDate = getBeijingDateStr();

const state: Record<string, any> = {
  startedAt: Date.now(),
  _helpUsed: 0,
  _helpLimit: 9000,
  _recv: 0,
  _recvLimit: 26,
  _jobsDone: 0,

  get helpUsed(): number {
    const list = Array.from(workers.values()).map((w) => w.getState()).filter((s) => s.enabled);
    if (!list.length) return this._helpUsed || 0;
    return list.reduce((sum, s) => sum + (s.helpUsed || 0), 0);
  },
  set helpUsed(v: number) { this._helpUsed = v; },

  get helpLimit(): number {
    const list = Array.from(workers.values()).map((w) => w.getState()).filter((s) => s.enabled);
    if (!list.length) return this._helpLimit ?? 9000;
    const sum = list.reduce((acc, s) => acc + (s.helpLimit != null && s.helpLimit > 0 ? s.helpLimit : 0), 0);
    return sum > 0 ? sum : (this._helpLimit ?? 9000);
  },
  set helpLimit(v: number) { this._helpLimit = v; },

  get recv(): number {
    const list = Array.from(workers.values()).map((w) => w.getState()).filter((s) => s.enabled);
    if (!list.length) return this._recv || 0;
    return list.reduce((sum, s) => sum + (s.recv || 0), 0);
  },
  set recv(v: number) { this._recv = v; },

  get recvLimit(): number {
    const list = Array.from(workers.values()).map((w) => w.getState()).filter((s) => s.enabled);
    if (!list.length) return this._recvLimit ?? 26;
    const sum = list.reduce((acc, s) => acc + (s.recvLimit != null && s.recvLimit > 0 ? s.recvLimit : 0), 0);
    return sum > 0 ? sum : (this._recvLimit ?? 26);
  },
  set recvLimit(v: number) { this._recvLimit = v; },

  get jobsDone(): number {
    const list = Array.from(workers.values()).map((w) => w.getState()).filter((s) => s.enabled);
    if (!list.length) return this._jobsDone || 0;
    return list.reduce((sum, s) => sum + (s.jobsDone || 0), 0);
  },
  set jobsDone(v: number) { this._jobsDone = v; },

  get beijingDate(): string {
    return getBeijingDateStr();
  },

  acctName: '',
  credits: 0,
  neteaseUser: null as { id: string; name: string; vipType: number } | null,
  configured: isConfigured(boot),
  browserReady: false,
  authStatus: '',
  lastApi: null as { ok: boolean; status: number; at: number } | null,
  lastApiWasOk: true,
  job: null as { musicName: string; playedMs: number; targetMs: number; serverId?: string; serverName?: string } | null,
  hbIntervals: [] as number[],
  lastEvent: '',
  logs: [] as Array<{ level: string; ts: number; msg: string }>,
  get servers(): ServerRuntimeState[] {
    return Array.from(workers.values()).map((w) => w.getState());
  },
};

// 每 30 秒巡检一次北京时间自然天跨天（00:00:00），跨天时自动重新向服务端拉取零点重置后的当日额度
setInterval(async () => {
  const today = getBeijingDateStr();
  if (today !== lastBeijingDate) {
    lastBeijingDate = today;
    pushLog('info', `[系统] 跨入北京时间新的一天（${today}），自动重新同步各渠道额度与统计`);
    for (const worker of workers.values()) {
      try {
        await worker.syncUser();
      } catch { /* 忽略瞬态网络异常 */ }
    }
  }
}, 30_000);

/** 写入管理端日志环（管理页可见）+ 标准输出（docker logs 可见） */
function pushLog(level: string, msg: string): void {
  state.logs.push({ level, ts: Date.now(), msg });
  if (state.logs.length > 200) state.logs.shift();
  state.lastEvent = msg;
  if (level === 'error') console.error('[main]', msg);
  else console.log('[main]', msg);
}

const storage = {
  getToken: () => String(cfg.load().clientKey || ''),
  setToken: (t: string) => { const c = cfg.load(); c.clientKey = t; cfg.save(c); },
  clearToken: () => {
    // key 模式：401 不清除已保存密钥（可能是服务端临时异常），仅提示；主循环会因 logged_out 停下
    pushLog('warn', '凭证校验未通过：密钥可能失效或服务端异常（已保留密钥，修正后重新保存即可）');
  },
  getExpires: () => 0,
  setExpires: () => {},
};

/** 记录最近一次服务端请求结果（状态条/诊断用）；状态由好变坏时记一条日志，避免刷屏。
 *  4xx 是服务端最终裁决（401 会停循环、409 表示任务已失效），不能写成「将持续重试」误导排查。 */
function setLastApi(r: { ok: boolean; status: number; at: number; error?: string }): void {
  const prev = state.lastApi as { ok: boolean; status: number } | null;
  const wasOk = state.lastApiWasOk;
  state.lastApi = { ok: r.ok, status: r.status, at: r.at };
  if (!r.ok && wasOk !== false) {
    if (r.status === 401) {
      pushLog('error', `凭证被服务端拒绝（401${r.error ? ' ' + r.error : ''}）：领单循环已停止，重新保存配置可恢复`);
    } else if (r.status === 403 && r.error === 'client_upgrade_required') {
      pushLog('error', `服务端要求升级客户端（403 client_upgrade_required）：上报版本 ${CLIENT_VERSION} 不被接受`);
    } else if (r.status === 0) {
      pushLog('warn', `服务端请求失败（网络不可达：${r.error || '未知原因'}），将持续重试`);
    } else if (r.status >= 400 && r.status < 500) {
      pushLog('warn', `服务端拒绝请求（${r.status}${r.error ? ' ' + r.error : ''}），不会自动重试`);
    } else {
      pushLog('warn', `服务端请求失败（${r.status}${r.error ? ' ' + r.error : ''}），将持续重试`);
    }
  }
  // 只有网络/5xx 类失败才算「连接断了」；4xx 之后成功请求不代表恢复连接
  const networkFailure = prev !== null && !prev.ok && (prev.status === 0 || prev.status >= 500);
  if (r.ok && wasOk === false && networkFailure) pushLog('info', '服务端连接已恢复');
  state.lastApiWasOk = r.ok;
}

/** 网易云会员等级（X-Vip-Type；服务端 /api/me、/api/next 消费）——由页内身份接口刷新 */
let vipTypeCache = 0;

let browser: DockBrowser | null = null;
let browserLaunch: Promise<boolean> | null = null;
let lifecycle: Promise<unknown> = Promise.resolve();

/** 配置保存、启动和断线恢复共用队列，旧任务排空之前不能切换凭证或播放器。 */
function serializeLifecycle<T>(action: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(action);
  lifecycle = next.catch(() => {}); // 单次失败不堵塞后续配置修复
  return next;
}

/** 拉起无头浏览器；并发调用复用同一次启动，失败时关闭半初始化实例。 */
async function launchBrowser(): Promise<boolean> {
  if (browserLaunch) return browserLaunch;
  if (browser) return true;
  const b = new DockBrowser(DATA_DIR, String(cfg.load().neteaseCookie || ''));
  browserLaunch = (async () => {
    try {
      await b.launch();
      browser = b;
      state.browserReady = true;
      scheduler.resume();
      b.onUnavailable((reason) => {
        if (browser !== b) return; // 已被替换或主动关闭
        browser = null;
        state.browserReady = false;
        vipTypeCache = 0;
        state.neteaseUser = null;
        scheduler.pause();
        pushLog('error', `浏览器已不可用（${reason}），暂停任务后自动重连`);
        void serializeLifecycle(async () => {
          // 排队期间配置可能已恢复新实例或清空；旧回调只清理旧浏览器，不暂停新任务。
          const ownsRecovery = !browser && state.configured;
          if (ownsRecovery) {
            for (const worker of workers.values()) {
              await worker.runtime.suspend('browser_disconnected');
            }
          }
          try { await b.close(); } catch { /* 已断开 */ }
          if (ownsRecovery && !browser && state.configured) {
            setTimeout(() => { void recoverBrowser(); }, 5000);
          }
        }).catch((e) => pushLog('error', '浏览器断线暂停失败：' + String(e)));
      });
      pushLog('info', '浏览器已就绪');
      return true;
    } catch (e) {
      try { await b.close(); } catch { /* 半初始化实例也必须释放 */ }
      browser = null;
      state.browserReady = false;
      pushLog('error', '浏览器启动失败：' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  })();
  try { return await browserLaunch; }
  finally { browserLaunch = null; }
}

/** 启动前和心跳时刷新身份；0 也是有效等级，不能沿用上一账号的 VIP。 */
async function refreshIdentity() {
  const b = browser;
  const empty = { id: '', name: '', vipType: 0 };
  if (!b) { vipTypeCache = 0; state.neteaseUser = null; return empty; }
  const ident = await b.identity();
  if (browser !== b) return empty;
  vipTypeCache = Number.isFinite(ident.vipType) ? ident.vipType : 0;
  if (ident.id || ident.name) {
    state.neteaseUser = { id: String(ident.id || ''), name: String(ident.name || ''), vipType: vipTypeCache };
  }
  return ident;
}

let currentJobId: string | null = null;
let lastHeartbeatFailure = '';

type ProgressCallback = (
  playedMs: number,
  positionMs: number,
  durationMs: number,
  observation?: import('../../../packages/core/src/types.ts').PlaybackObservation
) => void;

const progressListeners = new Set<ProgressCallback>();

setInterval(async () => {
  const b = browser;
  const jobId = currentJobId;
  if (!b || !jobId || progressListeners.size === 0) return;
  try {
    const p = await b.progress();
    if (browser === b && currentJobId === jobId && (p.playedMs > 0 || p.ended)) {
      for (const cb of progressListeners) {
        try {
          cb(p.playedMs, p.positionMs ?? p.playedMs, p.durationMs, { ...p.evidence, ended: p.ended });
        } catch { /* 忽略单个监听器内部异常 */ }
      }
    }
  } catch { /* 页面繁忙或任务已切换 */ }
}, 1000);

const player = {
  play: async (musicId: string, durationMs: number) => {
    if (!browser) return { ok: false, err: '浏览器未就绪' };
    try { return await browser.play(musicId, durationMs); }
    catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
  },
  stop: async () => { try { await browser?.stop(); } catch { /* 页面可能已关闭 */ } },
  onProgress: (cb: ProgressCallback) => {
    progressListeners.add(cb);
    return () => {
      progressListeners.delete(cb);
    };
  },
};

const defaultApi = createApi({
  base: BASE,
  version: CLIENT_VERSION,
  clientType: 'docker',
  getToken: () => storage.getToken(),
  extraHeaders: () => ({ 'X-Vip-Type': String(vipTypeCache) }),
  onResult: setLastApi,
});

function handleHeartbeatRejected(failure: { jobId: string; status: number; error: string }): void {
  if (!currentJobId || failure.jobId !== currentJobId) return;
  const signature = `${failure.jobId}:${failure.status}:${failure.error}`;
  if (signature === lastHeartbeatFailure) return;
  lastHeartbeatFailure = signature;
  const tag = `[${state.job?.serverName || '心跳'}]`;
  pushLog('warn', `${tag} 心跳未获确认：${failure.error}（HTTP ${failure.status} / 任务 ${failure.jobId}）`);
}

const defaultTransport = createTransport({
  api: defaultApi,
  getIdentity: refreshIdentity,
  onHeartbeatRejected: handleHeartbeatRejected,
});

let transport = defaultTransport;
let runtime: any = null;

function bindWorkerEvents(worker: ServerWorker): void {
  worker.runtime.bus.on('job:current', (j: any) => {
    const jobId = j?.jobId ?? null;
    if (jobId !== currentJobId) {
      state.hbIntervals = [];
      lastHeartbeatFailure = '';
    }
    currentJobId = jobId;
    state.job = j ? {
      musicName: j.musicName,
      playedMs: 0,
      targetMs: j.targetMs,
      serverId: worker.config.id,
      serverName: worker.config.name,
    } : null;
  });
  worker.runtime.bus.on('job:settled', (s: any) => { if (s?.credited) state.jobsDone += 1; });
  worker.runtime.bus.on('job:progress', (p: any) => {
    if (state.job && (!p?.jobId || p.jobId === currentJobId)) {
      state.job.playedMs = p.playedMs;
    }
  });
  worker.runtime.bus.on('heartbeat:tick', (t: any) => {
    if (!currentJobId || t.jobId !== currentJobId) return;
    lastHeartbeatFailure = '';
    state.hbIntervals.push(t.intervalMs);
    if (state.hbIntervals.length > 30) state.hbIntervals.shift();
  });
  worker.runtime.bus.on('auth:user', (u: any) => {
    state.acctName = u ? u.displayName : '';
    state.credits = u ? u.credits : 0;
  });
  worker.runtime.bus.on('auth:status', (s: string) => {
    state.authStatus = s;
    if (s === 'logged_out') pushLog('warn', '凭证已失效（或密钥有误），请在「设置」重新填写');
  });
  worker.runtime.bus.on('limits:updated', (s: any) => {
    state.helpUsed = s.helpedToday; state.helpLimit = s.helpedLimit;
    state.recv = s.receivedToday; state.recvLimit = s.receivedLimit;
  });
}

function createWorkerInstance(server: ServerConfigItem): ServerWorker {
  const w = new ServerWorker({
    config: server,
    scheduler,
    clientVersion: CLIENT_VERSION,
    getIdentity: refreshIdentity,
    player,
    pushLog,
    extraHeaders: () => ({ 'X-Vip-Type': String(vipTypeCache) }),
    onHeartbeatRejected: handleHeartbeatRejected,
  });
  bindWorkerEvents(w);
  return w;
}

function reconcileWorkers(cur: SessionConfig): void {
  const currentServers = cur.servers || [];
  const nextIds = new Set(currentServers.map((s) => s.id));

  // 1. 停止并移除已不在列表中的 Worker
  for (const [id, worker] of workers.entries()) {
    if (!nextIds.has(id)) {
      void worker.stop().catch(() => {});
      workers.delete(id);
    }
  }

  // 2. 更新或新建 Worker
  for (const server of currentServers) {
    const existing = workers.get(server.id);
    if (existing) {
      if (existing.config.baseUrl !== server.baseUrl) {
        // baseUrl 变化导致底层 API 实例需重置，注销旧 Worker 并新建
        void existing.stop().catch(() => {});
        const w = createWorkerInstance(server);
        workers.set(server.id, w);
      } else {
        existing.config.name = server.name;
        existing.config.clientKey = server.clientKey;
        existing.config.enabled = server.enabled;
      }
    } else {
      const w = createWorkerInstance(server);
      workers.set(server.id, w);
    }
  }

  // 3. 维护 primary worker 引用（供原有单元测试及向后兼容）
  const primary = (currentServers[0] && workers.get(currentServers[0].id)) || workers.values().next().value;
  if (primary) {
    runtime = primary.runtime;
    transport = (primary as any).transport || transport;
  } else if (!runtime) {
    runtime = new ClientRuntime({
      adapter: {
        clientType: 'docker',
        version: VERSION,
        storage,
        probeNetwork: async () => true,
        hasPage: false,
      },
      transport,
      player,
    } as never);
  }
}

// 启动初始 Worker 映射
reconcileWorkers(boot);

/** 恢复任务前先刷新 VIP，保证首个 /me、/next 已带当前网易云账号等级。 */
async function startConfiguredWorkers(): Promise<void> {
  if (!state.configured) return;
  const b = browser;
  if (!b) throw new Error('浏览器未就绪，无法启动任务');
  await refreshIdentity();
  if (browser !== b) throw new Error('浏览器已断开，无法启动任务');
  const startPromises: Promise<void>[] = [];
  for (const worker of workers.values()) {
    if (worker.config.enabled && worker.config.clientKey.trim()) {
      startPromises.push(worker.start());
    }
  }
  await Promise.all(startPromises);
  if (browser !== b) throw new Error('浏览器已断开，任务启动未完成');
}

const startConfiguredRuntime = startConfiguredWorkers;

async function recoverBrowser(): Promise<void> {
  await serializeLifecycle(async () => {
    if (!state.configured || browser?.isUsable()) return;
    if (browser) {
      const dead = browser;
      browser = null;
      state.browserReady = false;
      vipTypeCache = 0;
      state.neteaseUser = null;
      pushLog('warn', '浏览器实例已不可用，重建中');
      try { await dead.close(); } catch { /* 已不可用 */ }
    }
    if (await launchBrowser()) await startConfiguredWorkers();
  }).catch((e) => pushLog('error', '浏览器恢复失败：' + String(e)));
}

/** 保存串行化：旧凭证任务排空 → 落盘 → 应用；应用失败必须让管理端返回错误。 */
state.onConfig = (patch: ConfigPatch) => serializeLifecycle(async () => {
  const cur = cfg.load();
  injectEnvConfig(cur, BASE);
  const oldCookie = String(cur.neteaseCookie || '');
  const oldKey = String(cur.clientKey || '');
  const oldServersJson = JSON.stringify(cur.servers || []);
  const result = applyConfigPatch(cur, patch, BASE);
  if (result.error) return result;

  const cookie = String(cur.neteaseCookie || '');
  const cookieChanged = cookie !== oldCookie;
  const serversChanged = JSON.stringify(cur.servers || []) !== oldServersJson;
  const keyChanged = String(cur.clientKey || '') !== oldKey;

  if (cookieChanged || keyChanged || serversChanged || patch.clear === true) {
    for (const worker of workers.values()) {
      await worker.runtime.suspend('config_changed');
    }
  }

  cfg.save(cur); // 写盘失败会抛出；此时旧任务已安全暂停，后续保存可重试
  state.configured = isConfigured(cur);
  if (cookieChanged) {
    vipTypeCache = 0;
    state.neteaseUser = null;
  }
  if (!state.configured) {
    state.acctName = ''; state.credits = 0; state.authStatus = 'logged_out';
  }

  try {
    if (!cookie) {
      const b = browser;
      browser = null;
      state.browserReady = false;
      if (b) await b.close();
      for (const worker of workers.values()) {
        await worker.stop();
      }
      workers.clear();
    } else {
      if (browser && cookieChanged) {
        const b = browser;
        try { await b.setCookie(cookie); }
        catch (e) {
          browser = null;
          state.browserReady = false;
          try { await b.close(); } catch { /* 不保留半更新的登录态 */ }
          throw e;
        }
      } else if (!browser && !(await launchBrowser())) {
        throw new Error('浏览器启动失败，配置尚未应用');
      }
      reconcileWorkers(cur);
      await startConfiguredWorkers();
    }
  } catch (e) {
    for (const worker of workers.values()) {
      await worker.runtime.suspend('config_apply_failed');
    }
    pushLog('error', '配置应用失败：' + String(e));
    throw e;
  }

  pushLog('info', '配置已保存' + (result.saved.length ? '：' + result.saved.join('/') : '（无变化）'));
  return result;
});

async function main() {
  // 先起管理端：浏览器/网络异常时仍能进 UI 看日志、改配置；STATIC_DIR 可覆盖背景图目录
  createStatusServer({ port: Number(process.env.PORT || 3000), state, staticDir: process.env.STATIC_DIR });
  console.log('[main] 管理端 http://0.0.0.0:3000');

  await recoverBrowser();

  // 浏览器缺失且仍已配置时后台重试；与配置保存、断线暂停串行。
  setInterval(() => { void recoverBrowser(); }, 60_000);
}

main().catch((e) => { console.error('[main] fatal', e); process.exit(1); });
