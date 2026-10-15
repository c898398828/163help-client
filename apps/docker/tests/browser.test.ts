import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DockBrowser, createPageHelper, PAGE_HELPER } from '../src/browser.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}


describe('浏览器操作有界等待', () => {
  test('旧 evaluate 超时的清理不能停止较新的播放', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const db = new DockBrowser('/tmp', '');
    const pending = deferred();
    let current = '';
    const fakeWindow = { __mhPlayer: {
      play(id: string) { if (id === '1') return pending.promise; current = id; return { ok: true }; },
      stop() { current = ''; },
    } };
    (db as any).page = { evaluate: (fn: Function, arg: unknown) =>
      Promise.resolve(new Function('window', 'arg', 'return (' + fn.toString() + ')(arg)')(fakeWindow, arg)) };
    const old = db.play('1', 60_000);
    assert.equal((await db.play('2', 60_000)).ok, true);
    t.mock.timers.tick(25_000);
    await flush();
    assert.equal((await old).ok, false);
    assert.equal(current, '2');
  });

  test('renderer 返回的失败原因透传给调用方（不再只剩 false）', async () => {
    const db = new DockBrowser('/tmp', '');
    (db as any).page = { evaluate: async () => ({ ok: false, err: '歌曲地址不可用' }) };
    assert.deepEqual(await db.play('1', 60_000), { ok: false, err: '歌曲地址不可用' });
  });

  test('只给恢复成功透传 attempts，普通成功保持原有结果', async () => {
    const db = new DockBrowser('/tmp', '');
    (db as any).page = { evaluate: async () => ({ ok: true, attempts: 2 }) };
    assert.deepEqual(await db.play('1', 60_000), { ok: true, err: undefined, attempts: 2 });
    (db as any).page = { evaluate: async () => ({ ok: true }) };
    assert.deepEqual(await db.play('2', 60_000), { ok: true, err: undefined });
  });

  test('进度透传位置、自然结束和真实证据，过滤非有限或无效字段', async () => {
    const db = new DockBrowser('/tmp', '');
    (db as any).page = { evaluate: async () => ({
      playedMs: 500, positionMs: 1500, durationMs: 3000, ended: true,
      evidence: { playbackRate: 2, jumpCount: 1, backwardJumpCount: 0, listenDriftMs: 1000, stallDetected: false },
    }) };
    assert.deepEqual(await db.progress(), {
      playedMs: 500, positionMs: 1500, durationMs: 3000, ended: true,
      evidence: { playbackRate: 2, jumpCount: 1, backwardJumpCount: 0, listenDriftMs: 1000, stallDetected: false },
    });
    (db as any).page = { evaluate: async () => ({
      playedMs: Infinity, positionMs: NaN, durationMs: -1, ended: 'true',
      evidence: { playbackRate: Infinity, jumpCount: -1, backwardJumpCount: '1', listenDriftMs: -200, stallDetected: 'true' },
    }) };
    assert.deepEqual(await db.progress(), {
      playedMs: 0, positionMs: 0, durationMs: 0, ended: false, evidence: { listenDriftMs: -200 },
    });
  });

  test('外层 evaluate 超时也返回带原因的失败', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const db = new DockBrowser('/tmp', '');
    (db as any).page = { evaluate: () => new Promise(() => {}) };
    let result: any;
    void db.play('1', 60_000).then((value) => { result = value; });
    t.mock.timers.tick(25_000);
    await flush();
    assert.equal(result.ok, false);
    assert.match(String(result.err), /超时/);
  });

  for (const [method, limit] of [['play', 25_000], ['progress', 5_000], ['stop', 5_000], ['identity', 12_000]] as const) {
    test(`${method} 在 renderer 永不响应时于 ${limit}ms 内结束`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const db = new DockBrowser('/tmp', '');
      (db as any).page = { evaluate: () => new Promise(() => {}) };
      let result: { value?: unknown; error?: unknown } | undefined;
      const request = method === 'play' ? db.play('1', 60_000) : db[method]();
      void request.then((value) => { result = { value }; }, (error) => { result = { error }; });
      t.mock.timers.tick(limit - 1);
      await flush();
      assert.equal(result, undefined);
      t.mock.timers.tick(1);
      await flush();
      assert.ok(result, 'renderer 挂起不能无限阻塞调用者');
      if (method === 'progress') assert.match(String(result.error), /超时|timeout/i);
      else if (method === 'identity') assert.deepEqual(result.value, { id: '', name: '', vipType: 0 });
      else if (method === 'play') assert.equal((result.value as any).ok, false);
      else assert.equal(result.value, undefined);
    });
  }
});

describe('页内异步请求超时与歌曲失效', () => {
  for (const stalled of ['fetch', 'body'] as const) {
    test(`identity ${stalled} 停滞 8s 后中止，不缓存超时后的迟到身份`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const pending = deferred();
      let signal: AbortSignal | undefined;
      const w: Record<string, any> = { fetch: (_url: string, options: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return stalled === 'fetch' ? pending.promise : Promise.resolve({ json: () => pending.promise });
      } };
      createPageHelper(w);
      let result: unknown;
      void w.__mhPlayer.identity().then((value: unknown) => { result = value; });
      await flush();
      t.mock.timers.tick(7999);
      await flush();
      assert.equal(result, undefined);
      t.mock.timers.tick(1);
      await flush();
      assert.deepEqual(result, { id: '', name: '', vipType: 0 });
      assert.equal(signal?.aborted, true);
      const late = { account: { id: 1 }, profile: { nickname: 'late' } };
      pending.resolve(stalled === 'fetch' ? { json: async () => late } : late);
      await flush();
      w.fetch = async () => ({ json: async () => ({ account: { id: 2 }, profile: { nickname: 'fresh' } }) });
      assert.deepEqual(await w.__mhPlayer.identity(), { id: '2', name: 'fresh', vipType: 0 });
    });
  }

  function playerWithRequests() {
    const requests: Array<ReturnType<typeof deferred> & { signal?: AbortSignal }> = [];
    const w: Record<string, any> = { fetch: (_url: string, options?: { signal?: AbortSignal }) => {
      const request = { ...deferred(), signal: options?.signal };
      requests.push(request);
      return request.promise;
    } };
    createPageHelper(w);
    const player = w.__mhPlayer;
    player.audio = { src: '', currentTime: 0, duration: NaN, ended: false, play: async () => {}, pause() {} };
    return { player, requests };
  }
  const song = (url: string) => ({ json: async () => ({ data: [{ url, duration: 60 }] }) });

  test('stop 中止播放请求，迟到响应不能再次设置 audio.src', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, requests } = playerWithRequests();
    const pending = player.play('1');
    player.stop();
    requests[0]!.resolve(song('track-a'));
    assert.equal((await pending).ok, false);
    assert.equal(requests[0]!.signal?.aborted, true);
    assert.equal(player.audio.src, '');
  });

  test('新播放中止旧请求，A 迟到不能覆盖 B', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, requests } = playerWithRequests();
    const a = player.play('1');
    const b = player.play('2');
    requests[1]!.resolve(song('track-b'));
    assert.equal((await b).ok, true);
    assert.equal(player.audio.src, 'track-b');
    requests[0]!.resolve(song('track-a'));
    assert.equal((await a).ok, false);
    assert.equal(requests[0]!.signal?.aborted, true);
    assert.equal(player.audio.src, 'track-b');
  });

  test('audio.play 的迟到成功也不能把已失效的歌曲报告为成功', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, requests } = playerWithRequests();
    const started = deferred<void>();
    player.audio.play = () => started.promise;
    const a = player.play('1');
    requests[0]!.resolve(song('track-a'));
    await flush();
    player.stop();
    started.resolve();
    assert.equal((await a).ok, false);
    assert.equal(player.audio.src, '');
  });

  test('播放加载超时返回失败并停止音频，不留迟到播放', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, requests } = playerWithRequests();
    let result: any;
    void player.play('1').then((value: unknown) => { result = value; });
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(result?.ok, false);
    assert.equal(requests[0]!.signal?.aborted, true);
    requests[0]!.resolve(song('late-track'));
    await flush();
    assert.equal(player.audio.src, '');
  });

  test('取流请求挂起 20s → 失败原因说明卡在 fetch 阶段', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = playerWithRequests();
    let result: any;
    void player.play('1').then((value: unknown) => { result = value; });
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(result.ok, false);
    assert.match(String(result.err), /页内操作超时/);
    assert.match(String(result.err), /fetch/);
  });

  test('audio.play 挂起 20s → 失败原因说明卡在 audio.play 阶段', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, requests } = playerWithRequests();
    player.audio.play = () => new Promise(() => {});
    let result: any;
    void player.play('1').then((value: unknown) => { result = value; });
    requests[0]!.resolve(song('track-a'));
    await flush();
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(result.ok, false);
    assert.match(String(result.err), /audio\.play/);
    assert.equal(player.audio.src, '');
  });

  test('首次起播挂起 8s 后重新取流并重载媒体，只恢复一次', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { player, requests } = playerWithRequests();
    const firstPlay = deferred<void>();
    const resets: string[] = [];
    let plays = 0;
    player.audio.play = () => ++plays === 1 ? firstPlay.promise : Promise.resolve();
    player.audio.pause = () => { resets.push('pause'); };
    player.audio.removeAttribute = (name: string) => { assert.equal(name, 'src'); player.audio.src = ''; resets.push('remove'); };
    player.audio.load = () => { resets.push('load'); };
    const pending = player.play('1');
    requests[0]!.resolve(song('https://media.test/old?token=secret'));
    await flush();
    t.mock.timers.tick(8000);
    await flush();
    assert.equal(requests.length, 2, '起播临时挂起应重新获取一次地址');
    assert.deepEqual(resets, ['pause', 'remove', 'load'], '必须真正中止旧媒体请求');
    requests[1]!.resolve(song('https://media.test/fresh'));
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(plays, 2);
    firstPlay.resolve();
    await flush();
    assert.equal(player.audio.src, 'https://media.test/fresh');
  });

  test('两次起播仍挂起时遵守原 20s 总时限，并保留清理前诊断', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { player, requests } = playerWithRequests();
    player.audio.play = () => new Promise(() => {});
    player.audio.readyState = 2;
    player.audio.networkState = 2;
    player.audio.error = null;
    player.audio.removeAttribute = () => { player.audio.src = ''; };
    player.audio.load = () => { player.audio.readyState = 0; player.audio.networkState = 0; };
    let result: any;
    void player.play('1').then((value: unknown) => { result = value; });
    requests[0]!.resolve(song('https://old.media.test/track?token=private-token'));
    await flush();
    t.mock.timers.tick(8000);
    await flush();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(song('https://fresh.media.test/track?token=private-token'));
    await flush();
    player.audio.readyState = 2;
    player.audio.networkState = 2;
    t.mock.timers.tick(11999);
    await flush();
    assert.equal(result, undefined);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(result.ok, false);
    assert.match(result.err, /attempt=2/);
    assert.match(result.err, /audio\.play=12000ms/);
    assert.match(result.err, /readyState=2/);
    assert.match(result.err, /networkState=2/);
    assert.match(result.err, /sourceHost=fresh\.media\.test/);
    assert.doesNotMatch(result.err, /private-token|https:\/\//);
    assert.equal(player.audio.src, '');
    assert.equal(requests.length, 2);
  });

  test('取流 18s 后只等起播 2s：诊断分开计时，不能再延长总预算', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { player, requests } = playerWithRequests();
    player.audio.play = () => new Promise(() => {});
    let result: any;
    void player.play('1').then((value: unknown) => { result = value; });
    t.mock.timers.tick(18000);
    requests[0]!.resolve(song('https://media.test/song'));
    await flush();
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(result.ok, false);
    assert.match(result.err, /fetch=18000ms/);
    assert.match(result.err, /audio\.play=2000ms/);
    assert.equal(requests.length, 1);
  });

  for (const name of ['NotAllowedError', 'NotSupportedError']) {
    test(`${name} 明确失败不重取地址`, async () => {
      const { player, requests } = playerWithRequests();
      player.audio.play = () => Promise.reject(Object.assign(new Error('blocked'), { name }));
      const pending = player.play('1');
      requests[0]!.resolve(song('https://media.test/song'));
      assert.equal((await pending).ok, false);
      assert.equal(requests.length, 1);
    });
  }

  for (const code of [1, 3, 4]) {
    test(`媒体错误码 ${code} 不按起播超时恢复`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const { player, requests } = playerWithRequests();
      player.audio.play = () => new Promise(() => {});
      player.audio.error = { code };
      const pending = player.play('1');
      requests[0]!.resolve(song('https://media.test/song'));
      await flush();
      t.mock.timers.tick(8000);
      await flush();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.err, new RegExp(`mediaError=${code}`));
      assert.equal(requests.length, 1);
    });
  }

  test('明确网络起播错误只重新取流一次', async () => {
    const { player, requests } = playerWithRequests();
    let plays = 0;
    player.audio.play = () => ++plays === 1
      ? Promise.reject(Object.assign(new Error('network unavailable'), { name: 'NetworkError' }))
      : Promise.resolve();
    const pending = player.play('1');
    requests[0]!.resolve(song('https://media.test/old'));
    await flush();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(song('https://media.test/fresh'));
    assert.equal((await pending).ok, true);
    assert.equal(plays, 2);
  });

  test('连续网络起播错误最多尝试两次，错误消息中的签名 URL 也隐藏', async () => {
    const { player, requests } = playerWithRequests();
    player.audio.error = { code: 2 };
    player.audio.play = () => Promise.reject(new Error('network failed: https://media.test/song?token=private-token'));
    const pending = player.play('1');
    requests[0]!.resolve(song('https://media.test/first?token=private-token'));
    await flush();
    assert.equal(requests.length, 2);
    requests[1]!.resolve(song('https://media.test/second?token=private-token'));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(requests.length, 2);
    assert.match(result.err, /mediaError=2/);
    assert.doesNotMatch(result.err, /private-token|https:\/\//);
  });

  test('audio.play Promise 挂起但已有正进度时保留当前播放，不从头恢复', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { player, requests } = playerWithRequests();
    player.audio.play = () => new Promise(() => {});
    const pending = player.play('1');
    requests[0]!.resolve(song('https://media.test/song'));
    await flush();
    player.audio.currentTime = 3;
    player.audio.paused = false;
    t.mock.timers.tick(8000);
    await flush();
    assert.equal(requests.length, 1);
    assert.equal((await pending).ok, true);
    assert.equal(player.audio.src, 'https://media.test/song');
  });

  for (const cancelAt of ['first-play', 'retry-fetch'] as const) {
    test(`停止于 ${cancelAt} 后不得重试或接受迟到地址`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const { player, requests } = playerWithRequests();
      player.audio.play = () => new Promise(() => {});
      const pending = player.play('1');
      requests[0]!.resolve(song('https://media.test/old'));
      await flush();
      if (cancelAt === 'retry-fetch') { t.mock.timers.tick(8000); await flush(); assert.equal(requests.length, 2); }
      player.stop();
      if (requests[1]) requests[1].resolve(song('https://media.test/late'));
      t.mock.timers.tick(20000);
      await flush();
      assert.equal((await pending).ok, false);
      assert.equal(player.audio.src, '');
      assert.equal(requests.length, cancelAt === 'first-play' ? 1 : 2);
    });
  }

  test('A 的起播子超时不能重置或重试已开始的 B', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { player, requests } = playerWithRequests();
    player.audio.play = () => new Promise(() => {});
    const old = player.play('1');
    requests[0]!.resolve(song('https://media.test/a'));
    await flush();
    player.audio.play = async () => {};
    const fresh = player.play('2');
    requests[1]!.resolve(song('https://media.test/b'));
    assert.equal((await fresh).ok, true);
    t.mock.timers.tick(20000);
    await flush();
    assert.equal((await old).ok, false);
    assert.equal(requests.length, 2);
    assert.equal(player.audio.src, 'https://media.test/b');
  });

  test('歌曲地址不可用时返回可读原因', async () => {
    const { player, requests } = playerWithRequests();
    const pending = player.play('1');
    requests[0]!.resolve({ json: async () => ({ data: [{ url: null }] }) });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(String(result.err), /歌曲地址不可用/);
    assert.equal(requests.length, 1);
  });

  test('音频加载失败返回失败且清理当前音频', async () => {
    const { player, requests } = playerWithRequests();
    player.audio.play = async () => { throw new Error('audio unavailable'); };
    const pending = player.play('1');
    requests[0]!.resolve(song('broken-track'));
    assert.equal((await pending).ok, false);
    assert.equal(player.audio.src, '');
  });
});

describe('DockBrowser.onUnavailable', () => {
  test('Playwright 断开事件触发回调', () => {
    const handlers: Record<string, Array<() => void>> = {};
    const db = new DockBrowser('/tmp', '');
    (db as any).browser = {
      on: (ev: string, fn: () => void) => { (handlers[ev] ||= []).push(fn); },
    };
    let called = 0;
    db.onUnavailable(() => { called += 1; });
    handlers['disconnected']?.forEach((f) => f());
    assert.equal(called, 1);
  });

  test('未启动浏览器时调用安全（不抛错）', () => {
    const db = new DockBrowser('/tmp', '');
    assert.doesNotThrow(() => db.onUnavailable(() => {}));
  });

  test('渲染进程 crash 事件触发回调：浏览器进程仍存活，disconnected 不会来', () => {
    const handlers: Record<string, Array<() => void>> = {};
    const db = new DockBrowser('/tmp', '');
    (db as any).page = { on: (ev: string, fn: () => void) => { (handlers[ev] ||= []).push(fn); } };
    const reasons: string[] = [];
    db.onUnavailable((reason) => { reasons.push(reason); });
    assert.equal(handlers['crash']?.length, 1, '必须监听 page 的 crash 事件');
    handlers['crash']!.forEach((f) => f());
    assert.equal(reasons.length, 1);
    assert.equal(db.isUsable(), false, '渲染进程崩溃后浏览器实例不再可用');
  });

  test('evaluate 抛 Target crashed 时标记不可用，不再当作一次普通播放失败', async () => {
    const db = new DockBrowser('/tmp', '');
    (db as any).page = { evaluate: () => Promise.reject(new Error('page.evaluate: Target crashed')) };
    const reasons: string[] = [];
    db.onUnavailable((reason) => { reasons.push(reason); });
    const result = await db.play('1', 60_000);
    assert.equal(result.ok, false);
    assert.equal(db.isUsable(), false);
    assert.equal(reasons.length, 1);
  });

  test('可用性默认成立；主动 close 不算「不可用」事件', async () => {
    const db = new DockBrowser('/tmp', '');
    assert.equal(db.isUsable(), true);
    let called = 0;
    db.onUnavailable(() => { called += 1; });
    await db.close();
    assert.equal(db.isUsable(), false);
    assert.equal(called, 0, '主动关闭不应触发重建回调');
  });

  test('崩溃先于订阅时，订阅方仍能立刻收到通知', () => {
    const handlers: Record<string, Array<() => void>> = {};
    const db = new DockBrowser('/tmp', '');
    (db as any).page = { on: (ev: string, fn: () => void) => { (handlers[ev] ||= []).push(fn); } };
    db.onUnavailable(() => {});
    handlers['crash']!.forEach((f) => f());
    const reasons: string[] = [];
    db.onUnavailable((reason) => { reasons.push(reason); });
    assert.equal(reasons.length, 1, '订阅晚于崩溃也必须收到通知');
  });
});

describe('页内播放器 helper（网易云身份）', () => {
  test('identity() 解析 account.id / profile.nickname / vipType', async () => {
    const w: Record<string, any> = { fetch: async () => ({ json: async () => ({ account: { id: 123456, vipType: 11 }, profile: { nickname: 'CoC' } }) }) };
    createPageHelper(w);
    assert.deepEqual(await w.__mhPlayer.identity(), { id: '123456', name: 'CoC', vipType: 11 });
  });

  test('identity() 请求失败 → 空身份（不抛错），且下次会重试（不缓存失败）', async () => {
    let calls = 0;
    const w: Record<string, any> = { fetch: async () => { calls += 1; throw new Error('net'); } };
    createPageHelper(w);
    assert.deepEqual(await w.__mhPlayer.identity(), { id: '', name: '', vipType: 0 });
    await w.__mhPlayer.identity();
    assert.equal(calls, 2, '失败不应被缓存');
  });

  test('identity() 成功后缓存，不重复请求', async () => {
    let calls = 0;
    const w: Record<string, any> = { fetch: async () => { calls += 1; return { json: async () => ({ account: { id: 42 }, profile: { nickname: 'n' } }) }; } };
    createPageHelper(w);
    await w.__mhPlayer.identity();
    await w.__mhPlayer.identity();
    assert.equal(calls, 1);
  });

  test('identity() 非法 id 视为空（服务端只接受数字 id）', async () => {
    const w: Record<string, any> = { fetch: async () => ({ json: async () => ({ account: { id: 'abc<script>' }, profile: {} }) }) };
    createPageHelper(w);
    assert.deepEqual(await w.__mhPlayer.identity(), { id: '', name: '', vipType: 0 });
  });
});

describe('页内播放器 helper（进度读取）', () => {
  function makePlayer() {
    const w: Record<string, any> = {};
    createPageHelper(w);
    return { w, player: w.__mhPlayer };
  }

  test('未经播放计时的媒体位置不能充当有效时长', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 12.5, duration: 299, ended: false };
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 12_500, durationMs: 299_000, ended: false });
  });

  test('未建立当前任务计时的旧 ended 不作为当前结束，时长保留真实元数据', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 179.999, duration: 180, ended: true };
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 179_999, durationMs: 180_000, ended: false });
  });

  test('duration 读到 NaN/0 时用上次已知时长兜底（流式音频常见）', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 60, duration: 299, ended: false };
    player.progress();
    player.audio.duration = NaN;
    player.audio.currentTime = 61;
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 61_000, durationMs: 299_000, ended: false });
  });

  test('切换歌曲后不沿用上一首的时长（30s → 未知时长且已播放 31s）', async () => {
    const { w, player } = makePlayer();
    w.fetch = async () => ({ json: async () => ({ data: [{ url: 'https://audio.invalid/next' }] }) });
    player.audio = { currentTime: 29, duration: 30, ended: false, play: async () => {} };
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 29_000, durationMs: 30_000, ended: false });

    assert.equal((await player.play('song:2')).ok, true);
    player.audio.currentTime = 31;
    player.audio.duration = NaN;
    const p = player.progress();
    assert.equal(p.durationMs, 0);
    assert.equal(p.positionMs, 31_000);
    assert.equal(p.playedMs, 0, '没有真实经过时间，不能把切歌后的位置当成有效播放');
  });

  test('stop 清除缓存时长，未知时长不再回退到停止前的歌曲', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 29, duration: 30, ended: false, pause() {} };
    player.progress();
    player.stop();
    player.audio.currentTime = 0;
    player.audio.duration = NaN;
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 0, durationMs: 0, ended: false });
  });

  test('非有限进度归零，非有限时长不能污染本曲已知时长', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 1, duration: 30, ended: false };
    player.progress();
    player.audio.duration = Infinity;
    player.audio.currentTime = NaN;
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 0, durationMs: 30_000, ended: false });
    player.audio.currentTime = Infinity;
    player.audio.ended = true;
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 0, durationMs: 30_000, ended: false });
  });

  test('play 不返回非有限的接口时长', async () => {
    const { w, player } = makePlayer();
    w.fetch = async () => ({ json: async () => ({ data: [{ url: 'https://audio.invalid/song', duration: Infinity }] }) });
    player.audio = { play: async () => {} };
    assert.deepEqual(await player.play('1'), { ok: true, durationMs: 0 });
  });

  test('没有音频时返回全 0', () => {
    const { player } = makePlayer();
    assert.deepEqual(player.progress(), { playedMs: 0, positionMs: 0, durationMs: 0, ended: false });
  });

  test('注入字符串（toString 序列化）可独立求值并挂载 __mhPlayer', () => {
    const fakeWin: Record<string, any> = {};
    new Function('window', PAGE_HELPER)(fakeWin);
    assert.ok(fakeWin.__mhPlayer, '注入后应挂载 __mhPlayer');
    fakeWin.__mhPlayer.audio = { currentTime: 1, duration: 10, ended: false };
    assert.deepEqual(fakeWin.__mhPlayer.progress(), { playedMs: 0, positionMs: 1000, durationMs: 10_000, ended: false });
  });
});

describe('页内播放器 helper（真实有效播放）', () => {
  async function fixture() {
    let now = 0;
    const w: Record<string, any> = {
      performance: { now: () => now },
      fetch: async () => ({ json: async () => ({ data: [{ url: 'https://audio.invalid/test' }] }) }),
    };
    createPageHelper(w);
    const audio = {
      src: '', currentTime: 0, duration: 300, ended: false, paused: true, playbackRate: 1,
      async play() { this.currentTime = 0; this.ended = false; this.paused = false; },
      pause() { this.paused = true; },
      load() { this.currentTime = 0; this.ended = false; },
    };
    w.__mhPlayer.audio = audio;
    await w.__mhPlayer.play('1');
    return { w, player: w.__mhPlayer, audio, advance: (ms: number) => { now += ms; } };
  }

  test('起播前建立基线，首秒与正常 1x 自然结束都按实际时间累计', async () => {
    const { player, audio, advance } = await fixture();
    advance(1000); audio.currentTime = 1;
    assert.equal(player.progress().playedMs, 1000);
    advance(299_000); audio.currentTime = 300; audio.ended = true; audio.paused = true;
    assert.deepEqual(player.progress(), {
      playedMs: 300_000, positionMs: 300_000, durationMs: 300_000, ended: true,
      evidence: { playbackRate: 1, jumpCount: 0, backwardJumpCount: 0, listenDriftMs: 0, stallDetected: false },
    });
  });

  for (const jitterMs of [20, 40]) {
    test(`正常 1x 300 秒带 ${jitterMs}ms 交替位置抖动，不累积单向计时损耗`, async () => {
      const { player, audio, advance } = await fixture();
      for (let second = 1; second <= 300; second++) {
        advance(1000);
        audio.currentTime = second - (second % 2 ? jitterMs / 1000 : 0);
        audio.ended = second === 300;
        audio.paused = audio.ended;
        const p = player.progress();
        assert.equal(p.playedMs, Math.round(audio.currentTime * 1000));
        assert.equal(p.evidence.jumpCount, 0);
      }
      assert.equal(player.progress().playedMs, 300_000);
    });
  }

  test('新歌取流期间旧音频已经停止，旧曲 ended 不泄漏给新任务', async () => {
    const { w, player, audio, advance } = await fixture();
    advance(300_000); audio.currentTime = 300; audio.ended = true;
    player.progress();
    const request = deferred();
    w.fetch = () => request.promise;
    const loading = player.play('2');
    try {
      const p = player.progress();
      assert.equal(audio.paused, true);
      assert.equal(p.playedMs, 0);
      assert.equal(p.ended, false);
    } finally {
      player.stop();
      request.resolve({ json: async () => ({ data: [{ url: 'late' }] }) });
      await loading;
    }
  });

  test('一秒跳到曲尾不能当作听完，也不能由 ended 补齐有效时长', async () => {
    const { player, audio, advance } = await fixture();
    advance(1000); audio.currentTime = 300; audio.ended = true;
    const p = player.progress();
    assert.equal(p.playedMs, 0);
    assert.equal(p.positionMs, 300_000);
    assert.equal(p.durationMs, 300_000);
    assert.equal(p.ended, true);
    assert.equal(p.evidence.jumpCount, 1);
    assert.equal(p.evidence.listenDriftMs, 300_000);
  });

  test('小幅位置跃进也不能超过真实经过时间；重复采样不重复累计', async () => {
    const { player, audio, advance } = await fixture();
    advance(1000); audio.currentTime = 2;
    assert.equal(player.progress().playedMs, 1000);
    assert.equal(player.progress().playedMs, 1000);
    assert.equal(player.progress().evidence.listenDriftMs, 1000);
  });

  test('回退不增加有效时长并留下证据，后续真实前进可继续累计', async () => {
    const { player, audio, advance } = await fixture();
    advance(10_000); audio.currentTime = 10;
    assert.equal(player.progress().playedMs, 10_000);
    advance(1000); audio.currentTime = 2;
    const backward = player.progress();
    assert.equal(backward.playedMs, 10_000);
    assert.equal(backward.evidence.backwardJumpCount, 1);
    assert.equal(backward.evidence.jumpCount, 1);
    advance(1000); audio.currentTime = 3;
    assert.equal(player.progress().playedMs, 11_000);
  });

  test('倍速区间不计有效时长，恢复 1x 后可累计且仍保留实际最高倍速', async () => {
    const { player, audio, advance } = await fixture();
    audio.playbackRate = 2;
    advance(1000); audio.currentTime = 2;
    assert.equal(player.progress().playedMs, 0);
    audio.playbackRate = 1;
    advance(1000); audio.currentTime = 3;
    const p = player.progress();
    assert.equal(p.playedMs, 1000);
    assert.equal(p.evidence.playbackRate, 2);
    assert.equal(p.evidence.listenDriftMs, 2000);
  });

  test('暂停时间不计入有效时长，停滞证据只累计实际播放状态', async () => {
    const { player, audio, advance } = await fixture();
    audio.paused = true;
    advance(60_000);
    assert.equal(player.progress().playedMs, 0);
    assert.equal(player.progress().evidence.stallDetected, false);
    audio.paused = false;
    advance(40_000);
    assert.equal(player.progress().evidence.stallDetected, true);
  });

  for (const paused of [true, false]) {
    test(`${paused ? '暂停' : '停滞'}切断计时区间，不能用之前的余量抵消恢复后的跳进度`, async () => {
      const { player, audio, advance } = await fixture();
      advance(1000); audio.currentTime = 0.5;
      assert.equal(player.progress().playedMs, 500);
      audio.paused = paused;
      advance(1000);
      assert.equal(player.progress().playedMs, 500);
      audio.paused = false;
      advance(1000); audio.currentTime = 2.5;
      assert.equal(player.progress().playedMs, 1500);
    });
  }

  test('起播重取音源后重新建立计时基线，不继承失败等待时间或前单证据', async () => {
    const { player, audio, advance } = await fixture();
    advance(1000); audio.currentTime = 50;
    player.progress();
    let attempts = 0;
    audio.play = async () => {
      audio.currentTime = 0; audio.ended = false; audio.paused = false;
      if (++attempts === 1) {
        advance(2000);
        const e = new Error('temporary'); e.name = 'NetworkError'; throw e;
      }
    };
    assert.equal((await player.play('2')).attempts, 2);
    advance(1000); audio.currentTime = 1;
    const p = player.progress();
    assert.equal(p.playedMs, 1000);
    assert.equal(p.evidence.jumpCount, 0);
    assert.equal(p.evidence.listenDriftMs, 0);
  });

  test('切歌、停止清除本单有效时长与证据，不继承旧音频位置', async () => {
    const { player, audio, advance } = await fixture();
    advance(1000); audio.currentTime = 80;
    assert.equal(player.progress().evidence.jumpCount, 1);
    await player.play('2');
    advance(1000); audio.currentTime = 1;
    const p = player.progress();
    assert.equal(p.playedMs, 1000);
    assert.equal(p.evidence.jumpCount, 0);
    player.stop();
    assert.equal(player.progress().playedMs, 0);
    assert.equal(player.progress().positionMs, 0);
  });

  test('系统时钟回退不虚增有效时间', async () => {
    const { player, audio, advance } = await fixture();
    advance(1000); audio.currentTime = 1;
    assert.equal(player.progress().playedMs, 1000);
    advance(-1000); audio.currentTime = 2;
    assert.equal(player.progress().playedMs, 1000);
  });
});
