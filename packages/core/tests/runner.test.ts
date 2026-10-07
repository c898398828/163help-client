import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime, formatNoTarget } from '../dist/runner.js';

interface Harness {
  runtime: any;
  calls: { next: number; finish: any[]; abandon: any[]; play: Array<{ id: string; ms: number }>; heartbeat: any[] };
  busLogs: any[];
  fireProgress: (playedMs: number, positionMs: number, durationMs: number) => void;
  setNext: (p: unknown) => void;
  setPlayOk: (ok: boolean) => void;
  setNext401: (on: boolean) => void;
  setHbOk: (ok: boolean) => void;
  setNextThrow: (on: boolean) => void;
}

function makeHarness(opts: { token?: string; playOk?: boolean; next?: unknown; timing?: { idleMs?: number; noTargetMs?: number }; hbOk?: boolean } = {}): Harness {
  const calls = { next: 0, finish: [] as any[], abandon: [] as any[], play: [] as Array<{ id: string; ms: number }>, heartbeat: [] as any[] };
  let progressCb: (a: number, b: number, c: number) => void = () => {};
  let nextPayload: any = opts.next ?? { musicId: 'song:123', jobId: 'j1', targetDurationMs: 300_000, owner: { displayName: '甲' } };
  let playOk = opts.playOk ?? true;
  let next401 = false;
  let nextThrow = false;
  let hbOk = opts.hbOk ?? true;
  const token = opts.token ?? 'mh_ck_test';

  const adapter = {
    clientType: 'docker', version: '5.1',
    storage: {
      getToken: () => token, setToken: () => {}, clearToken: () => {},
      getExpires: () => 0, setExpires: () => {},
    },
    probeNetwork: async () => true, hasPage: false,
  };
  const transport = {
    next: async () => { calls.next += 1; if (nextThrow) throw new Error('fetch failed（ECONNRESET）'); if (next401) return { status: 401, payload: null }; return { status: 200, payload: nextPayload }; },
    finish: async (_t: string, input: any) => { calls.finish.push(input); return { status: 200, payload: { settled: true } }; },
    abandon: async (_t: string, reason: string, detail: string) => { calls.abandon.push({ reason, detail }); },
    heartbeat: async (_t: string, input: any) => { calls.heartbeat.push(input); return hbOk; },
    refresh: async () => null,
    me: async () => ({ status: 200, payload: { displayName: 'u', credits: 1 } }),
    sendLog: async () => {},
    canRefresh: false, // docker 端：key 凭证无 session refresh
  };
  const player = {
    play: async (id: string, ms: number) => { calls.play.push({ id, ms }); return playOk; },
    stop: () => {},
    onProgress: (cb: (a: number, b: number, c: number) => void) => { progressCb = cb; },
  };

  const runtime = new ClientRuntime({ adapter, transport, player, timing: opts.timing } as never);
  const busLogs: any[] = [];
  runtime.bus.on('log:append', (e: any) => busLogs.push(e));
  return {
    runtime, calls, busLogs,
    fireProgress: (a, b, c) => progressCb(a, b, c),
    setNext: (p) => { nextPayload = p; },
    setPlayOk: (ok) => { playOk = ok; },
    setNext401: (on) => { next401 = on; },
    setHbOk: (ok) => { hbOk = ok; },
    setNextThrow: (on) => { nextThrow = on; },
  };
}

/** 清理：先停心跳定时器（旧版本无 stop() 时也能退出），再停主循环 */
function cleanup(h: Harness): void {
  try { h.runtime.heart?.stop(); } catch { /* 忽略 */ }
  try { h.runtime.stop?.(); } catch { /* 旧版本无 stop() */ }
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ClientRuntime 主循环（docker 端关键路径）', () => {
  test('播放器收到 /next 的 musicId（owner 有名字时也不再传空串）', async () => {
    const h = makeHarness();
    try {
      await h.runtime.start(true);
      await tick();
      assert.equal(h.calls.play.length, 1);
      assert.equal(h.calls.play[0]!.id, 'song:123');
      assert.equal(h.calls.play[0]!.ms, 300_000);
    } finally { cleanup(h); }
  });

  test('播放达到目标时长 → 上报 finish 并回到空闲', async () => {
    const h = makeHarness();
    try {
      await h.runtime.start(true);
      await tick();
      h.fireProgress(300_000, 300_000, 320_000);
      await tick();
      assert.equal(h.calls.finish.length, 1);
      assert.equal(h.calls.finish[0]!.jobId, 'j1');
      assert.equal(h.calls.finish[0]!.playedMs, 300_000);
      assert.equal(h.runtime.job.current, null);
      assert.equal(h.runtime.job.phase, 'idle');
    } finally { cleanup(h); }
  });

  test('歌曲先于目标播完 → 也结算，避免永久卡单', async () => {
    const h = makeHarness({ next: { musicId: 'song:9', jobId: 'j9', targetDurationMs: 600_000, owner: { displayName: '乙' } } });
    try {
      await h.runtime.start(true);
      await tick();
      h.fireProgress(100, 100, 240_000); // 远未到目标：不结算
      await tick();
      assert.equal(h.calls.finish.length, 0);
      h.fireProgress(240_000, 240_000, 240_000); // 歌曲播完
      await tick();
      assert.equal(h.calls.finish.length, 1);
      assert.equal(h.calls.finish[0]!.jobId, 'j9');
    } finally { cleanup(h); }
  });

  test('达到目标后重复进度不会重复提交 finish', async () => {
    const h = makeHarness();
    try {
      await h.runtime.start(true);
      await tick();
      h.fireProgress(300_000, 300_000, 320_000);
      h.fireProgress(301_000, 301_000, 320_000);
      await tick();
      assert.equal(h.calls.finish.length, 1);
    } finally { cleanup(h); }
  });

  test('播放器加载失败 → abandon 本单并回到空闲（不卡单）', async () => {
    const h = makeHarness({ playOk: false });
    try {
      await h.runtime.start(true);
      await tick();
      assert.equal(h.calls.abandon.length, 1);
      assert.equal(h.calls.abandon[0]!.reason, 'play_start_fail');
      assert.equal(h.runtime.job.current, null);
    } finally { cleanup(h); }
  });

  test('无凭证时 start 不进入领单循环', async () => {
    const h = makeHarness({ token: '' });
    try {
      await h.runtime.start(true);
      await tick(80);
      assert.equal(h.calls.next, 0);
    } finally { cleanup(h); }
  });

  test('stop() 后主循环停止领单（3s 周期后不再请求）', async () => {
    const h = makeHarness();
    try {
      await h.runtime.start(true);
      await tick();
      assert.equal(h.calls.next, 1);
      h.runtime.stop();
      await tick(3_300);
      assert.equal(h.calls.next, 1);
    } finally { cleanup(h); }
  });

  test('领单日志包含歌曲 id 与目标时长（便于在管理端日志里看清在播什么）', async () => {
    const h = makeHarness();
    try {
      await h.runtime.start(true);
      await tick();
      const start = h.busLogs.find((e) => e.event === 'job_start');
      assert.ok(start, '应有 job_start 日志');
      assert.ok(String(start.msg).includes('song:123'), `日志应含歌曲 id：${start.msg}`);
      assert.ok(String(start.msg).includes('300s'), `日志应含目标时长：${start.msg}`);
    } finally { cleanup(h); }
  });

  test('密钥被服务端拒绝（401）→ 停止领单循环，不再每 3s 重试', async () => {
    const h = makeHarness();
    try {
      h.setNext401(true);
      await h.runtime.start(true);
      await tick(3_300);
      assert.equal(h.calls.next, 1);
      assert.ok(h.busLogs.some((e) => e.event === 'cycle_stop'), '应记录 cycle_stop 日志');
      assert.equal(h.runtime.auth.hasToken(), true); // 凭证保留，不清空
    } finally { cleanup(h); }
  });

  test('no_target 对象原因渲染为可读文案（不再 [object Object]）', async () => {
    const h = makeHarness({ next: { noTargetReason: { reason: 'resting', participants: 5, active: 2, withAvailableCredit: 1 } } });
    try {
      await h.runtime.start(true);
      await tick();
      const e = h.busLogs.find((x) => x.event === 'no_target');
      assert.ok(e, '应有 no_target 日志');
      assert.ok(!String(e.msg).includes('[object Object]'), `不应是 [object Object]：${e.msg}`);
      assert.ok(String(e.msg).includes('休息'), `应识别 resting：${e.msg}`);
    } finally { cleanup(h); }
  });

  test('no_target daily_limit → 提示今日上限', async () => {
    const h = makeHarness({ next: { noTargetReason: { reason: 'daily_limit' } } });
    try {
      await h.runtime.start(true);
      await tick();
      const e = h.busLogs.find((x) => x.event === 'no_target');
      assert.ok(e && String(e.msg).includes('上限'), `应提示上限：${e?.msg}`);
    } finally { cleanup(h); }
  });

  test('播放进度长时间不动（卡死）→ 放弃本单（playback_stalled），不再无限挂着', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const h = makeHarness();
    try {
      await h.runtime.start(true);
      await tick();
      h.fireProgress(180_000, 180_000, 299_000); // 已有进度
      await tick();
      t.mock.timers.tick(41_000); // 41s 无前移
      h.fireProgress(180_000, 180_000, 299_000);
      await tick();
      assert.equal(h.calls.abandon.length, 1);
      assert.equal(h.calls.abandon[0]!.reason, 'playback_stalled');
      assert.equal(h.runtime.job.current, null);
    } finally { cleanup(h); }
  });

  test('进度正常前移不会被误判卡死', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const h = makeHarness();
    try {
      await h.runtime.start(true);
      await tick();
      for (let i = 1; i <= 5; i++) {
        h.fireProgress(i * 30_000, i * 30_000, 299_000);
        await tick(2);
        t.mock.timers.tick(30_000);
      }
      assert.equal(h.calls.abandon.length, 0);
    } finally { cleanup(h); }
  });

  test('无单时按 noTargetMs 节奏重试（默认 30s，降低请求频率）', async () => {
    const h = makeHarness({ next: { noTargetReason: { reason: 'no_participants' } }, timing: { idleMs: 3000, noTargetMs: 100 } });
    try {
      await h.runtime.start(true);
      await tick(320);
      assert.ok(h.calls.next >= 2, `无单应快速重试（测试用 100ms）：${h.calls.next}`);
    } finally { cleanup(h); }
  });

  test('播放中不重复领单（idle 节奏，不受无单退避影响）', async () => {
    const h = makeHarness({ timing: { idleMs: 100, noTargetMs: 5000 } });
    try {
      await h.runtime.start(true);
      await tick(60);
      assert.equal(h.calls.next, 1, '播放中不应重复领单');
    } finally { cleanup(h); }
  });

  test('领单请求抛异常（网络重置）→ 状态必须回 idle，否则永远不再领单', async () => {
    const h = makeHarness({ timing: { idleMs: 50, noTargetMs: 50 } });
    try {
      h.setNextThrow(true);
      await h.runtime.start(true);
      await tick(30); // 只等到第一次请求发生
      assert.ok(h.calls.next >= 1);
      assert.equal(h.runtime.job.phase, 'idle', `异常后 phase 应回 idle，实际 ${h.runtime.job.phase}`);
      h.setNextThrow(false);
      const before = h.calls.next;
      await tick(200);
      assert.ok(h.calls.next > before, `应继续领单：${before} → ${h.calls.next}`);
    } finally { cleanup(h); }
  });
});

describe('心跳节奏与确认（协议：播放中每 10s 一次）', () => {
  test('播放进度每秒回调不会每秒上报；10s 间隔上报最近一次进度', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const h = makeHarness({ timing: { idleMs: 20, noTargetMs: 20 } });
    try {
      await h.runtime.start(true);
      await tick(20);
      for (let i = 1; i <= 5; i++) h.fireProgress(i * 1000, i * 1000, 300_000); // 播放器每秒回调一次 ×5
      await tick(20);
      assert.equal(h.calls.heartbeat.length, 0, '进度回调本身不应立刻上报（否则 1 秒 1 次 = 协议 10 倍）');
      t.mock.timers.tick(10_000);
      await tick(30);
      assert.equal(h.calls.heartbeat.length, 1, '10s 上报一次');
      assert.equal(h.calls.heartbeat[0]!.positionMs, 5000, '上报最近一次进度而非 0');
      t.mock.timers.tick(10_000);
      await tick(30);
      assert.equal(h.calls.heartbeat.length, 2, '再过 10s 再一次');
    } finally { cleanup(h); }
  });

  test('心跳被服务端拒绝 → 45s 后放弃本单（heartbeat_lost），不再假装一切正常', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const h = makeHarness({ timing: { idleMs: 20, noTargetMs: 20 } });
    try {
      await h.runtime.start(true);
      await tick(20);
      h.fireProgress(1000, 1000, 300_000);
      t.mock.timers.tick(10_000); // 第一次心跳：成功
      await tick(30);
      assert.equal(h.calls.heartbeat.length, 1);
      h.setHbOk(false); // 之后全部被拒（服务端 4xx / 无效）
      t.mock.timers.tick(60_000);
      await tick(60);
      assert.equal(h.calls.abandon.length, 1, '应放弃本单，避免「本地看着正常、服务端根本没收到」');
      assert.equal(h.calls.abandon[0]!.reason, 'heartbeat_lost');
    } finally { cleanup(h); }
  });
});

describe('formatNoTarget（无单原因渲染，对齐 4.x 文案）', () => {
  test('reason 文案表', () => {
    assert.ok(formatNoTarget({ reason: 'no_participants' }).includes('没人加入互助队列'));
    assert.ok(formatNoTarget({ reason: 'only_self' }).includes('只有你自己'));
    assert.ok(formatNoTarget({ reason: 'all_in_cooldown' }).includes('冷却'));
    assert.ok(formatNoTarget({ reason: 'helper_busy' }).includes('进行中的任务'));
    assert.ok(formatNoTarget({ reason: 'resting' }).includes('休息'));
    assert.ok(formatNoTarget({ reason: 'daily_limit' }).includes('上限'));
  });

  test('带七项明细', () => {
    const t = formatNoTarget({ reason: 'no_participant_with_credit', participants: 5, notSelf: 4, active: 3, withAvailableCredit: 0, underMonthlyLimit: 2, underActiveJobLimit: 1, notInCooldown: 1 });
    assert.ok(t.includes('入队 5'), t);
    assert.ok(t.includes('有额度 0'), t);
    assert.ok(t.includes('非冷却 1'), t);
  });

  test('contended 且明细全 0 → 简短兜底（不输出全 0 误导明细）', () => {
    const t = formatNoTarget({ reason: 'contended' });
    assert.ok(t.includes('任务被抢'), t);
    assert.ok(!t.includes('入队 0'), t);
  });

  test('未知 reason / 字符串 / 空值', () => {
    assert.ok(formatNoTarget({ reason: 'weird' }).includes('暂无可互助目标'));
    assert.equal(formatNoTarget('队列为空'), '队列为空');
    assert.ok(formatNoTarget(null).includes('暂无可互助目标'));
  });
});
