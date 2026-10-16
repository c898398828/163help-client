import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '../dist/runner.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const cleanEnd = { ended: true, playbackRate: 1, jumpCount: 0, backwardJumpCount: 0, listenDriftMs: 0, stallDetected: false };

async function boot(t: TestContext, options: { next?: Record<string, unknown>; finish?: () => Promise<any> } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  let progress: (...args: any[]) => void = () => {};
  let meReply = async (): Promise<any> => ({ status: 200, payload: {} });
  const calls = { next: 0, play: 0, stop: 0, me: 0, heartbeat: 0, finish: [] as any[], abandon: [] as any[] };
  const settled: any[] = [], logs: any[] = [];
  const runtime = new ClientRuntime({
    adapter: { clientType: 'docker', version: 'test', hasPage: false, probeNetwork: async () => true,
      storage: { getToken: () => 'mh_ck_test', setToken() {}, clearToken() {}, getExpires: () => 0, setExpires() {} } },
    transport: {
      next: async () => ({ status: 200, payload: { jobId: `job-${++calls.next}`, musicId: 'song:same', targetDurationMs: 60_000, ...options.next } }),
      finish: async (_token, input) => { calls.finish.push(input); return options.finish ? options.finish() : { status: 200, payload: { ok: true } }; },
      abandon: async (_token, reason, detail, jobId) => { calls.abandon.push({ reason, detail, jobId }); },
      heartbeat: async () => { calls.heartbeat++; return true; },
      me: async () => { calls.me++; return meReply(); },
      refresh: async () => null, canRefresh: false, sendLog: async () => {},
    },
    player: { play: async () => { calls.play++; return true; }, stop: () => { calls.stop++; }, onProgress: cb => { progress = cb; } },
  });
  runtime.bus.on('job:settled', value => settled.push(value));
  runtime.bus.on('log:append', value => logs.push(value));
  t.after(() => runtime.stop());
  await runtime.start(true);
  await flush();
  return { runtime, calls, settled, logs, progress: (...args: any[]) => progress(...args), setMe: (reply: typeof meReply) => { meReply = reply; } };
}

for (const code of ['job_not_active', 'job_expired']) {
  test(`${code} after a long listen keeps claiming instead of freezing the client`, async t => {
    const h = await boot(t, { next: { targetDurationMs: 310_000 }, finish: async () => ({ status: 409, payload: null, error: code }) });
    for (let second = 1; second <= 310; second++) {
      t.mock.timers.tick(1000);
      h.progress(second * 1000, second * 1000, 320_000);
      await flush();
    }
    assert.equal(h.calls.finish.length, 1);
    assert.equal(h.settled.length, 0, 'an expired task must not be reported as credited');
    assert.ok(h.logs.some(value => value.event === 'settle_failed' && value.msg.includes(code)));
    // 服务端拒绝长曲结算是它自己的期限问题：客户端不能因此停下等人工干预，
    // 否则短曲（能正常结算）也一起被饿死。
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.calls.next, 2, '结算被拒后必须继续领下一单');
    assert.equal(h.calls.play, 2, '必须继续播放下一单');
  });
}

test('consecutive terminal rejections are counted in the log so the pattern is visible', async t => {
  const h = await boot(t, { finish: async () => ({ status: 409, payload: null, error: 'job_not_active' }) });
  const settleLogs = () => h.logs.filter(value => value.event === 'settle_failed');
  for (let round = 1; round <= 2; round++) {
    h.progress(60_000, 60_000, 60_000);
    await flush();
    t.mock.timers.tick(3000);
    await flush();
  }
  assert.equal(settleLogs().length, 2);
  assert.doesNotMatch(settleLogs()[0].msg, /连续/, '首单被拒不算「连续」');
  assert.match(settleLogs()[1].msg, /连续 2 单/);
});

test('a confirmed settle resets the consecutive rejection count', async t => {
  let reject = true;
  const h = await boot(t, { finish: async () => reject ? { status: 409, payload: null, error: 'job_not_active' } : { status: 200, payload: { ok: true } } });
  const settleLogs = () => h.logs.filter(value => value.event === 'settle_failed');
  const playOneJob = async () => { h.progress(60_000, 60_000, 60_000); await flush(); t.mock.timers.tick(3000); await flush(); };
  await playOneJob();
  await playOneJob();
  assert.match(settleLogs()[1].msg, /连续 2 单/);
  reject = false;
  await playOneJob();
  assert.equal(h.settled.length, 1);
  reject = true;
  await playOneJob();
  assert.equal(settleLogs().length, 3);
  assert.doesNotMatch(settleLogs()[2].msg, /连续/, '成功结算后重新从 1 开始计数');
});

test('a pending start cannot undo a later stop', async t => {
  const h = await boot(t);
  let resolveMe!: (value: any) => void;
  h.setMe(() => new Promise(resolve => { resolveMe = resolve; }));
  const pendingStart = h.runtime.start(true);
  await flush();
  h.runtime.stop();
  await flush();
  resolveMe({ status: 200, payload: {} });
  await pendingStart;
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(h.calls.next, 1);
});

for (const response of [{ status: 0, payload: null, error: 'network_error' }, { status: 503, payload: null, error: 'unavailable' }]) {
  test(`transient finish failure ${response.status} keeps claiming`, async t => {
    const h = await boot(t, { finish: async () => response });
    h.progress(60_000, 60_000, 60_000);
    await flush();
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(h.calls.next, 2);
    assert.equal(h.settled.length, 0);
  });
}

test('a source that ends far before the required listen is abandoned, never submitted as successful playback', async t => {
  const h = await boot(t, { next: { targetDurationMs: 600_000 } });
  h.progress(239_995, 240_000, 240_000, { ended: true });
  await flush();
  assert.equal(h.calls.finish.length, 0);
  assert.equal(h.settled.length, 0);
  assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
  assert.equal(h.calls.abandon[0]?.jobId, 'job-1');
  assert.match(h.calls.abandon[0]?.detail, /240s.*600s/);
});

test('explicit requiredListenMs takes precedence over ratio without causing early settlement', async t => {
  const h = await boot(t, { next: { targetDurationMs: 120_000, requiredListenMs: 30_000, requiredListenRatio: 0.9 } });
  h.progress(30_000, 30_000, 120_000, { ended: false });
  await flush();
  assert.equal(h.calls.finish.length, 0, 'the minimum listen alone is not the song completion signal');
  h.progress(30_000, 30_000, 30_000, { ended: true });
  await flush();
  assert.equal(h.calls.finish.length, 1);
  assert.equal(h.calls.abandon.length, 0);
});

test('required ratio uses the expected full duration so a short preview cannot lower the minimum', async t => {
  const h = await boot(t, { next: { targetDurationMs: 120_000, requiredListenRatio: 0.75 } });
  h.progress(30_000, 30_000, 30_000, { ended: true });
  await flush();
  assert.equal(h.calls.finish.length, 0);
  assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
  assert.match(h.calls.abandon[0]?.detail, /90s/);
});

for (const requirement of [{ requiredListenMs: 60_000 }, { requiredListenRatio: 1 }]) {
  test(`explicit minimum is not reduced without complete clean end evidence: ${JSON.stringify(requirement)}`, async t => {
    const h = await boot(t, { next: requirement });
    h.progress(59_999, 60_000, 60_000, { ended: true });
    await flush();
    assert.equal(h.calls.finish.length, 0);
    assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
  });
  test(`normal 1x full-song end with a tiny sampling gap respects the legacy tolerance: ${JSON.stringify(requirement)}`, async t => {
    const h = await boot(t, { next: requirement });
    h.progress(59_999, 60_000, 60_000, { ...cleanEnd, listenDriftMs: 1 });
    await flush();
    assert.equal(h.calls.finish.length, 1);
    assert.equal(h.calls.finish[0].playedMs, 59_999);
  });
}

test('without an explicit minimum, a normal final sampling gap within 5s can settle with the actual listened value', async t => {
  const h = await boot(t);
  h.progress(59_995, 60_000, 60_000, { ...cleanEnd, listenDriftMs: 5 });
  await flush();
  assert.equal(h.calls.finish.length, 1);
  assert.equal(h.calls.finish[0].playedMs, 59_995, 'do not fabricate the missing milliseconds');
});

for (const anomalousEvidence of [{ jumpCount: 1 }, { backwardJumpCount: 1 }, { playbackRate: 1.1 }, { stallDetected: true }, { listenDriftMs: 6000 }]) {
  test(`a sampling tolerance cannot hide abnormal playback: ${JSON.stringify(anomalousEvidence)}`, async t => {
    const h = await boot(t, { next: { requiredListenMs: 60_000 } });
    h.progress(59_999, 60_000, 60_000, { ...cleanEnd, ...anomalousEvidence });
    await flush();
    assert.equal(h.calls.finish.length, 0);
    assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
  });
}

for (const playedMs of [0, 1, 4000]) {
  test(`a 5s job cannot be covered by the 5s maximum tolerance after only ${playedMs}ms`, async t => {
    const h = await boot(t, { next: { targetDurationMs: 5000, requiredListenMs: 5000 } });
    h.progress(playedMs, 5000, 5000, { ...cleanEnd, listenDriftMs: 5000 - playedMs });
    await flush();
    assert.equal(h.calls.finish.length, 0);
    assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
  });
}

test('a declared minimum above the full duration is not reduced by tolerance', async t => {
  const h = await boot(t, { next: { requiredListenMs: 60_001 } });
  h.progress(60_000, 60_000, 60_000, cleanEnd);
  await flush();
  assert.equal(h.calls.finish.length, 0);
  assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
});

test('a 30s preview for a 35s track cannot use the 5s maximum end tolerance', async t => {
  const h = await boot(t, { next: { targetDurationMs: 35_000 } });
  h.progress(30_000, 30_000, 30_000, cleanEnd);
  await flush();
  assert.equal(h.calls.finish.length, 0);
  assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
});

test('an explicit minimum above the expected duration is still respected', async t => {
  const h = await boot(t, { next: { requiredListenMs: 70_000 } });
  h.progress(60_000, 60_000, 80_000, { ended: false });
  await flush();
  assert.equal(h.calls.finish.length, 0);
  h.progress(65_000, 65_000, 65_000, { ended: true });
  await flush();
  assert.equal(h.calls.finish.length, 0);
  assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
});

test('explicit ended:false prevents legacy duration equality from inventing an end', async t => {
  const h = await boot(t);
  h.progress(30_000, 30_000, 30_000, { ended: false });
  await flush();
  assert.equal(h.calls.finish.length, 0);
  assert.equal(h.calls.abandon.length, 0);
  h.progress(30_000, 30_000, 30_000, { ended: true });
  await flush();
  assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
});

test('finish preserves observed playback evidence instead of replacing it with clean defaults', async t => {
  const h = await boot(t);
  h.progress(60_000, 62_000, 62_000, {
    ended: true, playbackRate: 1.25, jumpCount: 2, backwardJumpCount: 1, listenDriftMs: 2000, stallDetected: true,
  });
  await flush();
  assert.deepEqual(h.calls.finish[0], {
    jobId: 'job-1', playedMs: 60_000, positionMs: 62_000, durationMs: 62_000,
    playbackRate: 1.25, jumpCount: 2, backwardJumpCount: 1, listenDriftMs: 2000, stallDetected: true, recoveryAttempts: 0,
  });
});

for (const requiredListenMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid requiredListenMs ${requiredListenMs} falls back to a valid ratio`, async t => {
    const h = await boot(t, { next: { requiredListenMs, requiredListenRatio: 0.5 } });
    h.progress(30_000, 30_000, 30_000, { ended: true });
    await flush();
    assert.equal(h.calls.finish.length, 1);
  });
}

for (const requiredListenRatio of [0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid requiredListenRatio ${requiredListenRatio} cannot lower the expected listen`, async t => {
    const h = await boot(t, { next: { requiredListenRatio } });
    h.progress(30_000, 30_000, 30_000, { ended: true });
    await flush();
    assert.equal(h.calls.finish.length, 0);
    assert.equal(h.calls.abandon[0]?.reason, 'insufficient_playback');
  });
}
