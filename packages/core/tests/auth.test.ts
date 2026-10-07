import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from '../dist/auth.js';
import { EventBus } from '../dist/events.js';

function makeAdapter() {
  let tok = ''; const exps: Record<string, number> = {};
  return {
    clientType: 'userscript', version: '5.1',
    storage: {
      getToken: () => tok, setToken: (t: string) => { tok = t; },
      clearToken: () => { tok = ''; },
      getExpires: (k: string) => exps[k] ?? 0,
      setExpires: (k: string, v: number) => { exps[k] = v; },
    },
    probeNetwork: async () => true, hasPage: true,
  };
}

describe('AuthManager', () => {
  let a: AuthManager; let adapter: ReturnType<typeof makeAdapter>;
  let refreshOk: unknown;

  beforeEach(() => {
    adapter = makeAdapter();
    refreshOk = { token: 't2', access_expires_at: new Date(Date.now() + 86400_000).toISOString(), refresh_expires_at: new Date(Date.now() + 86400_000).toISOString() };
    a = new AuthManager(adapter as never, {
      refresh: async () => refreshOk as never,
      me: async () => ({ status: 200, payload: { displayName: 'u', credits: 1 } }),
    } as never, new EventBus());
  });

  test('login 存入 token 并置 valid', () => {
    a.acceptSession({ token: 't1', access_expires_at: new Date(Date.now() + 86400_000).toISOString(), refresh_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    assert.equal(a.status, 'valid');
    assert.equal(adapter.storage.getToken(), 't1');
  });

  test('token 临近过期时 ensureToken 会 refresh', async () => {
    a.acceptSession({ token: 't1', access_expires_at: new Date(Date.now() + 5000).toISOString(), refresh_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    const t = await a.ensureToken();
    assert.equal(t, 't2');
  });

  test('401 且 refresh 失败 → clearSession(logged_out)', async () => {
    a.acceptSession({ token: 't1', access_expires_at: new Date(Date.now() + 86400_000).toISOString(), refresh_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    refreshOk = null;
    const ok = await a.onUnauthorized();
    assert.equal(ok, false);
    assert.equal(a.status, 'logged_out');
    assert.equal(adapter.storage.getToken(), '');
  });

  test('按服务端真实 /api/me 结构映射额度（user.displayName + participant 秒闸/次数）', async () => {
    const bus = new EventBus();
    const limits: any[] = [];
    const users: any[] = [];
    bus.on('limits:updated', (l) => limits.push(l));
    bus.on('auth:user', (u) => users.push(u));
    const a2 = new AuthManager(adapter as never, {
      refresh: async () => null,
      me: async () => ({ status: 200, payload: {
        user: { displayName: 'CoC', song_slot_limit: 3 },
        participant: {
          available_credits: 86,
          help_seconds_used: 678,
          help_seconds_limit: 8940,
          received_finished_count_24h: 9,
          today_received_limit: 26,
          today_helped_count: 3,
        },
      } }),
    } as never, bus);
    adapter.storage.setToken('mh_ck_x');
    await a2.refreshUser();
    assert.equal(users[0]!.displayName, 'CoC');
    assert.equal(users[0]!.credits, 86);
    assert.deepEqual(limits[0], { helpedToday: 678, helpedLimit: 8940, receivedToday: 9, receivedLimit: 26 });
  });

  test('秒字段缺失时降级到次数字段', async () => {
    const bus = new EventBus();
    const limits: any[] = [];
    bus.on('limits:updated', (l) => limits.push(l));
    const a3 = new AuthManager(adapter as never, {
      refresh: async () => null,
      me: async () => ({ status: 200, payload: {
        user: { displayName: '甲' },
        participant: { today_helped_count: 3, today_helped_limit: 200, today_received_help_count: 2, today_received_limit: 26 },
      } }),
    } as never, bus);
    adapter.storage.setToken('mh_ck_x');
    await a3.refreshUser();
    assert.deepEqual(limits[0], { helpedToday: 3, helpedLimit: 200, receivedToday: 2, receivedLimit: 26 });
  });
});
