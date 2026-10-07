import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { applyConfigPatch } from '../src/settings.ts';
import { createTransport } from '../src/transport.ts';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?$/gm, '');
const initialConfig = { clientKey: 'mh_ck_old', neteaseCookie: 'MUSIC_U=old' };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

interface Hooks {
  config?: Record<string, unknown>;
  launch?: () => Promise<void>;
  suspend?: () => Promise<void>;
  setCookie?: () => Promise<void>;
  stop?: () => Promise<void>;
  progress?: () => Promise<{ playedMs: number; durationMs: number }>;
  start?: () => Promise<void>;
  save?: () => void;
  vipType?: number;
}

/** 执行真实 main 源码，只替换外部 I/O；不导入 Playwright，也不启动服务器或真实定时器。 */
async function boot(hooks: Hooks = {}) {
  let saved: Record<string, unknown> = { ...(hooks.config ?? initialConfig) };
  const events: string[] = [];
  const requests: Array<{ path: string; token: string; vipType: string }> = [];
  const browsers: FakeBrowser[] = [];
  const timers: Array<{ callback: () => unknown; ms: number; interval: boolean; cancelled: boolean }> = [];
  const timer = (callback: () => unknown, ms: number, interval: boolean) => {
    const t = { callback, ms, interval, cancelled: false };
    timers.push(t);
    return t;
  };
  class FakeBrowser {
    cookie: string;
    closed = false;
    cookieChanges: string[] = [];
    disconnected: Array<() => void> = [];
    constructor(_dir: string, cookie: string) { this.cookie = cookie; browsers.push(this); }
    async launch() { events.push(`launch:${this.cookie}`); await hooks.launch?.(); }
    async close() { this.closed = true; events.push('close'); this.disconnect(); }
    onDisconnect(cb: () => void) { this.disconnected.push(cb); }
    disconnect() { for (const cb of this.disconnected) cb(); }
    async setCookie(cookie: string) {
      this.cookieChanges.push(cookie);
      events.push(`cookie:${cookie}`);
      await hooks.setCookie?.();
      this.cookie = cookie;
    }
    async identity() {
      events.push(`identity:${this.cookie}`);
      return { id: '123', name: 'test', vipType: hooks.vipType ?? 11 };
    }
    async stop() { events.push('player:stop'); await hooks.stop?.(); events.push('player:stopped'); }
    async play() { return true; }
    async progress() { return hooks.progress ? hooks.progress() : { playedMs: 0, durationMs: 0 }; }
  }
  class FakeRuntime {
    starts = 0;
    progressSamples: number[] = [];
    suspends: Array<{ reason: string; token: string }> = [];
    deps: any;
    handlers = new Map<string, Array<(payload: any) => void>>();
    bus = {
      on: (event: string, fn: (payload: any) => void) => {
        const listeners = this.handlers.get(event) ?? [];
        listeners.push(fn);
        this.handlers.set(event, listeners);
      },
      emit: (event: string, payload: any) => { for (const fn of this.handlers.get(event) ?? []) fn(payload); },
    };
    constructor(deps: any) { this.deps = deps; deps.player.onProgress((playedMs: number) => this.progressSamples.push(playedMs)); }
    async start(autostart: boolean) {
      assert.equal(autostart, true);
      this.starts += 1;
      events.push(`start:${this.deps.adapter.storage.getToken()}`);
      await hooks.start?.();
      await this.deps.transport.me();
      await this.deps.transport.next(this.deps.adapter.storage.getToken());
    }
    async suspend(reason: string) {
      const token = this.deps.adapter.storage.getToken();
      this.suspends.push({ reason, token });
      events.push(`suspend:${token}`);
      await hooks.suspend?.();
      await this.deps.player.stop();
      this.bus.emit('job:current', null);
      events.push(`drained:${token}`);
    }
  }
  const context = vm.createContext({
    fs: {
      mkdirSync() {},
      readFileSync: () => JSON.stringify(saved),
      writeFileSync: (_file: string, data: string) => {
        hooks.save?.();
        saved = JSON.parse(data);
        events.push(`save:${saved.clientKey ?? ''}`);
      },
    },
    path, ClientRuntime: FakeRuntime, DockBrowser: FakeBrowser, applyConfigPatch, createTransport,
    createApi: (deps: any) => async (_method: string, url: string, _body?: unknown, token = deps.getToken()) => {
      requests.push({ path: url, token, vipType: deps.extraHeaders()['X-Vip-Type'] });
      return { status: 200, payload: {} };
    },
    createStatusServer: () => { events.push('server:start'); },
    process: { env: { DATA_DIR: '/test-data', API_BASE: 'http://localhost' }, exit: (code: number) => events.push(`exit:${code}`) },
    console: { log() {}, error() {} },
    setTimeout: (cb: () => unknown, ms: number) => timer(cb, ms, false),
    setInterval: (cb: () => unknown, ms: number) => timer(cb, ms, true),
    clearTimeout: (t: { cancelled: boolean }) => { t.cancelled = true; },
    clearInterval: (t: { cancelled: boolean }) => { t.cancelled = true; },
  });
  vm.runInContext(source + '\n;globalThis.app = { state, runtime, launchBrowser, transport, player };', context);
  await flush();
  const app = (context as any).app as { state: any; runtime: FakeRuntime; launchBrowser: () => Promise<boolean>; transport: ReturnType<typeof createTransport>; player: any };
  return {
    ...app, browsers, events, requests, timers,
    config: () => ({ ...saved }),
    async fire(ms: number) {
      const pending = timers.filter((t) => t.ms === ms && !t.cancelled);
      for (const t of pending) {
        if (!t.interval) t.cancelled = true;
        await t.callback();
      }
      await flush();
    },
  };
}

test('jobsDone 只计入 credited 的 job:settled，不把放弃或清空当作成功', async () => {
  const app = await boot();
  app.runtime.bus.emit('job:current', { jobId: 'a', musicName: 'song', targetMs: 1000 });
  app.runtime.bus.emit('job:current', null);
  assert.equal(app.state.jobsDone, 0);
  app.runtime.bus.emit('job:settled', { jobId: 'a', credited: false });
  assert.equal(app.state.jobsDone, 0);
  app.runtime.bus.emit('job:settled', { jobId: 'b', credited: true });
  assert.equal(app.state.jobsDone, 1);
});

test('切换任务清空心跳样本，旧任务的迟到心跳不得污染新任务', async () => {
  const app = await boot();
  app.runtime.bus.emit('job:current', { jobId: 'a', musicName: 'one', targetMs: 1000 });
  app.runtime.bus.emit('heartbeat:tick', { jobId: 'a', intervalMs: 10000 });
  assert.equal(app.state.hbIntervals.length, 1);
  app.runtime.bus.emit('job:current', { jobId: 'b', musicName: 'two', targetMs: 1000 });
  assert.equal(app.state.hbIntervals.length, 0);
  app.runtime.bus.emit('heartbeat:tick', { jobId: 'a', intervalMs: 20000 });
  assert.equal(app.state.hbIntervals.length, 0);
  app.runtime.bus.emit('heartbeat:tick', { jobId: 'b', intervalMs: 9000 });
  app.runtime.bus.emit('job:current', null);
  assert.equal(app.state.hbIntervals.length, 0);
});

test('旧任务的异步进度读取不得回填到新任务', async () => {
  const gate = deferred();
  const hooks: Hooks = { progress: async () => { await gate.promise; return { playedMs: 10000, durationMs: 30000 }; } };
  const app = await boot(hooks);
  app.runtime.bus.emit('job:current', { jobId: 'a', musicName: 'old', targetMs: 1000 });
  const poll = app.fire(1000);
  await flush();
  app.runtime.bus.emit('job:current', { jobId: 'b', musicName: 'new', targetMs: 1000 });
  gate.resolve();
  await poll;
  assert.equal(app.runtime.progressSamples.length, 0);
});

test('清空配置先等待旧凭证的 suspend 完成，再落盘，且不重新启动任务', async () => {
  const gate = deferred();
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.suspend = () => gate.promise;
  const pending = app.state.onConfig({ clear: true });
  try {
    await flush();
    assert.equal(app.runtime.suspends.length, 1);
    assert.equal(app.runtime.suspends[0]!.token, 'mh_ck_old');
    assert.deepEqual(app.config(), initialConfig);
  } finally { gate.resolve(); }
  await pending;
  assert.deepEqual(app.config(), {});
  assert.equal(app.state.configured, false);
  assert.equal(app.runtime.starts, 1);
  await app.fire(60_000);
  assert.equal(app.runtime.starts, 1);
});

test('只更新 key 时先暂停旧任务，不重载未变化的 Cookie', async () => {
  const app = await boot();
  await app.state.onConfig({ key: 'mh_ck_new' });
  assert.equal(app.runtime.suspends[0]?.token, 'mh_ck_old');
  assert.equal(app.browsers[0]!.cookieChanges.length, 0);
  assert.equal(app.config().clientKey, 'mh_ck_new');
  assert.equal(app.runtime.starts, 2);
  assert.ok(app.events.indexOf('drained:mh_ck_old') < app.events.indexOf('save:mh_ck_new'));
});

test('并发配置保存串行执行，每次都读取前一次保存后的配置', async () => {
  const gate = deferred();
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.suspend = () => gate.promise;
  const first = app.state.onConfig({ key: 'mh_ck_new' });
  const second = app.state.onConfig({ cookie: 'MUSIC_U=new' });
  try {
    await flush();
    assert.equal(app.runtime.suspends.length, 1);
    assert.deepEqual(app.config(), initialConfig);
  } finally { gate.resolve(); }
  await Promise.all([first, second]);
  assert.deepEqual(app.config(), { clientKey: 'mh_ck_new', neteaseCookie: 'MUSIC_U=new' });
  assert.deepEqual(app.runtime.suspends.map((s) => s.token), ['mh_ck_old', 'mh_ck_new']);
  assert.equal(app.browsers[0]!.cookieChanges.length, 1);
});

test('Cookie 应用失败必须返回错误，关闭半更新浏览器，不能记录配置成功或启动任务', async () => {
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.setCookie = async () => { throw new Error('cookie apply failed'); };
  await assert.rejects(app.state.onConfig({ cookie: 'MUSIC_U=new' }), /cookie apply failed/);
  assert.equal(app.browsers[0]!.closed, true);
  assert.equal(app.state.browserReady, false);
  assert.equal(app.runtime.starts, 1);
  assert.equal(app.state.logs.some((entry: any) => entry.msg.startsWith('配置已保存')), false);
});

test('Cookie 应用期间断线不能返回配置成功', async () => {
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.setCookie = async () => { app.browsers[0]!.disconnect(); };
  await assert.rejects(app.state.onConfig({ cookie: 'MUSIC_U=new' }), /浏览器/);
  assert.equal(app.runtime.starts, 1);
  assert.equal(app.state.logs.some((entry: any) => entry.msg.startsWith('配置已保存')), false);
});

test('runtime.start 等待期间断线不能返回配置成功', async () => {
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.start = async () => { app.browsers[0]!.disconnect(); };
  await assert.rejects(app.state.onConfig({ key: 'mh_ck_new' }), /浏览器/);
  assert.equal(app.state.browserReady, false);
  assert.equal(app.state.logs.some((entry: any) => entry.msg.startsWith('配置已保存')), false);
});

for (const clear of [false, true]) {
  test(`旧浏览器排队的断线回调不得干扰后续配置${clear ? '清空' : '恢复的新实例'}`, async () => {
    const gate = deferred();
    const hooks: Hooks = {};
    const app = await boot(hooks);
    hooks.setCookie = () => gate.promise;
    const first = app.state.onConfig({ cookie: 'MUSIC_U=new' });
    const firstRejected = assert.rejects(first, /浏览器/);
    await flush(); // A 已进入 setCookie，仍占用生命周期队列
    const second = app.state.onConfig(clear ? { clear: true } : { key: 'mh_ck_new' });
    app.browsers[0]!.disconnect(); // 旧断线回调排在 B 之后
    gate.resolve();
    await firstRejected;
    await second;
    await flush();
    assert.equal(app.browsers[0]!.closed, true);
    assert.equal(app.runtime.suspends.filter((s) => s.reason === 'browser_disconnected').length, 0,
      'A/B 已完成暂停与配置切换，旧回调不能再暂停当前 runtime');
    assert.equal(app.timers.filter((t) => t.ms === 5000 && !t.cancelled).length, 0,
      '旧回调不能再安排冗余恢复');
    if (clear) {
      assert.equal(app.state.configured, false);
      assert.equal(app.runtime.starts, 1);
      assert.equal(app.browsers.length, 1);
    } else {
      assert.equal(app.state.browserReady, true);
      assert.equal(app.runtime.starts, 2);
      assert.equal(app.browsers.length, 2);
      assert.equal(app.browsers[1]!.closed, false);
      assert.equal(app.requests.at(-1)!.token, 'mh_ck_new');
    }
  });
}

test('浏览器断开先等待 suspend，再重连并恢复已配置任务', async () => {
  const gate = deferred();
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.suspend = () => gate.promise;
  app.browsers[0]!.disconnect();
  try {
    await flush();
    assert.equal(app.runtime.suspends.length, 1);
    await app.fire(5000);
    assert.equal(app.browsers.length, 1, '旧任务未排空时不能重启浏览器');
  } finally { gate.resolve(); }
  await flush();
  await app.fire(5000);
  assert.equal(app.browsers.length, 2);
  assert.equal(app.runtime.starts, 2);
  assert.equal(app.state.browserReady, true);
});

test('断开后的待重连回调不得在用户清空配置后重启任务', async () => {
  const app = await boot();
  app.browsers[0]!.disconnect();
  await flush();
  await app.state.onConfig({ clear: true });
  await app.fire(5000);
  await app.fire(60_000);
  assert.equal(app.runtime.starts, 1);
  assert.equal(app.browsers.length, 1);
  assert.equal(app.state.configured, false);
});

test('浏览器启动 single-flight，重入调用复用同一次启动', async () => {
  const gate = deferred();
  const app = await boot({ launch: () => gate.promise });
  const first = app.launchBrowser();
  const second = app.launchBrowser();
  try {
    await flush();
    assert.equal(app.browsers.length, 1);
  } finally { gate.resolve(); }
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('浏览器启动失败关闭新创建实例，管理端仍可用', async () => {
  const app = await boot({ launch: async () => { throw new Error('launch failed'); } });
  assert.equal(app.browsers.length, 1);
  assert.equal(app.browsers[0]!.closed, true);
  assert.equal(app.state.browserReady, false);
  assert.equal(app.runtime.starts, 0);
  assert.equal(app.events[0], 'server:start');
  assert.equal(app.events.some((e) => e.startsWith('exit:')), false);
});

test('初次 /me 和 /next 前刷新会员身份', async () => {
  const app = await boot({ vipType: 11 });
  assert.deepEqual(app.requests.map((r) => [r.path, r.vipType]), [['/api/me', '11'], ['/api/next', '11']]);
  assert.ok(app.events.indexOf('identity:MUSIC_U=old') < app.events.indexOf('start:mh_ck_old'));
});

test('会员身份从 11 变为 0 后请求头清零，不继承旧账号等级', async () => {
  const hooks: Hooks = { vipType: 11 };
  const app = await boot(hooks);
  await app.transport.heartbeat('mh_ck_old', {});
  hooks.vipType = 0;
  await app.transport.heartbeat('mh_ck_old', {});
  await app.transport.next('mh_ck_old');
  assert.equal(app.requests.at(-1)!.vipType, '0');
});

test('配置切换等待异步 player.stop 完成，不能先改变凭证', async () => {
  const gate = deferred();
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.stop = () => gate.promise;
  const pending = app.state.onConfig({ key: 'mh_ck_new' });
  try {
    await flush();
    assert.ok(app.events.includes('player:stop'));
    assert.deepEqual(app.config(), initialConfig);
  } finally { gate.resolve(); }
  await pending;
  assert.ok(app.events.indexOf('player:stopped') < app.events.indexOf('save:mh_ck_new'));
});

test('写盘失败不假报成功或改变配置，下一次保存仍能恢复', async () => {
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.save = () => { throw new Error('disk full'); };
  await assert.rejects(app.state.onConfig({ key: 'mh_ck_new' }), /disk full/);
  assert.deepEqual(app.config(), initialConfig);
  assert.equal(app.runtime.starts, 1);
  assert.equal(app.state.logs.some((entry: any) => entry.msg.startsWith('配置已保存')), false);
  hooks.save = undefined;
  await app.state.onConfig({ key: 'mh_ck_new' });
  assert.equal(app.config().clientKey, 'mh_ck_new');
  assert.equal(app.runtime.starts, 2);
});

test('runtime.start 的失败必须传回配置调用方，队列后续可重试', async () => {
  const hooks: Hooks = {};
  const app = await boot(hooks);
  hooks.start = async () => { throw new Error('start failed'); };
  await assert.rejects(app.state.onConfig({ key: 'mh_ck_new' }), /start failed/);
  assert.equal(app.state.logs.some((entry: any) => entry.msg.startsWith('配置已保存')), false);
  assert.equal(app.runtime.suspends.at(-1)!.token, 'mh_ck_new');
  hooks.start = undefined;
  await app.state.onConfig({ key: 'mh_ck_new' });
  assert.equal(app.browsers[0]!.cookieChanges.length, 0);
  assert.equal(app.runtime.starts, 3);
});

test('换 Cookie 后首次请求使用新账号等级，清空旧 VIP 缓存', async () => {
  const hooks: Hooks = { vipType: 11 };
  const app = await boot(hooks);
  hooks.vipType = 0;
  await app.state.onConfig({ cookie: 'MUSIC_U=new' });
  assert.deepEqual(app.requests.slice(-2).map((r) => [r.path, r.vipType]), [['/api/me', '0'], ['/api/next', '0']]);
  assert.equal(app.browsers[0]!.cookie, 'MUSIC_U=new');
});

test('未配置时不启动 runtime，后台重试也不领取任务', async () => {
  const app = await boot({ config: {} });
  await app.fire(60_000);
  assert.equal(app.runtime.starts, 0);
  assert.equal(app.requests.length, 0);
});
