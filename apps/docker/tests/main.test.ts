import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { applyConfigPatch, migrateLegacyConfig, normalizeServerUrl } from '../src/settings.ts';
import { createTransport } from '../src/transport.ts';
import { MultiServerScheduler } from '../src/scheduler.ts';

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
  progress?: () => Promise<{ playedMs: number; durationMs: number; positionMs?: number; ended?: boolean; evidence?: Record<string, number | boolean> }>;
  play?: () => Promise<unknown>;
  start?: () => Promise<void>;
  save?: () => void;
  vipType?: number;
  identityWait?: () => Promise<void>;
  apiResponse?: (path: string) => unknown | Promise<unknown>;
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
    dead = false;
    cookieChanges: string[] = [];
    unavailable: Array<(reason: string) => void> = [];
    constructor(_dir: string, cookie: string) { this.cookie = cookie; browsers.push(this); }
    async launch() { events.push(`launch:${this.cookie}`); await hooks.launch?.(); }
    async close() { this.closed = true; events.push('close'); this.disconnect(); }
    onUnavailable(cb: (reason: string) => void) { this.unavailable.push(cb); }
    disconnect() { this.dead = true; for (const cb of this.unavailable) cb('浏览器进程已断开'); }
    /** 渲染进程崩溃：浏览器进程还在，browser 字段仍非空 */
    crash() { this.dead = true; for (const cb of this.unavailable) cb('渲染进程崩溃'); }
    isUsable() { return !this.dead; }
    async setCookie(cookie: string) {
      this.cookieChanges.push(cookie);
      events.push(`cookie:${cookie}`);
      await hooks.setCookie?.();
      this.cookie = cookie;
    }
    async identity() {
      events.push(`identity:${this.cookie}`);
      await hooks.identityWait?.();
      return { id: '123', name: 'test', vipType: hooks.vipType ?? 11 };
    }
    async stop() { events.push('player:stop'); await hooks.stop?.(); events.push('player:stopped'); }
    async play() { return hooks.play ? hooks.play() : { ok: true }; }
    async progress() { return hooks.progress ? hooks.progress() : { playedMs: 0, durationMs: 0 }; }
  }
  class FakeRuntime {
    starts = 0;
    progressSamples: number[] = [];
    observations: any[][] = [];
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
    constructor(deps: any) {
      this.deps = deps;
      deps.player.onProgress((...sample: any[]) => { this.progressSamples.push(sample[0]); this.observations.push(sample); });
    }
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
  const mockCreateApi = (deps: any) => async (_method: string, url: string, _body?: unknown, token = deps.getToken()) => {
    requests.push({ path: url, token, vipType: deps.extraHeaders()['X-Vip-Type'] });
    return hooks.apiResponse ? hooks.apiResponse(url) : { status: 200, payload: {} };
  };

  class FakeServerWorker {
    config: any;
    runtime: FakeRuntime;
    scheduler: MultiServerScheduler;
    pushLog: (level: string, msg: string) => void;
    state: any;
    transport: any;
    currentReleaseTurn: (() => void) | null = null;

    constructor(deps: any) {
      this.config = deps.config;
      this.scheduler = deps.scheduler;
      this.pushLog = deps.pushLog;
      this.state = {
        id: deps.config.id,
        name: deps.config.name,
        baseUrl: deps.config.baseUrl,
        enabled: deps.config.enabled !== false,
        configured: Boolean(String(deps.config.clientKey || '').trim()),
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

      const setLastApi = (r: any) => {
        this.state.lastApi = { ok: r.ok, status: r.status, at: r.at, error: r.error };
        if (!r.ok) {
          if (r.status === 401) {
            this.pushLog('error', `[${this.config.name}] 凭证被拒绝 (401)，已停止本服领单`);
          } else if (r.status === 0) {
            this.pushLog('warn', `[${this.config.name}] 网络不可达 (${r.error || '超时'})`);
          }
        }
      };

      const api = mockCreateApi({
        base: deps.config.baseUrl,
        version: deps.clientVersion,
        clientType: 'docker',
        getToken: () => String(this.config.clientKey || ''),
        extraHeaders: deps.extraHeaders ?? (() => ({ 'X-Vip-Type': '0' })),
        onResult: setLastApi,
      });

      const transport = createTransport({
        api,
        getIdentity: deps.getIdentity,
        onHeartbeatRejected: deps.onHeartbeatRejected ?? ((failure: any) => {
          this.pushLog('warn', `心跳未获确认：${failure.error}（HTTP ${failure.status} / 任务 ${failure.jobId}）`);
        }),
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
          try { return await transport.finish(token, input); }
          finally { this.releaseCurrentTurn(); }
        },
        abandon: async (token: string, r: string, d: string, jobId?: string) => {
          try { await transport.abandon(token, r, d, jobId); }
          finally { this.releaseCurrentTurn(); }
        },
      };
      this.transport = gatedTransport;

      this.runtime = new FakeRuntime({
        adapter: {
          clientType: 'docker',
          version: deps.clientVersion,
          storage: {
            getToken: () => String(this.config.clientKey || ''),
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
      });

      this.scheduler.registerServer(this.config.id, () => ({
        enabled: this.config.enabled,
        eligible: Boolean(String(this.config.clientKey || '').trim()) && this.state.authStatus !== 'logged_out',
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
        this.pushLog(e.level, e.msg);
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
      if (!this.config.enabled || !String(this.config.clientKey || '').trim()) return;
      await this.runtime.start(true);
    }

    async stop(): Promise<void> {
      this.releaseCurrentTurn();
      this.scheduler.unregisterServer(this.config.id);
      await this.runtime.suspend('worker_stopped');
    }

    getState() {
      this.state.cooldownUntil = this.scheduler.getCooldownUntil(this.config.id);
      return { ...this.state };
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
    MultiServerScheduler, ServerWorker: FakeServerWorker, migrateLegacyConfig, normalizeServerUrl,
    createApi: mockCreateApi,
    createStatusServer: () => { events.push('server:start'); },
    process: { env: { DATA_DIR: '/test-data', API_BASE: 'http://localhost', ...process.env }, exit: (code: number) => events.push(`exit:${code}`) },
    console: { log() {}, error() {} },
    setTimeout: (cb: () => unknown, ms: number) => timer(cb, ms, false),
    setInterval: (cb: () => unknown, ms: number) => timer(cb, ms, true),
    clearTimeout: (t: { cancelled: boolean }) => { t.cancelled = true; },
    clearInterval: (t: { cancelled: boolean }) => { t.cancelled = true; },
  });
  vm.runInContext(source + '\n;globalThis.app = { state, runtime, launchBrowser, transport, player, setLastApi };', context);
  await flush();
  const app = (context as any).app as {
    state: any; runtime: FakeRuntime; launchBrowser: () => Promise<boolean>;
    transport: ReturnType<typeof createTransport>; player: any;
    setLastApi: (r: { ok: boolean; status: number; at: number; error?: string }) => void;
  };
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

test('真实有效时长、媒体位置、结束标志与证据分别传给 core', async () => {
  const evidence = { playbackRate: 2, jumpCount: 1, backwardJumpCount: 0, listenDriftMs: 9000, stallDetected: false };
  const app = await boot({ progress: async () => ({ playedMs: 1000, positionMs: 10000, durationMs: 310000, ended: false, evidence }) });
  app.runtime.bus.emit('job:current', { jobId: 'a', musicName: 'one', targetMs: 310000 });
  await app.fire(1000);
  assert.equal(JSON.stringify(app.runtime.observations), JSON.stringify([[1000, 10000, 310000, { ...evidence, ended: false }]]));
});

test('零有效时长的曲终仍上报，让 core 拒绝试听或跳播而非无限等候', async () => {
  const app = await boot({ progress: async () => ({ playedMs: 0, positionMs: 30000, durationMs: 30000, ended: true }) });
  app.runtime.bus.emit('job:current', { jobId: 'a', musicName: 'one', targetMs: 310000 });
  await app.fire(1000);
  assert.equal(app.runtime.observations.length, 1);
  assert.equal(app.runtime.observations[0]![0], 0);
  assert.equal(app.runtime.observations[0]![3].ended, true);
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

test('心跳业务拒绝保留任务与原因，同因去重并在恢复后重新记录', async () => {
  const app = await boot({ apiResponse: (url) => url.endsWith('/heartbeat')
    ? { status: 200, payload: { ok: false, error: 'job_not_active' } }
    : { status: 200, payload: {} } });
  app.runtime.bus.emit('job:current', { jobId: 'a', musicName: 'one', targetMs: 310000 });
  const rejected = () => app.state.logs.filter((l: any) => /心跳未获确认/.test(l.msg));
  assert.equal(await app.transport.heartbeat('mh_ck_old', { jobId: 'a', positionMs: 1000 }), false);
  await app.transport.heartbeat('mh_ck_old', { jobId: 'a', positionMs: 2000 });
  assert.equal(rejected().length, 1);
  assert.match(rejected()[0].msg, /任务 a/);
  assert.match(rejected()[0].msg, /job_not_active/);
  assert.doesNotMatch(rejected()[0].msg, /mh_ck_old|MUSIC_U/);
  app.runtime.bus.emit('heartbeat:tick', { jobId: 'a', intervalMs: 10000, lastAtMs: 10000 });
  await app.transport.heartbeat('mh_ck_old', { jobId: 'a', positionMs: 3000 });
  assert.equal(rejected().length, 2, '恢复后再次失败应重新记录');
});

test('旧任务的迟到心跳拒绝不得显示为新任务故障', async () => {
  const gate = deferred();
  const app = await boot({ apiResponse: async (url) => {
    if (!url.endsWith('/heartbeat')) return { status: 200, payload: {} };
    await gate.promise;
    return { status: 409, payload: null, error: 'job_not_active' };
  } });
  app.runtime.bus.emit('job:current', { jobId: 'a', musicName: 'one', targetMs: 1000 });
  const pending = app.transport.heartbeat('mh_ck_old', { jobId: 'a' });
  await flush();
  app.runtime.bus.emit('job:current', { jobId: 'b', musicName: 'two', targetMs: 1000 });
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(app.state.logs.some((l: any) => /心跳未获确认/.test(l.msg)), false);
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
  assert.deepEqual(app.config(), { servers: [] });
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
  assert.deepEqual(app.config(), {
    clientKey: 'mh_ck_new',
    neteaseCookie: 'MUSIC_U=new',
    servers: [
      {
        id: 'default',
        name: '默认服务端',
        baseUrl: 'http://localhost',
        clientKey: 'mh_ck_new',
        enabled: true,
      },
    ],
  });
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

test('渲染进程崩溃后自动重建浏览器并恢复任务（不再卡在僵尸状态）', async () => {
  const app = await boot();
  assert.equal(app.browsers.length, 1);
  app.browsers[0]!.crash();
  await flush();
  assert.equal(app.state.browserReady, false, '崩溃后不能再对外声称浏览器就绪');
  assert.match(String(app.state.logs.at(-1)!.msg), /渲染进程崩溃/);
  await app.fire(5000);
  assert.equal(app.browsers.length, 2, '崩溃后必须重建浏览器');
  assert.equal(app.runtime.starts, 2, '重建后应恢复任务循环');
  assert.equal(app.state.browserReady, true);
});

test('兜底巡检拆掉已不可用的浏览器实例（崩溃信号漏接也能自愈）', async () => {
  const app = await boot();
  app.browsers[0]!.dead = true; // 只标记不可用，不触发回调：模拟事件没接住
  await app.fire(60_000);
  assert.equal(app.browsers[0]!.closed, true, '已死的实例必须先拆掉');
  assert.equal(app.browsers.length, 2);
  assert.equal(app.runtime.starts, 2);
});

test('已不可用的浏览器实例不会被当成「浏览器还在」，兜底巡检不重复重建', async () => {
  const app = await boot();
  app.browsers[0]!.dead = true;
  await app.fire(60_000);
  await app.fire(60_000);
  assert.equal(app.browsers.length, 2, '第二次巡检不应再建一个');
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

test('播放器失败原因透传给 runtime（页内错误不能只剩一句「加载失败」）', async () => {
  const app = await boot({ play: async () => ({ ok: false, err: '页内操作超时（fetch）' }) });
  assert.deepEqual(await app.player.play('song:1', 1000), { ok: false, err: '页内操作超时（fetch）' });
});

test('播放器抛异常时转成带原因的失败，不让 runtime 收到裸异常', async () => {
  const app = await boot({ play: async () => { throw new Error('page crashed'); } });
  const r = await app.player.play('song:1', 1000);
  assert.equal(r.ok, false);
  assert.match(String(r.err), /page crashed/);
});

test('终态 4xx（401/409）不写成「将持续重试」，网络失败才提示重试', async () => {
  const app = await boot();
  app.setLastApi({ ok: false, status: 409, at: 1, error: 'job_not_active' });
  const rejected = app.state.logs.at(-1).msg;
  assert.match(rejected, /409/);
  assert.match(rejected, /job_not_active/);
  assert.doesNotMatch(rejected, /持续重试/);
  app.setLastApi({ ok: true, status: 200, at: 2 }); // 状态转好后才会再记一条（同因去重）
  app.setLastApi({ ok: false, status: 401, at: 3, error: 'invalid_or_expired_token' });
  const unauthorized = app.state.logs.at(-1).msg;
  assert.match(unauthorized, /401/);
  assert.doesNotMatch(unauthorized, /持续重试/);
  app.setLastApi({ ok: true, status: 200, at: 4 });
  app.setLastApi({ ok: false, status: 0, at: 5, error: 'ECONNRESET' });
  assert.match(app.state.logs.at(-1).msg, /持续重试/);
});

test('被拒的 4xx 之后恢复成功不报「服务端连接已恢复」（本来就没断）', async () => {
  const app = await boot();
  app.setLastApi({ ok: false, status: 409, at: 1, error: 'job_not_active' });
  app.setLastApi({ ok: true, status: 200, at: 2 });
  assert.equal(app.state.logs.some((l: any) => /连接已恢复/.test(l.msg)), false);
  app.setLastApi({ ok: false, status: 0, at: 3, error: 'ECONNRESET' });
  app.setLastApi({ ok: true, status: 200, at: 4 });
  assert.equal(app.state.logs.some((l: any) => /连接已恢复/.test(l.msg)), true);
});

test('main 配置热重载支持无缝重构 ServerWorker 列表', async () => {
  const app = await boot();
  // 初始应该有默认服务端
  assert.equal(app.state.servers.length, 1);
  assert.equal(app.state.servers[0].id, 'default');
  assert.equal(app.state.servers[0].enabled, true);

  // 热重载配置：更新为多服务端
  await app.state.onConfig({
    servers: [
      { id: 'srv-1', name: '服务1', baseUrl: 'http://localhost/srv1', clientKey: 'mh_ck_srv1', enabled: true },
      { id: 'srv-2', name: '服务2', baseUrl: 'http://localhost/srv2', clientKey: 'mh_ck_srv2', enabled: false },
    ],
  });

  // 验证旧 Worker (default) 已被 suspend
  assert.ok(app.runtime.suspends.some((s) => s.token === 'mh_ck_old'));

  // 验证 state.servers 正确更新为新 Worker 列表
  assert.equal(app.state.servers.length, 2);
  assert.equal(app.state.servers[0].id, 'srv-1');
  assert.equal(app.state.servers[0].name, '服务1');
  assert.equal(app.state.servers[0].enabled, true);
  assert.equal(app.state.servers[1].id, 'srv-2');
  assert.equal(app.state.servers[1].name, '服务2');
  assert.equal(app.state.servers[1].enabled, false);

  // 再次热重载：删除 srv-2，增加 srv-3
  await app.state.onConfig({
    servers: [
      { id: 'srv-1', name: '服务1', baseUrl: 'http://localhost/srv1', clientKey: 'mh_ck_srv1', enabled: true },
      { id: 'srv-3', name: '服务3', baseUrl: 'http://localhost/srv3', clientKey: 'mh_ck_srv3', enabled: true },
    ],
  });

  assert.equal(app.state.servers.length, 2);
  assert.equal(app.state.servers.map((s: any) => s.id).sort().join(','), 'srv-1,srv-3');
});

test('state.job 携带 serverId 与 serverName 信息', async () => {
  const app = await boot();
  app.runtime.bus.emit('job:current', { jobId: 'job-123', musicName: '海阔天空', targetMs: 300000 });
  assert.equal(app.state.job?.musicName, '海阔天空');
  assert.equal(app.state.job?.serverId, 'default');
  assert.equal(app.state.job?.serverName, '默认服务端');
  app.runtime.bus.emit('job:current', null);
  assert.equal(app.state.job, null);
});

test('main 启动时支持 SERVER_1_URL / SERVER_1_KEY 注入多服务端', async () => {
  const origUrl1 = process.env.SERVER_1_URL;
  const origKey1 = process.env.SERVER_1_KEY;
  const origName1 = process.env.SERVER_1_NAME;
  const origUrl2 = process.env.SERVER_2_URL;
  const origKey2 = process.env.SERVER_2_KEY;
  const origName2 = process.env.SERVER_2_NAME;

  try {
    process.env.SERVER_1_URL = 'http://localhost:8001';
    process.env.SERVER_1_KEY = 'mh_ck_env1';
    process.env.SERVER_1_NAME = '环境变量服1';
    process.env.SERVER_2_URL = 'http://localhost:8002';
    process.env.SERVER_2_KEY = 'mh_ck_env2';
    process.env.SERVER_2_NAME = '环境变量服2';

    const app = await boot({ config: { neteaseCookie: 'MUSIC_U=test' } });
    assert.equal(app.state.servers.length, 2);
    assert.equal(app.state.servers[0].name, '环境变量服1');
    assert.equal(app.state.servers[0].baseUrl, 'http://localhost:8001');
    assert.equal(app.state.servers[1].name, '环境变量服2');
    assert.equal(app.state.servers[1].baseUrl, 'http://localhost:8002');
  } finally {
    if (origUrl1 !== undefined) process.env.SERVER_1_URL = origUrl1; else delete process.env.SERVER_1_URL;
    if (origKey1 !== undefined) process.env.SERVER_1_KEY = origKey1; else delete process.env.SERVER_1_KEY;
    if (origName1 !== undefined) process.env.SERVER_1_NAME = origName1; else delete process.env.SERVER_1_NAME;
    if (origUrl2 !== undefined) process.env.SERVER_2_URL = origUrl2; else delete process.env.SERVER_2_URL;
    if (origKey2 !== undefined) process.env.SERVER_2_KEY = origKey2; else delete process.env.SERVER_2_KEY;
    if (origName2 !== undefined) process.env.SERVER_2_NAME = origName2; else delete process.env.SERVER_2_NAME;
  }
});

