import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

process.env.UI_PASSWORD = process.env.UI_PASSWORD || 'test-password';
const { createStatusServer } = await import('../src/server.ts');

async function start(state: Record<string, any>) {
  const server = createStatusServer({ port: 0, state });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function login(base: string): Promise<string> {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.UI_PASSWORD }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.getSetCookie()[0]!;
  return setCookie.split(';')[0]!; // mh_ui=xxx
}

const postConfig = (base: string, cookie: string, body: unknown) =>
  fetch(base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

describe('docker 管理端 /api/config', () => {
  test('未注册 onConfig 时不得假报成功', async () => {
    const { server, base } = await start({});
    try {
      const cookie = await login(base);
      const res = await postConfig(base, cookie, { cookie: 'MUSIC_U=1', key: 'mh_ck_x' });
      assert.notEqual(res.status, 200);
      const body = await res.json();
      assert.notEqual(body.ok, true);
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('onConfig 收到原始 patch，成功返回 ok+saved', async () => {
    const received: unknown[] = [];
    const { server, base } = await start({
      onConfig: async (c: unknown) => { received.push(c); return { saved: ['cookie', 'key'] }; },
    });
    try {
      const cookie = await login(base);
      const res = await postConfig(base, cookie, { cookie: 'MUSIC_U=1', key: 'mh_ck_x' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.saved, ['cookie', 'key']);
      assert.deepEqual(received[0], { cookie: 'MUSIC_U=1', key: 'mh_ck_x' });
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('onConfig 抛错（写盘失败）→ 500 且不 ok', async () => {
    const { server, base } = await start({
      onConfig: async () => { throw new Error('EACCES: read-only file system'); },
    });
    try {
      const cookie = await login(base);
      const res = await postConfig(base, cookie, { cookie: 'MUSIC_U=1' });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.notEqual(body.ok, true);
      assert.ok(String(body.error).includes('EACCES'));
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('onConfig 返回 error → 400 且带错误信息', async () => {
    const { server, base } = await start({
      onConfig: async () => ({ saved: [], error: '请填写 Cookie 或客户端密钥' }),
    });
    try {
      const cookie = await login(base);
      const res = await postConfig(base, cookie, {});
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.notEqual(body.ok, true);
      assert.ok(String(body.error).includes('请填写'));
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('未登录访问 /api/config → 401', async () => {
    const { server, base } = await start({ onConfig: async () => ({ saved: [] }) });
    try {
      const res = await postConfig(base, 'mh_ui=bogus', { cookie: 'MUSIC_U=1' });
      assert.equal(res.status, 401);
    } finally { server.closeAllConnections(); server.close(); }
  });
});

describe('docker 管理端 会话与状态', () => {
  test('/api/logout 使会话失效', async () => {
    const { server, base } = await start({});
    try {
      const cookie = await login(base);
      const out = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(out.status, 200);
      const after = await fetch(base + '/api/state', { headers: { Cookie: cookie } });
      assert.equal(after.status, 401);
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('/api/state 透出 configured / acctName / jobsDone', async () => {
    const { server, base } = await start({ configured: true, acctName: '甲', jobsDone: 7, helpUsed: 120, helpLimit: 9000 });
    try {
      const cookie = await login(base);
      const res = await fetch(base + '/api/state', { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.configured, true);
      assert.equal(body.acctName, '甲');
      assert.equal(body.jobsDone, 7);
      assert.equal(body.helpUsed, 120);
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('/api/state 透出 lastApi（服务端连通状态，供状态条/诊断使用）', async () => {
    const lastApi = { ok: false, status: 502, at: 1_700_000_000_000 };
    const { server, base } = await start({ lastApi });
    try {
      const cookie = await login(base);
      const res = await fetch(base + '/api/state', { headers: { Cookie: cookie } });
      const body = await res.json();
      assert.deepEqual(body.lastApi, lastApi);
    } finally { server.closeAllConnections(); server.close(); }
  });
});
