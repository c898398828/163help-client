import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { ClientRuntime } from '../../../packages/core/dist/index.js';
import { MultiServerScheduler } from '../src/scheduler.ts';
import { createApi } from '../src/api.ts';
import { createTransport } from '../src/transport.ts';
import type { ServerConfigItem } from '../src/settings.ts';

const workerRaw = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerSource = stripTypeScriptTypes(workerRaw)
  .replace(/^import .*;\r?$/gm, '')
  .replace(/\bexport\s+/g, '');

const context = vm.createContext({
  ClientRuntime,
  createApi,
  createTransport,
  MultiServerScheduler,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: (...args: any[]) => (globalThis as any).fetch(...args),
  AbortSignal: globalThis.AbortSignal,
  Headers: globalThis.Headers,
  Response: globalThis.Response,
});
vm.runInContext(workerSource + '\n;globalThis.ServerWorker = ServerWorker;', context);
const ServerWorker = (context as any).ServerWorker;

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

function createMockDeps(overrides: Partial<WorkerDeps> = {}): {
  deps: WorkerDeps;
  logs: Array<{ level: string; msg: string }>;
  played: Array<{ musicId: string; durationMs: number; ownerName: string }>;
} {
  const logs: Array<{ level: string; msg: string }> = [];
  const played: Array<{ musicId: string; durationMs: number; ownerName: string }> = [];

  const scheduler = overrides.scheduler ?? new MultiServerScheduler();
  const config = overrides.config ?? {
    id: 's1',
    name: '测试主服',
    baseUrl: 'https://mock.server',
    clientKey: 'mh_ck_test',
    enabled: true,
  };

  const deps: WorkerDeps = {
    config,
    scheduler,
    clientVersion: '5.1',
    getIdentity: async () => ({ id: 'u1', name: 'User', vipType: 0 }),
    player: {
      play: async (musicId, durationMs, ownerName) => {
        played.push({ musicId, durationMs, ownerName });
        return true;
      },
      stop: async () => {},
      onProgress: () => {},
    },
    pushLog: (level, msg) => {
      logs.push({ level, msg });
    },
    ...overrides,
  };

  return { deps, logs, played };
}

describe('ServerWorker 封装与 Core Runtime 协同', () => {
  test('ServerWorker 初始化与状态收集', async () => {
    const { deps } = createMockDeps();
    const worker = new ServerWorker(deps);

    const state = worker.getState();
    assert.equal(state.id, 's1');
    assert.equal(state.name, '测试主服');
    assert.equal(state.baseUrl, 'https://mock.server');
    assert.equal(state.enabled, true);
    assert.equal(state.configured, true);
    assert.equal(state.authStatus, '');
    assert.equal(state.acctName, '');
    assert.equal(state.credits, 0);
    assert.equal(state.helpUsed, 0);
    assert.equal(state.helpLimit, null);
    assert.equal(state.recv, 0);
    assert.equal(state.recvLimit, null);
    assert.equal(state.jobsDone, 0);
    assert.equal(state.lastApi, null);
    assert.equal(state.cooldownUntil, 0);

    await worker.stop();
  });

  test('未配置 clientKey 时 configured 为 false', async () => {
    const { deps } = createMockDeps({
      config: {
        id: 's2',
        name: '空凭证服',
        baseUrl: 'https://mock2.server',
        clientKey: '   ',
        enabled: true,
      },
    });
    const worker = new ServerWorker(deps);
    const state = worker.getState();
    assert.equal(state.configured, false);
    await worker.stop();
  });

  test('启停与调度器注册/注销', async () => {
    const scheduler = new MultiServerScheduler();
    const { deps } = createMockDeps({ scheduler });
    const worker = new ServerWorker(deps);

    // worker 构造时已注册进调度器
    const turn = await scheduler.requestNextTurn();
    assert.equal(turn?.serverId, 's1');
    turn.release('settled');

    // 停止 worker
    await worker.stop();

    // 停止后已从调度器注销，无法调度到 s1
    const nextTurn = await scheduler.requestNextTurn();
    assert.equal(nextTurn, null);
  });

  test('Gated transport：服务被禁用时直接返回 server_disabled 且不占用调度锁', async () => {
    const scheduler = new MultiServerScheduler();
    const { deps } = createMockDeps({
      scheduler,
      config: {
        id: 's1',
        name: '已禁用服',
        baseUrl: 'https://mock.server',
        clientKey: 'mh_ck_test',
        enabled: false,
      },
    });
    const worker = new ServerWorker(deps);

    const transport = (worker.runtime as any).deps.transport;
    const res = await transport.next('dummy_token');

    assert.equal(res.status, 200);
    assert.equal(res.payload?.musicId, null);
    assert.equal(res.payload?.noTargetReason, 'server_disabled');

    // 调度器锁未被占用
    scheduler.registerServer('other_server', () => ({ enabled: true, eligible: true }));
    const turn = await scheduler.acquireTurn('other_server');
    assert.notEqual(turn, null);
    turn?.();

    await worker.stop();
  });

  test('Gated transport：调度器暂停时返回 scheduler_paused', async () => {
    const scheduler = new MultiServerScheduler();
    const { deps } = createMockDeps({ scheduler });
    const worker = new ServerWorker(deps);

    scheduler.pause();
    const transport = (worker.runtime as any).deps.transport;
    const res = await transport.next('dummy_token');

    assert.equal(res.status, 200);
    assert.equal(res.payload?.musicId, null);
    assert.equal(res.payload?.noTargetReason, 'scheduler_paused');

    await worker.stop();
  });

  test('Gated transport：无单 (noTargetReason) 触发冷却并即刻释放锁', async () => {
    const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 10_000 });
    const { deps } = createMockDeps({ scheduler });
    const worker = new ServerWorker(deps);

    const transport = (worker.runtime as any).deps.transport;

    // 模拟底层的 transport.next 返回无单
    let originalNextCalled = false;
    // 注入底层 next 的模拟实现
    const protoNext = transport.next;
    // 使用全局 fetch 拦截测试无单返回
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ musicId: null, noTargetReason: 'resting' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      const res = await transport.next('dummy_token');
      assert.equal(res.status, 200);
      assert.equal(res.payload?.noTargetReason, 'resting');

      // 验证触发了冷却
      const state = worker.getState();
      assert.ok(state.cooldownUntil > Date.now());

      // 验证锁已即时释放（其他 server 能立即拿到锁）
      scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));
      const turn2 = await scheduler.requestNextTurn();
      assert.equal(turn2?.serverId, 's2');
      turn2.release('settled');
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('Gated transport：抢到单时保持锁，直到 finish 释放', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));
    const { deps } = createMockDeps({ scheduler });
    const worker = new ServerWorker(deps);
    const transport = (worker.runtime as any).deps.transport;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/next')) {
        return new Response(JSON.stringify({ jobId: 'j1', musicId: 'm1', targetDurationMs: 60000 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('/api/play/finish')) {
        return new Response(JSON.stringify({ ok: true, settled: true, credited: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const res = await transport.next('dummy_token');
      assert.equal(res.status, 200);
      assert.equal(res.payload?.jobId, 'j1');

      // 验证锁仍被 s1 独占（其他请求拿不到）
      let s2GotTurn = false;
      const pS2 = scheduler.acquireTurn('s2').then((rel) => {
        s2GotTurn = true;
        rel?.();
      });

      // 此时 s2 拿不到
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(s2GotTurn, false);

      // 调用 finish 释放锁
      await transport.finish('dummy_token', { jobId: 'j1' });

      // s2 应该被唤醒并拿到锁
      await pS2;
      assert.equal(s2GotTurn, true);
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('Gated transport：抢到单后 abandon 亦会释放锁', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));
    const { deps } = createMockDeps({ scheduler });
    const worker = new ServerWorker(deps);
    const transport = (worker.runtime as any).deps.transport;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/next')) {
        return new Response(JSON.stringify({ jobId: 'j2', musicId: 'm2', targetDurationMs: 60000 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const res = await transport.next('dummy_token');
      assert.equal(res.payload?.jobId, 'j2');

      let s2GotTurn = false;
      const pS2 = scheduler.acquireTurn('s2').then((rel) => {
        s2GotTurn = true;
        rel?.();
      });

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(s2GotTurn, false);

      // 调用 abandon
      await transport.abandon('dummy_token', 'test_reason', 'detail', 'j2');

      await pS2;
      assert.equal(s2GotTurn, true);
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('Gated transport：网络失败或异常时即刻释放锁', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));
    const { deps } = createMockDeps({ scheduler });
    const worker = new ServerWorker(deps);
    const transport = (worker.runtime as any).deps.transport;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network crash');
    };

    try {
      // api 层遇到网络失败返回 status: 0
      const res = await transport.next('dummy_token');
      assert.equal(res.status, 0);

      // 验证锁已释放，s2 能够立即获取
      const turn2 = await scheduler.acquireTurn('s2');
      assert.notEqual(turn2, null);
      turn2?.();
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('Gated transport：底包抛出异常时 catch 立即释放锁并向外抛出', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const config = {
      id: 's1',
      name: '异常测试服',
      baseUrl: '://invalid-url',
      clientKey: 'mh_ck_test',
      enabled: true,
    };

    const { deps } = createMockDeps({ scheduler, config });
    const worker = new ServerWorker(deps);
    const transport = (worker.runtime as any).deps.transport;

    await assert.rejects(async () => {
      await transport.next('dummy_token');
    });

    // 验证抛错后锁被立刻释放，s2 能够拿到
    const turn2 = await scheduler.acquireTurn('s2');
    assert.notEqual(turn2, null);
    turn2?.();

    await worker.stop();
  });

  test('Core 事件总线协同监听与状态同步', async () => {
    const { deps, logs } = createMockDeps();
    const worker = new ServerWorker(deps);

    // 触发 job:settled
    worker.runtime.bus.emit('job:settled', { jobId: 'j1', credited: true });
    assert.equal(worker.getState().jobsDone, 1);
    worker.runtime.bus.emit('job:settled', { jobId: 'j2', credited: false });
    assert.equal(worker.getState().jobsDone, 1); // credited: false 不累加

    // 触发 auth:user
    worker.runtime.bus.emit('auth:user', { displayName: 'Tester', credits: 120 });
    assert.equal(worker.getState().acctName, 'Tester');
    assert.equal(worker.getState().credits, 120);

    // 触发 auth:status
    worker.runtime.bus.emit('auth:status', 'valid');
    assert.equal(worker.getState().authStatus, 'valid');

    // 触发 limits:updated
    worker.runtime.bus.emit('limits:updated', {
      helpedToday: 50,
      helpedLimit: 9000,
      receivedToday: 10,
      receivedLimit: 26,
    });
    assert.equal(worker.getState().helpUsed, 50);
    assert.equal(worker.getState().recv, 10);

    // 触发 log:append
    worker.runtime.bus.emit('log:append', {
      level: 'info',
      ts: Date.now(),
      msg: '单曲完成',
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'info');
    assert.equal(logs[0]?.msg, '[测试主服] 单曲完成');

    await worker.stop();
  });

  test('API 异常与 401 日志推送与状态记录', async () => {
    const { deps, logs } = createMockDeps();
    const worker = new ServerWorker(deps);

    const origFetch = globalThis.fetch;
    try {
      // 模拟 401
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'invalid_or_expired_token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });

      // transport.me 触发一次 api
      await (worker.runtime as any).deps.transport.me();

      const state = worker.getState();
      assert.equal(state.lastApi?.ok, false);
      assert.equal(state.lastApi?.status, 401);
      assert.ok(logs.some((l) => l.level === 'error' && l.msg.includes('凭证被拒绝 (401)')));
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('心跳被拒绝时触发 onHeartbeatRejected 警告日志', async () => {
    const { deps, logs } = createMockDeps();
    const worker = new ServerWorker(deps);

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ ok: false, error: 'job_not_active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const transport = (worker.runtime as any).deps.transport;
      const ok = await transport.heartbeat('dummy_token', {
        jobId: 'j-hb',
        playedMs: 10000,
        positionMs: 10000,
        durationMs: 60000,
        monotonic: true,
      });

      assert.equal(ok, false);
      assert.ok(
        logs.some(
          (l) => l.level === 'warn' && l.msg.includes('心跳未获确认：job_not_active（任务 j-hb）')
        )
      );
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('ServerWorker.start 启动条件与 stop 停机清理', async () => {
    // 1. 禁用服务时不执行 runtime.start
    const { deps: depsDisabled } = createMockDeps({
      config: {
        id: 's-dis',
        name: '禁用服务',
        baseUrl: 'https://mock.server',
        clientKey: 'mh_ck_test',
        enabled: false,
      },
    });
    const workerDisabled = new ServerWorker(depsDisabled);
    let startCalled = false;
    workerDisabled.runtime.start = async () => {
      startCalled = true;
    };
    await workerDisabled.start();
    assert.equal(startCalled, false);
    await workerDisabled.stop();

    // 2. 空 key 服务时不执行 runtime.start
    const { deps: depsEmptyKey } = createMockDeps({
      config: {
        id: 's-empty',
        name: '空Key服务',
        baseUrl: 'https://mock.server',
        clientKey: '   ',
        enabled: true,
      },
    });
    const workerEmpty = new ServerWorker(depsEmptyKey);
    startCalled = false;
    workerEmpty.runtime.start = async () => {
      startCalled = true;
    };
    await workerEmpty.start();
    assert.equal(startCalled, false);
    await workerEmpty.stop();

    // 3. 正常配置执行 runtime.start
    const { deps: depsNormal } = createMockDeps();
    const workerNormal = new ServerWorker(depsNormal);
    startCalled = false;
    let autostartArg: boolean | null = null;
    workerNormal.runtime.start = async (autostart) => {
      startCalled = true;
      autostartArg = autostart;
    };
    await workerNormal.start();
    assert.equal(startCalled, true);
    assert.equal(autostartArg, true);

    // 4. stop 时若持有 turn 则释放，并调用 suspend
    let suspendCalled = false;
    let suspendReason = '';
    workerNormal.runtime.suspend = async (reason) => {
      suspendCalled = true;
      suspendReason = reason;
    };
    await workerNormal.stop();
    assert.equal(suspendCalled, true);
    assert.equal(suspendReason, 'worker_stopped');
  });

  test('Scheduler 动态感知 logged_out 状态与冷却同步', async () => {
    const scheduler = new MultiServerScheduler();
    const { deps } = createMockDeps({ scheduler });
    const worker = new ServerWorker(deps);

    // 初始状态 eligible 应为 true
    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');
    t1.release('settled');

    // 触发 auth:status 为 logged_out
    worker.runtime.bus.emit('auth:status', 'logged_out');
    assert.equal(worker.getState().authStatus, 'logged_out');

    // 调度器此时感知到 eligible: false，不再为其分配 turn
    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2, null);

    // 重新变为 valid
    worker.runtime.bus.emit('auth:status', 'valid');
    const t3 = await scheduler.requestNextTurn();
    assert.equal(t3?.serverId, 's1');
    t3.release('settled');

    // 调度器设置冷却后 getState 实时感知
    scheduler.setCooldown('s1', 5000);
    const state = worker.getState();
    assert.ok(state.cooldownUntil > Date.now());

    await worker.stop();
  });

  test('ServerWorker 支持自定义 onHeartbeatRejected 委托回调', async () => {
    const rejections: Array<{ jobId: string; status: number; error: string }> = [];
    const { deps } = createMockDeps({
      onHeartbeatRejected: (f) => {
        rejections.push(f);
      },
    });
    const worker = new ServerWorker(deps);

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ ok: false, error: 'job_not_active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const transport = worker.transport;
      const ok = await transport.heartbeat('dummy_token', {
        jobId: 'j-custom',
        playedMs: 1000,
      });

      assert.equal(ok, false);
      assert.equal(rejections.length, 1);
      assert.equal(rejections[0].jobId, 'j-custom');
      assert.equal(rejections[0].error, 'job_not_active');
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('ServerWorker 支持 extraHeaders 透传至 API 请求头', async () => {
    let capturedVipType = '';
    const { deps } = createMockDeps({
      extraHeaders: () => ({ 'X-Vip-Type': '11' }),
    });
    const worker = new ServerWorker(deps);

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, init) => {
        const headers = new Headers(init?.headers);
        capturedVipType = headers.get('X-Vip-Type') || '';
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const transport = worker.transport;
      await transport.me();
      assert.equal(capturedVipType, '11');
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });

  test('ServerWorker.getState 动态同步可变配置（名称、启闭状态、密钥）', async () => {
    const { deps } = createMockDeps();
    const worker = new ServerWorker(deps);

    assert.equal(worker.getState().name, '测试主服');
    assert.equal(worker.getState().enabled, true);
    assert.equal(worker.getState().configured, true);

    // 修改可变字段（模拟 reconcileWorkers 热修改 existing.config）
    deps.config.name = '新服名';
    deps.config.enabled = false;
    deps.config.clientKey = '   ';

    const updated = worker.getState();
    assert.equal(updated.name, '新服名');
    assert.equal(updated.enabled, false);
    assert.equal(updated.configured, false);

    await worker.stop();
  });

  test('ServerWorker.stop 时自动注销 player.onProgress 监听器', async () => {
    let unregisterCalled = false;
    const { deps } = createMockDeps({
      player: {
        play: async () => true,
        stop: async () => {},
        onProgress: () => () => {
          unregisterCalled = true;
        },
      },
    });
    const worker = new ServerWorker(deps);
    assert.equal(unregisterCalled, false);

    await worker.stop();
    assert.equal(unregisterCalled, true);
  });

  test('从服务端下发的 participant 动态解析真实限额与余额，不写死固定值', async () => {
    const { deps } = createMockDeps();
    const worker = new ServerWorker(deps);

    // 初始应为未获取状态 (null)
    assert.equal(worker.getState().helpLimit, null);
    assert.equal(worker.getState().recvLimit, null);

    // 模拟服务端响应包含自定义限额（例如帮听限额 18000s，被助 50次，余额 88.5，用户 TestUser）
    worker.updateLimitsAndAccount({
      participant: {
        help_seconds_limit: 18000,
        help_seconds_used: 3500,
        today_received_limit: 50,
        received_finished_count_24h: 12,
        available_credits: 88.5,
      },
      user: {
        displayName: 'TestUser',
      },
    });

    const state = worker.getState();
    assert.equal(state.helpLimit, 18000);
    assert.equal(state.helpUsed, 3500);
    assert.equal(state.recvLimit, 50);
    assert.equal(state.recv, 12);
    assert.equal(state.credits, 88.5);
    assert.equal(state.acctName, 'TestUser');

    await worker.stop();
  });

  test('ServerWorker 默认客户端版本为 4.6.11，且启动时预探测服务端版本并输出提示日志', async () => {
    const { deps, logs } = createMockDeps({ clientVersion: '' });
    const worker = new ServerWorker(deps);
    assert.equal((worker as any).clientVersion, '4.6.11');

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('/api/client-version')) {
          return new Response(JSON.stringify({ ok: true, version: '4.6.15', minVersion: '4.6.15' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      let versionAtStart = '';
      worker.runtime.start = async () => {
        versionAtStart = (worker as any).clientVersion;
      };

      await worker.start();
      assert.equal(versionAtStart, '4.6.15');
      assert.equal((worker as any).clientVersion, '4.6.15');

      const infoLog = logs.find((l) => l.level === 'info' && l.msg.includes('成功探测') && l.msg.includes('4.6.15'));
      assert.ok(infoLog, '预探测成功应输出 info 级提示日志');
    } finally {
      globalThis.fetch = origFetch;
      await worker.stop();
    }
  });
});
