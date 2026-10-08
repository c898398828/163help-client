import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '../dist/runner.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: (value?: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function boot(t: any, options: { play?: () => Promise<any>; stop?: () => Promise<void>; finish?: () => Promise<any> } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  let progress: (played: number, position: number, duration: number) => void = () => {};
  const calls = { next: 0, stop: 0, abandon: 0, finish: [] as any[], heartbeat: [] as any[] };
  const logs: any[] = [], reported: any[] = [];
  const runtime = new ClientRuntime({
    adapter: { clientType: 'docker', version: '5.1', hasPage: false, probeNetwork: async () => true,
      storage: { getToken: () => 'mh_ck_test', setToken() {}, clearToken() {}, getExpires: () => 0, setExpires() {} } },
    transport: {
      next: async () => ({ status: 200, payload: ++calls.next === 1
        ? { jobId: 'long-job', musicId: 'song:3399467678', targetDurationMs: 310000 } : { musicId: null } }),
      finish: async (_token, input) => { calls.finish.push(input); return options.finish ? options.finish() : { status: 200, payload: { ok: true } }; },
      abandon: async () => { calls.abandon++; },
      heartbeat: async (_token, input) => { calls.heartbeat.push(input); return true; },
      me: async () => ({ status: 200, payload: {} }), refresh: async () => null, canRefresh: false,
      sendLog: async (p) => { reported.push(p); },
    },
    player: {
      play: options.play ?? (async () => ({ ok: true })),
      stop: async () => { calls.stop++; await options.stop?.(); },
      onProgress: (cb) => { progress = cb; },
    },
  });
  runtime.bus.on('log:append', (p) => logs.push(p));
  t.after(() => runtime.stop());
  await runtime.start(true);
  await flush();
  return { runtime, calls, logs, reported, progress: (ms: number) => progress(ms, ms, 320000) };
}

test('起播恢复成功记录次数，结算保留真实恢复次数', async (t) => {
  const h = await boot(t, { play: async () => ({ ok: true, attempts: 2 }) });
  assert.equal(h.calls.abandon, 0);
  assert.ok(h.logs.some((p) => p.event === 'playback_recovered' && /2/.test(p.msg)));
  h.progress(310000);
  await flush();
  assert.equal(h.calls.finish.length, 1);
  assert.equal(h.calls.finish[0].recoveryAttempts, 1);
});

test('旧起播的迟到恢复成功不记录到新生命周期', async (t) => {
  const pending = deferred();
  const h = await boot(t, { play: () => pending.promise });
  await h.runtime.suspend('test_pause');
  pending.resolve({ ok: true, attempts: 2 });
  await flush();
  assert.equal(h.logs.some((p) => p.event === 'playback_recovered'), false);
});

test('起播失败必须等播放器停止后再领取下一单', async (t) => {
  const stopped = deferred();
  const h = await boot(t, { play: async () => ({ ok: false, err: 'audio failed' }), stop: () => stopped.promise });
  assert.equal(h.calls.stop, 1);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(h.calls.next, 1, '停止未完成不能接新任务');
  stopped.resolve();
  await flush();
  assert.equal(h.calls.next, 2);
});

for (const outcome of ['false', 'reject'] as const) {
  test(`结算停止音频导致未完成起播返回 ${outcome} 时，不得再放弃本单`, async (t) => {
    const pendingPlay = deferred(), pendingStop = deferred();
    const h = await boot(t, {
      play: () => pendingPlay.promise,
      stop: () => {
        if (outcome === 'false') pendingPlay.resolve({ ok: false, err: 'play interrupted by stop' });
        else pendingPlay.reject(new Error('play interrupted by stop'));
        return pendingStop.promise;
      },
    });
    h.progress(310000);
    await flush();
    assert.equal(h.calls.abandon, 0);
    assert.equal(h.calls.stop, 1);
    assert.equal(h.calls.finish.length, 0, '结算仍在等待播放器停止');
    pendingStop.resolve();
    await flush();
    assert.equal(h.calls.finish.length, 1, '达到目标的任务必须走原结算');
    assert.equal(h.calls.abandon, 0);
  });
}

test('310秒后拒绝结算保留任务ID、运行时长和最后有效心跳，不能报入账', async (t) => {
  const h = await boot(t, { finish: async () => ({ status: 409, payload: null, error: 'job_not_active' }) });
  let credited = 0;
  h.runtime.bus.on('job:settled', () => { credited++; });
  for (let second = 1; second <= 310; second++) {
    t.mock.timers.tick(1000);
    h.progress(second * 1000);
    await flush();
  }
  assert.equal(h.calls.finish.length, 1);
  assert.equal(h.calls.abandon, 0);
  assert.equal(credited, 0);
  const failure = h.reported.find((p) => p.event === 'settle_failed');
  assert.ok(failure);
  assert.match(failure.msg, /long-job/);
  assert.match(failure.msg, /job_not_active/);
  assert.equal(failure.context.jobId, 'long-job');
  assert.equal(failure.context.elapsedMs, 310000);
  assert.ok(failure.context.heartbeatAcks >= 30);
  assert.ok(failure.context.lastHeartbeatAgeMs >= 0 && failure.context.lastHeartbeatAgeMs <= 10000);
});
