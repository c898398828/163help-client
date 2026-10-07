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
    assert.equal(await db.play('2', 60_000), true);
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(await old, false);
    assert.equal(current, '2');
  });

  for (const [method, limit] of [['play', 20_000], ['progress', 5_000], ['stop', 5_000], ['identity', 12_000]] as const) {
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
      else assert.equal(result.value, method === 'play' ? false : undefined);
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
