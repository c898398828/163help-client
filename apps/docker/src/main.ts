/**
 * docker 主进程：Node 侧运行 core runtime；浏览器仅作播放器（Playwright）
 * 凭证：配置的 portal 客户端密钥（mh_ck_）作为存储 token（服务端 key 认证）
 * 管理端：server.js（:3000 容器内，宿主映射 13000）
 * 启动顺序：先起管理端（浏览器/网络异常时也能进 UI 看日志、改配置）→ 再拉起浏览器与任务循环。
 * 配置流：管理页保存 → session.json 落盘（失败即报错，不假报成功）→ 立即应用（Cookie 重载页面 / 启动任务循环）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ClientRuntime } from '../../../packages/core/src/index.ts';
import { DockBrowser } from './browser.ts';
import { createApi } from './api.ts';
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

/** 记录最近一次服务端请求结果（状态条/诊断用）；状态由好变坏时记一条日志，避免刷屏 */
function setLastApi(r: { ok: boolean; status: number; at: number; error?: string }): void {
  state.lastApi = { ok: r.ok, status: r.status, at: r.at };
  if (!r.ok && state.lastApiWasOk !== false) {
    if (r.status === 403 && r.error === 'client_upgrade_required') {
      pushLog('error', `服务端要求升级客户端（403 client_upgrade_required）：上报版本 ${CLIENT_VERSION} 不被接受`);
    } else if (r.status === 0) {
      pushLog('warn', `服务端请求失败（网络不可达：${r.error || '未知原因'}），将持续重试`);
    } else {
      pushLog('warn', `服务端请求失败（${r.status}${r.error ? ' ' + r.error : ''}），将持续重试`);
    }
  }
  state.lastApiWasOk = r.ok;
}

const api = createApi({
  base: BASE,
  version: CLIENT_VERSION,
  clientType: 'docker',
  getToken: () => storage.getToken(),
  onResult: setLastApi,
});

let browser: DockBrowser | null = null;

/** 拉起无头浏览器；失败不致命（管理端继续可用，后台定时重试） */
async function launchBrowser(): Promise<boolean> {
  try {
    if (browser) { try { await browser.close(); } catch { /* 旧实例已失效 */ } }
    const b = new DockBrowser(DATA_DIR, String(cfg.load().neteaseCookie || ''));
    await b.launch();
    browser = b;
    state.browserReady = true;
    b.onDisconnect(() => {
      if (browser !== b) return; // 已被新实例替换
      browser = null;
      state.browserReady = false;
      pushLog('error', '浏览器已断开（崩溃或被杀），5 秒后自动重连');
      setTimeout(() => { if (!browser) void launchBrowser(); }, 5000);
    });
    pushLog('info', '浏览器已就绪');
    return true;
  } catch (e) {
    browser = null;
    state.browserReady = false;
    pushLog('error', '浏览器启动失败：' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

const transport = {
  next: async (token: string) => api('POST', '/api/next', {}, token),
  finish: async (token: string, input: unknown) => api('POST', '/api/play/finish', input, token),
  abandon: async (token: string, reason: string, detail: string) => { await api('POST', '/api/play/abandon', { reason, detail }, token); },
  heartbeat: async (token: string, input: unknown) => (await api('POST', '/api/play/heartbeat', input, token)).status === 200,
  refresh: async () => null, // key 凭证不走 session refresh
  canRefresh: false, // 401 直接停循环（保留已保存密钥），不做刷新重试
  me: () => api('GET', '/api/me'),
  sendLog: async (p: unknown) => { await api('POST', '/api/client/log', p); },
};

const player = {
  play: async (musicId: string, durationMs: number) => {
    if (!browser) return false;
    try { return await browser.play(musicId, durationMs); } catch { return false; }
  },
  stop: () => { try { void browser?.stop(); } catch { /* 页面可能已关闭 */ } },
  onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number) => void) => {
    setInterval(async () => {
      if (!browser) return;
      try { const p = await browser.progress(); if (p.playedMs > 0) cb(p.playedMs, p.playedMs, p.durationMs); } catch { /* 页面繁忙 */ }
    }, 1000);
  },
};

const runtime = new ClientRuntime({ adapter: {
  clientType: 'docker', version: VERSION, storage,
  probeNetwork: async () => true, hasPage: false,
}, transport, player } as never);

runtime.bus.on('job:current', (j) => {
  if (j) { state.job = { musicName: j.musicName, playedMs: 0, targetMs: j.targetMs }; }
  else { if (state.job) state.jobsDone += 1; state.job = null; }
});
runtime.bus.on('job:progress', (p) => { if (state.job) state.job.playedMs = p.playedMs; });
runtime.bus.on('heartbeat:tick', (t) => { state.hbIntervals.push(t.intervalMs); if (state.hbIntervals.length > 30) state.hbIntervals.shift(); });
runtime.bus.on('auth:user', (u) => { state.acctName = u ? u.displayName : ''; });
runtime.bus.on('auth:status', (s) => {
  state.authStatus = s;
  if (s === 'logged_out') pushLog('warn', '凭证已失效（或密钥有误），请在「设置」重新填写');
});
runtime.bus.on('limits:updated', (s) => {
  state.helpUsed = s.helpedToday; state.helpLimit = s.helpedLimit;
  state.recv = s.receivedToday; state.recvLimit = s.receivedLimit;
});
runtime.bus.on('log:append', (e) => { pushLog(e.level, e.msg); });

/** 管理端保存配置：落盘 → 立即应用（Cookie 重载页面；密钥就绪则启动任务循环） */
state.onConfig = async (patch: ConfigPatch) => {
  const cur = cfg.load();
  const result = applyConfigPatch(cur, patch);
  if (result.error) return result;
  cfg.save(cur); // 写盘失败会抛出 → 管理端返回 500
  state.configured = Boolean(String(cur.neteaseCookie || '').trim() && String(cur.clientKey || '').trim());
  if (browser) {
    try { await browser.setCookie(String(cur.neteaseCookie || '')); }
    catch (e) { pushLog('warn', 'Cookie 应用失败（下次启动生效）：' + (e instanceof Error ? e.message : String(e))); }
  } else if (cur.neteaseCookie) {
    await launchBrowser();
  }
  if (state.configured && browser) void runtime.start(true);
  pushLog('info', '配置已保存' + (result.saved.length ? '：' + result.saved.join('/') : '（无变化）'));
  return result;
};

async function main() {
  // 先起管理端：浏览器/网络异常时仍能进 UI 看日志、改配置
  createStatusServer({ port: Number(process.env.PORT || 3000), state });
  console.log('[main] 管理端 http://0.0.0.0:3000');

  if (await launchBrowser()) void runtime.start(true);

  // 浏览器缺失时后台重试（VPS 冷启动网络未就绪、崩溃后自愈）
  setInterval(async () => {
    if (browser) return;
    if (await launchBrowser()) void runtime.start(true);
  }, 60_000);
}

main().catch((e) => { console.error('[main] fatal', e); process.exit(1); });
