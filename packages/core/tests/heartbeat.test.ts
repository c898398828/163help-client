import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { hbState, HeartbeatEngine } from '../dist/heartbeat.js';
import { EventBus } from '../dist/events.js';
import type { HeartbeatInput } from '../dist/types.js';

describe('hbState（心跳判定纯函数）', () => {
  test('lastAt=0（无首心跳）→ ok（由 grace 窗口单独判定）', () => {
    assert.equal(hbState(0, Date.now(), 45000), 'ok');
  });
  test('距上次心跳 > stall → stall（触发 heartbeat_lost 放弃）', () => {
    const last = 1000;
    assert.equal(hbState(last, last + 2000, 45000), 'ok');
    assert.equal(hbState(last, last + 46000, 45000), 'stall');
  });
  test('边界：恰好等于 stall 不算超时', () => {
    const last = 1000;
    assert.equal(hbState(last, last + 45000, 45000), 'ok');
  });
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function makeEngine(t: TestContext, reply: (input: HeartbeatInput) => Promise<boolean> = async () => true) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const sent: Array<HeartbeatInput & { at: number }> = [];
  const abandoned: string[] = [];
  const acknowledged: string[] = [];
  const bus = new EventBus();
  bus.on('heartbeat:tick', input => acknowledged.push(input.jobId));
  const engine = new HeartbeatEngine(bus, {
    heartbeat: async (input) => { sent.push({ at: Date.now(), ...input }); return reply(input); },
  }, {} as never, { onAbandon: reason => abandoned.push(reason), onResume: () => {} });
  t.after(() => engine.stop());
  return { engine, sent, abandoned, acknowledged };
}

test('起播接近 20s、首次正进度落在 20s tick 后，仍应在 30s 宽限期内确认首心跳', async (t) => {
  const { engine, sent, abandoned } = makeEngine(t);
  engine.start('slow-start');
  t.mock.timers.tick(19_500);
  engine.update(0, 0, 60_000); // 播放命令刚成功，尚无真实进度。
  t.mock.timers.tick(1_000); // 错过领取后的 20s 定时上报。
  engine.update(1_000, 1_000, 60_000);
  await flush();
  t.mock.timers.tick(9_500); // 到达 30s，grace timer 比同刻的 interval 先注册。
  await flush();

  assert.deepEqual(abandoned, [], '已有真实播放进度时，不应因等待下一个定时 tick 被判起播失败');
  assert.equal(sent[0]?.at, 20_500, '首个正进度应立即上报');
  assert.equal(sent[0]?.playedMs, 1_000, '只上报播放器实际提供的进度');
});

test('9.999s 首发后取消原 10s tick，后续心跳从首发时刻起每 10s 上报', async (t) => {
  const { engine, sent } = makeEngine(t);
  engine.start('near-tick');
  t.mock.timers.tick(9_999);
  engine.update(1_000, 1_000, 60_000);
  await flush();
  assert.deepEqual(sent.map(input => input.at), [9_999]);

  t.mock.timers.tick(1); // 领取后 10s：距首心跳只有 1ms。
  await flush();
  assert.equal(sent.length, 1, '原来的定时刻不得紧接首心跳再次上报');
  engine.update(2_000, 2_000, 60_000); // 后续采样也不能重置定时节奏。
  t.mock.timers.tick(9_998);
  await flush();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(sent.map(input => input.at), [9_999, 19_999]);
  assert.equal(sent[1]?.playedMs, 2_000);
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(sent.map(input => input.at), [9_999, 19_999, 29_999]);
});

test('从首次尝试重新计时不延长领取后 30s 的首心跳确认宽限期', async (t) => {
  const { engine, sent, abandoned } = makeEngine(t, async () => false);
  engine.start('late-rejection');
  t.mock.timers.tick(20_500);
  engine.update(1_000, 1_000, 60_000);
  await flush();
  t.mock.timers.tick(9_499);
  await flush();
  assert.deepEqual(abandoned, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(sent.map(input => input.at), [20_500]);
  assert.deepEqual(abandoned, ['play_start_fail'], '宽限期必须仍从领单开始计算');
});

test('零进度和无效采样不发首心跳，宽限期到达后只放弃一次', async (t) => {
  const { engine, sent, abandoned } = makeEngine(t);
  engine.start('not-playing');
  engine.update(0, 0, 60_000);
  engine.update(-1, 0, 60_000);
  engine.update(Number.NaN, 1_000, 60_000);
  engine.update(1_000, Number.POSITIVE_INFINITY, 60_000);
  t.mock.timers.tick(30_000);
  await flush();
  engine.update(1_000, 1_000, 60_000); // 已停止后到达的采样不能恢复旧任务。
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(sent.length, 0);
  assert.deepEqual(abandoned, ['play_start_fail']);
});

test('首心跳被拒或网络失败后，每秒采样不会高频重试，仍仅在 10s tick 重试', async (t) => {
  let attempts = 0;
  const { engine, sent, acknowledged, abandoned } = makeEngine(t, async () => {
    attempts++;
    if (attempts === 1) return false;
    if (attempts === 2) throw new Error('transient network failure');
    return true;
  });
  engine.start('retry');
  engine.update(1_000, 1_000, 60_000);
  await flush();
  for (let i = 1; i <= 20; i++) {
    t.mock.timers.tick(1_000);
    engine.update((i + 1) * 1_000, (i + 1) * 1_000, 60_000);
    await flush();
    assert.equal(sent.length, 1 + Math.floor(i / 10), '失败不能把每秒采样变成每秒重试');
  }
  assert.deepEqual(sent.map(input => input.at), [0, 10_000, 20_000]);
  assert.deepEqual(acknowledged, ['retry']);
  assert.deepEqual(abandoned, []);
});

test('即时首心跳仍为 single-flight，旧任务 ACK 不会清除新任务在途请求或确认新任务', async (t) => {
  let resolveA!: (ok: boolean) => void;
  let resolveB!: (ok: boolean) => void;
  const pendingA = new Promise<boolean>(resolve => { resolveA = resolve; });
  const pendingB = new Promise<boolean>(resolve => { resolveB = resolve; });
  const { engine, sent, acknowledged } = makeEngine(t, input => input.jobId === 'a' ? pendingA : pendingB);
  engine.start('a');
  engine.update(1_000, 1_000, 60_000);
  engine.update(2_000, 2_000, 60_000);
  assert.equal(sent.length, 1);
  engine.start('b');
  engine.update(1_000, 1_000, 60_000);
  assert.equal(sent.length, 2, '新任务允许独立发出首心跳');
  resolveA(true);
  await flush();
  assert.deepEqual(acknowledged, [], '旧 ACK 不得被当成新任务确认');
  engine.update(2_000, 2_000, 60_000);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(sent.length, 2, '旧请求完成不得清空新任务的 single-flight 锁');
  resolveB(true);
  await flush();
  assert.deepEqual(acknowledged, ['b']);
});
