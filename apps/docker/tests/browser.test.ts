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

describe('DockBrowser.onDisconnect', () => {
  test('Playwright 断开事件触发回调', () => {
    const handlers: Record<string, Array<() => void>> = {};
    const db = new DockBrowser('/tmp', '');
    (db as any).browser = {
      on: (ev: string, fn: () => void) => { (handlers[ev] ||= []).push(fn); },
    };
    let called = 0;
    db.onDisconnect(() => { called += 1; });
    handlers['disconnected']?.forEach((f) => f());
    assert.equal(called, 1);
  });

  test('未启动浏览器时调用安全（不抛错）', () => {
    const db = new DockBrowser('/tmp', '');
    assert.doesNotThrow(() => db.onDisconnect(() => {}));
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

  test('正常读取播放进度', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 12.5, duration: 299, ended: false };
    assert.deepEqual(player.progress(), { playedMs: 12_500, durationMs: 299_000 });
  });

  test('音频已播完（ended）→ durationMs 取当前进度，保证能被判定为「歌曲播完」结算', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 180, duration: 180, ended: true };
    assert.deepEqual(player.progress(), { playedMs: 180_000, durationMs: 180_000 });
  });

  test('duration 读到 NaN/0 时用上次已知时长兜底（流式音频常见）', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 60, duration: 299, ended: false };
    player.progress();
    player.audio.duration = NaN;
    player.audio.currentTime = 61;
    assert.deepEqual(player.progress(), { playedMs: 61_000, durationMs: 299_000 });
  });

  test('切换歌曲后不沿用上一首的时长（30s → 未知时长且已播放 31s）', async () => {
    const { w, player } = makePlayer();
    w.fetch = async () => ({ json: async () => ({ data: [{ url: 'https://audio.invalid/next' }] }) });
    player.audio = { currentTime: 29, duration: 30, ended: false, play: async () => {} };
    assert.deepEqual(player.progress(), { playedMs: 29_000, durationMs: 30_000 });

    assert.equal((await player.play('song:2')).ok, true);
    player.audio.currentTime = 31;
    player.audio.duration = NaN;
    assert.deepEqual(player.progress(), { playedMs: 31_000, durationMs: 0 });
  });

  test('stop 清除缓存时长，未知时长不再回退到停止前的歌曲', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 29, duration: 30, ended: false, pause() {} };
    player.progress();
    player.stop();
    player.audio.currentTime = 0;
    player.audio.duration = NaN;
    assert.deepEqual(player.progress(), { playedMs: 0, durationMs: 0 });
  });

  test('非有限进度归零，非有限时长不能污染本曲已知时长', () => {
    const { player } = makePlayer();
    player.audio = { currentTime: 1, duration: 30, ended: false };
    player.progress();
    player.audio.duration = Infinity;
    player.audio.currentTime = NaN;
    assert.deepEqual(player.progress(), { playedMs: 0, durationMs: 30_000 });
    player.audio.currentTime = Infinity;
    player.audio.ended = true;
    assert.deepEqual(player.progress(), { playedMs: 0, durationMs: 0 });
  });

  test('play 不返回非有限的接口时长', async () => {
    const { w, player } = makePlayer();
    w.fetch = async () => ({ json: async () => ({ data: [{ url: 'https://audio.invalid/song', duration: Infinity }] }) });
    player.audio = { play: async () => {} };
    assert.deepEqual(await player.play('1'), { ok: true, durationMs: 0 });
  });

  test('没有音频时返回全 0', () => {
    const { player } = makePlayer();
    assert.deepEqual(player.progress(), { playedMs: 0, durationMs: 0 });
  });

  test('注入字符串（toString 序列化）可独立求值并挂载 __mhPlayer', () => {
    const fakeWin: Record<string, any> = {};
    new Function('window', PAGE_HELPER)(fakeWin);
    assert.ok(fakeWin.__mhPlayer, '注入后应挂载 __mhPlayer');
    fakeWin.__mhPlayer.audio = { currentTime: 1, duration: 10, ended: false };
    assert.deepEqual(fakeWin.__mhPlayer.progress(), { playedMs: 1000, durationMs: 10_000 });
  });
});
