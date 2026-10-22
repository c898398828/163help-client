import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MultiServerScheduler } from '../src/scheduler.ts';

describe('MultiServerScheduler 调度仲裁器', () => {
  test('Round-Robin 交替调度', async () => {
    const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 1000 });
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');
    t1.release('settled');

    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2?.serverId, 's2');
    t2.release('settled');

    const t3 = await scheduler.requestNextTurn();
    assert.equal(t3?.serverId, 's1');
    t3.release('settled');
  });

  test('无单 noTarget 即时避让下一服务', async () => {
    const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 5000 });
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');
    scheduler.setCooldown('s1', 5000);
    t1.release('no_job');

    // s1 在冷却中，下一次应该立刻给 s2
    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2?.serverId, 's2');
    t2.release('settled');
  });

  test('互斥锁：同一时间只能有一个服务获得播放权', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');

    // 在 t1 未释放前，尝试获取下一个 turn 应该等待或返回 null
    let nextGranted = false;
    const pNext = scheduler.requestNextTurn().then((t) => {
      nextGranted = true;
      return t;
    });

    // 短暂等待，验证 pNext 仍在排队未立即放行
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(nextGranted, false);

    t1.release('settled');
    const t2 = await pNext;
    assert.equal(t2?.serverId, 's2');
    t2?.release('settled');
  });

  test('acquireTurn 独占互斥与等待释放', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const rel1 = await scheduler.acquireTurn('s1');
    assert.ok(typeof rel1 === 'function');

    let s2Acquired = false;
    const pS2 = scheduler.acquireTurn('s2').then((rel) => {
      s2Acquired = true;
      return rel;
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s2Acquired, false);

    rel1();
    const rel2 = await pS2;
    assert.equal(s2Acquired, true);
    assert.ok(typeof rel2 === 'function');
    rel2?.();
  });

  test('acquireTurn 与 requestNextTurn 之间的互斥', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const rel1 = await scheduler.acquireTurn('s1');
    assert.ok(rel1);

    let nextGranted = false;
    const pNext = scheduler.requestNextTurn().then((t) => {
      nextGranted = true;
      return t;
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(nextGranted, false);

    rel1();
    const tNext = await pNext;
    assert.ok(tNext);
    assert.equal(nextGranted, true);
    tNext.release('settled');
  });

  test('pause 与 resume 暂停恢复机制', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));

    scheduler.pause();
    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1, null);

    const rel = await scheduler.acquireTurn('s1');
    assert.equal(rel, null);

    scheduler.resume();
    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2?.serverId, 's1');
    t2.release('settled');
  });

  test('reset 重置调度器所有状态', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    scheduler.setCooldown('s1', 10000);
    assert.ok(scheduler.getCooldownUntil('s1') > Date.now());

    scheduler.reset();

    // 重置后无注册服务，返回 null
    const t = await scheduler.requestNextTurn();
    assert.equal(t, null);
    assert.equal(scheduler.getCooldownUntil('s1'), 0);
  });

  test('unregisterServer 注销服务且释放其持有的锁', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');

    // s2 等待获取播放权
    let s2Granted = false;
    const p2 = scheduler.requestNextTurn().then((t) => {
      s2Granted = true;
      return t;
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s2Granted, false);

    // 直接注销 s1（模拟服务被动态删除或异常退出）
    scheduler.unregisterServer('s1');

    // s2 应立即被放行
    const t2 = await p2;
    assert.equal(s2Granted, true);
    assert.equal(t2?.serverId, 's2');
    t2?.release('settled');

    // 再次调度，由于 s1 已被注销，只剩 s2
    const t3 = await scheduler.requestNextTurn();
    assert.equal(t3?.serverId, 's2');
    t3?.release('settled');
  });

  test('getEligibility 动态状态感知与更新', async () => {
    const scheduler = new MultiServerScheduler();
    let s1Enabled = false;
    let s2Eligible = false;

    scheduler.registerServer('s1', () => ({ enabled: s1Enabled, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: s2Eligible }));

    // 两个都不可用
    assert.equal(await scheduler.requestNextTurn(), null);

    // s2 变为 eligible
    s2Eligible = true;
    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's2');
    t1.release('settled');

    // 更新 s1 的 getEligibility
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    s2Eligible = false;
    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2?.serverId, 's1');
    t2.release('settled');
  });

  test('setCooldown 默认时长与指定时长', async () => {
    const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 2000 });
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));

    const before = Date.now();
    scheduler.setCooldown('s1');
    const cd1 = scheduler.getCooldownUntil('s1');
    assert.ok(cd1 >= before + 2000 && cd1 <= before + 3000);

    scheduler.setCooldown('s1', 10000);
    const cd2 = scheduler.getCooldownUntil('s1');
    assert.ok(cd2 >= before + 10000 && cd2 <= before + 12000);

    // 不存在的服务冷却返回 0
    assert.equal(scheduler.getCooldownUntil('unknown'), 0);
  });

  test('waitQueue 排队传播：当先头等待者未取到服务时，后续等待者仍能被正常放行', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    // s1 占用
    const rel1 = await scheduler.acquireTurn('s1');
    assert.ok(rel1);

    // 等待者1: requestNextTurn
    let waiter1Done = false;
    let waiter1Result: unknown = undefined;
    const p1 = scheduler.requestNextTurn().then((t) => {
      waiter1Done = true;
      waiter1Result = t;
      return t;
    });

    // 等待者2: s2 的 acquireTurn
    let waiter2Done = false;
    const p2 = scheduler.acquireTurn('s2').then((rel) => {
      waiter2Done = true;
      return rel;
    });

    // 把 s1 和 s2 都禁用，模拟等待者1在唤醒时找不到可用服务
    scheduler.registerServer('s1', () => ({ enabled: false, eligible: false }));
    scheduler.registerServer('s2', () => ({ enabled: false, eligible: false }));

    // 释放 s1
    rel1();

    // 等待者1应该唤醒并返回 null，同时等待者2也应该被唤醒并成功 acquireTurn
    const t1 = await p1;
    assert.equal(t1, null);
    assert.equal(waiter1Done, true);

    const rel2 = await p2;
    assert.equal(waiter2Done, true);
    assert.ok(typeof rel2 === 'function');
    rel2?.();
  });

  test('全部服务冷却中返回 null，冷却结束后恢复调度', async () => {
    const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 100 });
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));

    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');
    scheduler.setCooldown('s1', 80);
    t1.release('no_job');

    // 立即再次请求，应该因为冷却中返回 null
    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2, null);

    // 等待冷却结束
    await new Promise((r) => setTimeout(r, 100));

    const t3 = await scheduler.requestNextTurn();
    assert.equal(t3?.serverId, 's1');
    t3.release('settled');
  });

  test('相同服务重复 acquireTurn 不发生死锁', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));

    const rel1 = await scheduler.acquireTurn('s1');
    assert.ok(rel1);

    // 相同的 s1 再次请求 acquireTurn 不应被自身阻塞
    const rel2 = await scheduler.acquireTurn('s1');
    assert.ok(rel2);

    rel1();
    rel2();
  });

  test('release 接收不同 outcome 状态且释放幂等', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));

    const outcomes: Array<'settled' | 'abandoned' | 'no_job' | 'error'> = [
      'settled',
      'abandoned',
      'no_job',
      'error',
    ];

    for (const outcome of outcomes) {
      const grant = await scheduler.requestNextTurn();
      assert.equal(grant?.serverId, 's1');
      // 多次调用 release 是幂等的
      grant.release(outcome);
      grant.release(outcome);
    }
  });

  test('unregisterServer 动态调整 cursor 防止溢出', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s3', () => ({ enabled: true, eligible: true }));

    // 调度 s1, cursor 移至 1
    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');
    t1.release('settled');

    // 调度 s2, cursor 移至 2
    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2?.serverId, 's2');
    t2.release('settled');

    // 注销 s3，servers 长度变为 2，cursor 仍能正常回绕
    scheduler.unregisterServer('s3');
    const t3 = await scheduler.requestNextTurn();
    assert.equal(t3?.serverId, 's1');
    t3.release('settled');
  });

  test('acquireTurn 在 unregisterServer 后被唤醒不获锁并返回 null', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    // s1 持有锁
    const rel1 = await scheduler.acquireTurn('s1');
    assert.ok(rel1);

    // s2 排队等待
    const pS2 = scheduler.acquireTurn('s2');

    // 在 s2 排队时注销 s2
    scheduler.unregisterServer('s2');

    // 释放 s1
    rel1();

    // 被注销的 s2 唤醒后必须返回 null，不得非法获锁
    const rel2 = await pS2;
    assert.equal(rel2, null);
  });

  test('acquireTurn 在 reset 后被唤醒不获锁并返回 null', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    const rel1 = await scheduler.acquireTurn('s1');
    assert.ok(rel1);

    const pS2 = scheduler.acquireTurn('s2');

    // 重置调度器
    scheduler.reset();

    const rel2 = await pS2;
    assert.equal(rel2, null);
  });

  test('重入 acquireTurn 引用计数：首个 release 不提前释放互斥锁，直至全部 release', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    // s1 重入获取两次锁
    const rel1A = await scheduler.acquireTurn('s1');
    assert.ok(rel1A);
    const rel1B = await scheduler.acquireTurn('s1');
    assert.ok(rel1B);

    // s2 排队等待
    let s2Acquired = false;
    const pS2 = scheduler.acquireTurn('s2').then((rel) => {
      s2Acquired = true;
      return rel;
    });

    // 释放第一次重入，s2 仍必须等待，锁未真正释放
    rel1A();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s2Acquired, false);

    // 释放第二次重入，此时锁才真正释放，s2 成功获锁
    rel1B();
    const rel2 = await pS2;
    assert.equal(s2Acquired, true);
    assert.ok(typeof rel2 === 'function');
    rel2?.();
  });

  test('setCooldown 使用 NaN 或非法数值时回退到默认时长', async () => {
    const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 3000 });
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));

    const before = Date.now();
    scheduler.setCooldown('s1', Number.NaN);
    const cd = scheduler.getCooldownUntil('s1');
    assert.ok(Number.isFinite(cd));
    assert.ok(cd >= before + 3000 && cd <= before + 5000);
  });

  test('unregisterServer 校准 cursor 保持轮流调度顺序', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s0', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

    // 初始 cursor 为 0，调度 s0 后 cursor 指向 1（s1）
    const t0 = await scheduler.requestNextTurn();
    assert.equal(t0?.serverId, 's0');
    t0.release('settled');

    // 注销 s0（其索引 0 < 当前 cursor 1）
    scheduler.unregisterServer('s0');

    // 校验校准后 cursor 应当仍指向 s1
    const t1 = await scheduler.requestNextTurn();
    assert.equal(t1?.serverId, 's1');
    t1.release('settled');

    // 下一个应该轮到 s2
    const t2 = await scheduler.requestNextTurn();
    assert.equal(t2?.serverId, 's2');
    t2.release('settled');
  });

  test('acquireTurn 循环内因 paused 退出时级联唤醒后续等待者（防漏唤醒）', async () => {
    const scheduler = new MultiServerScheduler();
    scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));
    scheduler.registerServer('s3', () => ({ enabled: true, eligible: true }));

    // s1 持有锁
    const rel1 = await scheduler.acquireTurn('s1');
    assert.ok(rel1);

    // s2 和 s3 依次排队等待锁
    const pS2 = scheduler.acquireTurn('s2');
    const pS3 = scheduler.acquireTurn('s3');

    // 在队列排队时，暂停调度器
    scheduler.pause();

    // 释放 s1 锁，触发 pumpQueue 唤醒 s2
    rel1();

    // s2 被唤醒后在 while 循环中检测到 paused，级联唤醒 s3 并返回 null
    const resS2 = await pS2;
    assert.equal(resS2, null);

    // s3 同样被级联唤醒并返回 null，而不是永远挂起在 waitQueue 中
    const resS3 = await pS3;
    assert.equal(resS3, null);
  });
});
