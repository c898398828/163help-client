/**
 * docker 主进程：Node 侧运行 core runtime；浏览器仅作播放器（Playwright）
 * 凭证：配置的 portal 客户端密钥（mh_ck_）作为存储 token（服务端 key 认证）
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
import { applyConfigPatch, type ConfigPatch } from './settings.ts';

const DATA_DIR = process.env.DATA_DIR || '/data';
const BASE = process.env.API_BASE || 'https://163music.linyu.qzz.io';
const VERSION = '5.1';

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** 配置持久化（cookie/key 由管理端写入） */
const cfg = {
  load(): Record<string, any> { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return {}; } },
  save(c: object): void { fs.writeFileSync(SESSION_FILE, JSON.stringify(c, null, 2)); }, // 写盘失败会抛出 → 管理端 500
};

const boot = cfg.load();
const state: Record<string, any> = {
  startedAt: Date.now(),
  helpUsed: 0, helpLimit: 9000,
  recv: 0, recvLimit: 26,
  jobsDone: 0,
  acctName: '',
  credits: 0,
  configured: Boolean(String(boot.neteaseCookie || '').trim() && String(boot.clientKey || '').trim()),
  browserReady: false,
  authStatus: '',
  lastApi: null as { ok: boolean; status: number; at: number } | null,
  lastApiWasOk: true,
  job: null as { musicName: string; playedMs: number; targetMs: number } | null,
  hbIntervals: [] as number[],
  lastEvent: '',
  logs: [] as Array<{ level: string; ts: number; msg: string }>,
};

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

/** 服务端版本闸门当前只放行 3.x/4.x（5.x 会被 403 client_upgrade_required 拒绝）；
 *  因此按协议等价版本上报，服务端放行 5.x 后可用 CLIENT_VERSION 环境变量改回。 */
const CLIENT_VERSION = process.env.CLIENT_VERSION || '4.0.21';

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

const api = createApi({
  base: BASE,
  version: CLIENT_VERSION,
  clientType: 'docker',
  getToken: () => storage.getToken(),
  extraHeaders: () => ({ 'X-Vip-Type': String(vipTypeCache) }),
  onResult: setLastApi,
});

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
      b.onDisconnect(() => {
        if (browser !== b) return; // 已被替换或主动关闭
        browser = null;
        state.browserReady = false;
        vipTypeCache = 0;
        pushLog('error', '浏览器已断开（崩溃或被杀），暂停任务后自动重连');
        void serializeLifecycle(async () => {
          // 排队期间配置可能已恢复新实例或清空；旧回调只清理旧浏览器，不暂停新任务。
          const ownsRecovery = !browser && state.configured;
          if (ownsRecovery) await runtime.suspend('browser_disconnected');
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
  if (!b) { vipTypeCache = 0; return empty; }
  const ident = await b.identity();
  if (browser !== b) return empty;
  vipTypeCache = Number.isFinite(ident.vipType) ? ident.vipType : 0;
  return ident;
}

let currentJobId: string | null = null;
let lastHeartbeatFailure = '';
const transport = createTransport({ api, getIdentity: refreshIdentity, onHeartbeatRejected: (failure) => {
  if (!currentJobId || failure.jobId !== currentJobId) return;
  const signature = `${failure.jobId}:${failure.status}:${failure.error}`;
  if (signature === lastHeartbeatFailure) return;
  lastHeartbeatFailure = signature;
  pushLog('warn', `心跳未获确认：${failure.error}（HTTP ${failure.status} / 任务 ${failure.jobId}）`);
} });

const player = {
  play: async (musicId: string, durationMs: number) => {
    if (!browser) return { ok: false, err: '浏览器未就绪' };
    try { return await browser.play(musicId, durationMs); }
    catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
  },
  stop: async () => { try { await browser?.stop(); } catch { /* 页面可能已关闭 */ } },
  onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number) => void) => {
    setInterval(async () => {
      const b = browser;
      const jobId = currentJobId;
      if (!b || !jobId) return;
      try {
        const p = await b.progress();
        if (browser === b && currentJobId === jobId && p.playedMs > 0) cb(p.playedMs, p.playedMs, p.durationMs);
      } catch { /* 页面繁忙或任务已切换 */ }
    }, 1000);
  },
};

const runtime = new ClientRuntime({ adapter: {
  clientType: 'docker', version: VERSION, storage,
  probeNetwork: async () => true, hasPage: false,
}, transport, player } as never);

runtime.bus.on('job:current', (j) => {
  const jobId = j?.jobId ?? null;
  if (jobId !== currentJobId) {
    state.hbIntervals = [];
    lastHeartbeatFailure = '';
  }
  currentJobId = jobId;
  state.job = j ? { musicName: j.musicName, playedMs: 0, targetMs: j.targetMs } : null;
});
runtime.bus.on('job:settled', (s) => { if (s.credited) state.jobsDone += 1; });
runtime.bus.on('job:progress', (p) => { if (state.job) state.job.playedMs = p.playedMs; });
runtime.bus.on('heartbeat:tick', (t) => {
  if (!currentJobId || t.jobId !== currentJobId) return;
  lastHeartbeatFailure = '';
  state.hbIntervals.push(t.intervalMs);
  if (state.hbIntervals.length > 30) state.hbIntervals.shift();
});
runtime.bus.on('auth:user', (u) => { state.acctName = u ? u.displayName : ''; state.credits = u ? u.credits : 0; });
runtime.bus.on('auth:status', (s) => {
  state.authStatus = s;
  if (s === 'logged_out') pushLog('warn', '凭证已失效（或密钥有误），请在「设置」重新填写');
});
runtime.bus.on('limits:updated', (s) => {
  state.helpUsed = s.helpedToday; state.helpLimit = s.helpedLimit;
  state.recv = s.receivedToday; state.recvLimit = s.receivedLimit;
});
runtime.bus.on('log:append', (e) => { pushLog(e.level, e.msg); });

/** 恢复任务前先刷新 VIP，保证首个 /me、/next 已带当前网易云账号等级。 */
async function startConfiguredRuntime(): Promise<void> {
  if (!state.configured) return;
  const b = browser;
  if (!b) throw new Error('浏览器未就绪，无法启动任务');
  await refreshIdentity();
  if (browser !== b) throw new Error('浏览器已断开，无法启动任务');
  await runtime.start(true);
  if (browser !== b) throw new Error('浏览器已断开，任务启动未完成');
}

async function recoverBrowser(): Promise<void> {
  await serializeLifecycle(async () => {
    if (!state.configured || browser) return;
    if (await launchBrowser()) await startConfiguredRuntime();
  }).catch((e) => pushLog('error', '浏览器恢复失败：' + String(e)));
}

/** 保存串行化：旧凭证任务排空 → 落盘 → 应用；应用失败必须让管理端返回错误。 */
state.onConfig = (patch: ConfigPatch) => serializeLifecycle(async () => {
  const cur = cfg.load();
  const oldCookie = String(cur.neteaseCookie || '');
  const oldKey = String(cur.clientKey || '');
  const result = applyConfigPatch(cur, patch);
  if (result.error) return result;
  const cookie = String(cur.neteaseCookie || '');
  const cookieChanged = cookie !== oldCookie;
  if (cookieChanged || String(cur.clientKey || '') !== oldKey || patch.clear === true) {
    await runtime.suspend('config_changed');
  }
  cfg.save(cur); // 写盘失败会抛出；此时旧任务已安全暂停，后续保存可重试
  state.configured = Boolean(cookie.trim() && String(cur.clientKey || '').trim());
  if (cookieChanged) vipTypeCache = 0;
  if (!state.configured) {
    state.acctName = ''; state.credits = 0; state.authStatus = 'logged_out';
  }
  try {
    if (!cookie) {
      const b = browser;
      browser = null;
      state.browserReady = false;
      if (b) await b.close();
    } else if (browser && cookieChanged) {
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
    await startConfiguredRuntime();
  } catch (e) {
    await runtime.suspend('config_apply_failed');
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
