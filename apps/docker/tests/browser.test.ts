import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DockBrowser, createPageHelper, PAGE_HELPER } from '../src/browser.ts';

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
