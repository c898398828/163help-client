import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../dist/events.js';
import { HeartbeatEngine } from '../dist/heartbeat.js';
import { JobStateMachine } from '../dist/dispatch.js';
import { ClientRuntime } from '../dist/runner.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const adapter = () => {
  let token = 'mh_ck_test';
  return { clientType: 'docker', version: '5.1', hasPage: false, probeNetwork: async () => true,
    storage: { getToken: () => token, setToken: t => { token = t; }, clearToken: () => {}, getExpires: () => 0, setExpires: () => {} } };
};

function heart(t, heartbeat) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  const bus = new EventBus();
  const ticks = [], abandoned = [];
  bus.on('heartbeat:tick', e => ticks.push(e));
  const engine = new HeartbeatEngine(bus, { heartbeat }, adapter(), {
    onAbandon: (reason, detail) => abandoned.push({ reason, detail }), onResume: () => {},
  });
  t.after(() => engine.stop());
  return { engine, ticks, abandoned };
}

test('late heartbeat ACK from A cannot acknowledge B or disable B first-heartbeat timeout', async t => {
  const pending = deferred();
  const { engine, ticks, abandoned } = heart(t, () => pending.promise);
  engine.start('a');
  const sent = engine.pulse(1000, 1000, 60000);
  engine.start('b');
  pending.resolve(true); await sent;
  assert.equal(ticks.length, 0, 'old acknowledgement must be discarded');
  t.mock.timers.tick(30000); await flush();
  assert.equal(abandoned.length, 1);
});

test('slow heartbeat request is single-flight and rejection is handled', async t => {
  const pending = deferred(); let sends = 0;
  const { engine, ticks } = heart(t, () => { sends++; return pending.promise; });
  engine.start('a');
  const first = engine.pulse(1000, 1000, 60000);
  const second = engine.pulse(2000, 2000, 60000);
  assert.equal(sends, 1, 'two in-flight requests must not race');
  pending.resolve(true); await Promise.all([first, second]);
  assert.equal(ticks.length, 1);
});

test('stale playback snapshot cannot send successful heartbeats forever', async t => {
  const { engine, abandoned } = heart(t, async () => true);
  engine.start('a'); engine.update(1000, 1000, 60000);
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(10000); await flush(); }
  assert.equal(abandoned.length, 1, 'missing player samples must expire even if HTTP succeeds');
});

function dispatch(finish) {
  const bus = new EventBus(), settled = [], abandons = [];
  bus.on('job:settled', e => settled.push(e));
  const machine = new JobStateMachine({
    next: async () => ({ status: 200, payload: { jobId: 'j1', musicId: 'song:1', targetDurationMs: 300000 } }),
    finish, abandon: async (...a) => { abandons.push(a); }, onPlaying: () => {}, onSettleFailed: () => {},
  }, bus);
  return { machine, settled, abandons };
}

test('finish and abandon are mutually exclusive for the same task', async () => {
  const pending = deferred();
  const { machine, abandons } = dispatch(() => pending.promise);
  await machine.fetchNext();
  const submitted = machine.submitFinish({ jobId: 'j1' });
  await machine.abandon('heartbeat_lost', 'late timer');
  assert.equal(abandons.length, 0, 'must not cancel a task whose finish is in flight');
  pending.resolve({ status: 200, payload: { ok: true } }); await submitted;
});

test('HTTP 200 without a success payload is not a settled task', async () => {
  for (const payload of [null, { ok: false, error: 'rejected' }]) {
    const { machine, settled } = dispatch(async () => ({ status: 200, payload }));
    await machine.fetchNext();
    assert.notEqual(await machine.submitFinish({ jobId: 'j1' }), 'settled');
    assert.equal(settled.length, 0);
  }
});

test('only acknowledged successful finishes emit job:settled; abandon includes jobId', async () => {
  const { machine, settled, abandons } = dispatch(async () => ({ status: 200, payload: { ok: true } }));
  await machine.fetchNext(); await machine.abandon('playback_stalled', 'test');
  assert.equal(settled.length, 0);
  assert.equal(abandons[0][2], 'j1');
  await machine.fetchNext(); await machine.submitFinish({ jobId: 'j1' });
  assert.equal(settled.length, 1);
});

test('rejected finish reports played/target seconds so 409 job_not_active can be diagnosed', async () => {
  const bus = new EventBus(), failed = [];
  const machine = new JobStateMachine({
    next: async () => ({ status: 200, payload: { jobId: 'j1', musicId: 'song:1', targetDurationMs: 300000 } }),
    finish: async () => ({ status: 409, payload: null, error: 'job_not_active' }),
    abandon: async () => {}, onPlaying: () => {},
    onSettleFailed: (code, msg) => failed.push({ code, msg }),
  }, bus);
  await machine.fetchNext();
  assert.equal(await machine.submitFinish({ jobId: 'j1', playedMs: 309000 }), 'rejected');
  assert.equal(failed[0].code, 'job_not_active');
  assert.match(failed[0].msg, /job_not_active/);
  assert.match(failed[0].msg, /309s/);
  assert.match(failed[0].msg, /目标 300s/);
});

function runtime(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  const snapshots = [], limits = [], calls = { me: 0, next: 0 };
  let used = 100, status = 200;
  const r = new ClientRuntime({ adapter: adapter(), transport: {
    me: async () => { calls.me++; return { status, payload: status === 200 ? { user: { displayName: 'test' }, participant: { help_seconds_used: used, help_seconds_limit: 8940, available_credits: 86 } } : null }; },
    next: async () => { calls.next++; return options.next ? options.next() : { status: 200, payload: { musicId: null, noTargetReason: 'empty' } }; },
    finish: async () => ({ status: 200, payload: { ok: true } }), abandon: options.abandon ?? (async () => {}), heartbeat: async () => true,
    refresh: async () => null, canRefresh: false, sendLog: async () => {},
  }, player: { play: async () => true, stop: options.stop ?? (() => {}), onProgress: () => {} } });
  r.bus.on('auth:user', e => snapshots.push(e)); r.bus.on('limits:updated', e => limits.push(e));
  t.after(() => r.stop());
  return { r, calls, snapshots, limits, setUsed: v => { used = v; }, setStatus: v => { status = v; } };
}

test('statistics keep syncing during idle and stop polling after stop()', async t => {
  const h = runtime(t); await h.r.start(true); await flush();
  h.setUsed(678);
  for (let i = 0; i < 7; i++) { t.mock.timers.tick(10000); await flush(); }
  assert.equal(h.limits.at(-1).helpedToday, 678);
  h.r.stop(); const before = h.calls.me;
  t.mock.timers.tick(120000); await flush();
  assert.equal(h.calls.me, before);
});

test('suspend waits for asynchronous player shutdown before resolving', async t => {
  const stopped = deferred();
  const h = runtime(t, { stop: () => stopped.promise });
  await h.r.start(true); await flush();
  let done = false;
  const pending = h.r.suspend('config_changed').then(() => { done = true; });
  await flush(); assert.equal(done, false);
  stopped.resolve(); await pending;
  assert.equal(done, true);
});

test('suspend waits for an outstanding claim and abandons it before config changes', async t => {
  const claim = deferred(), abandoned = [];
  const h = runtime(t, { next: () => claim.promise, abandon: async (...args) => abandoned.push(args) });
  await h.r.start(true); await flush();
  let drained = false;
  const suspension = h.r.suspend('config_changed').then(() => { drained = true; });
  await flush(); assert.equal(drained, false);
  claim.resolve({ status: 200, payload: { jobId: 'old-job', musicId: 'song:1', targetDurationMs: 300000 } });
  await suspension;
  assert.equal(h.r.job.current, null);
  assert.equal(h.r.heart.job, '');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0][3], 'old-job');
});

test('accepting a new session resumes a previously stopped runtime', async t => {
  const h = runtime(t);
  const session = { token: 't1', access_expires_at: '2030-01-01', refresh_expires_at: '2030-01-01' };
  h.r.acceptSession(session); await flush();
  assert.equal(h.calls.next, 1);
  h.r.stop(); await flush();
  h.r.acceptSession({ ...session, token: 't2' }); await flush();
  assert.equal(h.calls.next, 2);
});

test('successful /me revalidation clears logged_out and resumes tasks', async t => {
  const h = runtime(t);
  h.r.auth.clearSession();
  assert.equal(h.r.auth.status, 'logged_out');
  await h.r.start(true); await flush();
  assert.equal(h.r.auth.status, 'valid');
  assert.equal(h.calls.next, 1);
});
