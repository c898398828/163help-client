import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.UI_PASSWORD = process.env.UI_PASSWORD || 'test-password';
const { createStatusServer } = await import('../src/server.ts');

async function start(state: Record<string, any>, staticDir?: string) {
  const server = createStatusServer({ port: 0, state, staticDir });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** 临时静态目录：一张假图 + 一个非图片文件（后者不得被列出或提供） */
function staticFixture(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-static-'));
  fs.writeFileSync(path.join(dir, 'background.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(path.join(dir, 'night.webp'), Buffer.from('RIFF'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an image');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 原始路径请求：fetch 会先规范化 /static/../x，无法用来验证服务端自身的防穿越 */
function rawGet(base: string, rawPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
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

describe('docker 管理端 背景静态文件', () => {
  test('静态目录里的图片按文件名提供，带类型与缓存头，无需登录', async (t) => {
    const dir = staticFixture(t);
    const { server, base } = await start({}, dir);
    try {
      const png = await rawGet(base, '/static/background.png');
      assert.equal(png.status, 200);
      assert.equal(png.headers['content-type'], 'image/png');
      assert.match(String(png.headers['cache-control']), /max-age=\d+/);
      assert.equal(png.body.length, 8);
      const webp = await rawGet(base, '/static/night.webp');
      assert.equal(webp.status, 200);
      assert.equal(webp.headers['content-type'], 'image/webp');
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('非图片、不存在的文件与路径穿越一律 404', async (t) => {
    const dir = staticFixture(t);
    const { server, base } = await start({}, dir);
    try {
      for (const raw of ['/static/notes.txt', '/static/missing.png', '/static/../server.ts', '/static/%2e%2e/server.ts', '/static/..%2Fserver.ts', '/static/', '/static/%ZZ']) {
        const res = await rawGet(base, raw);
        assert.equal(res.status, 404, `${raw} 应为 404，实际 ${res.status}`);
      }
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('页面模板嵌入背景列表（登录页与仪表页都要有，供预加载主题脚本使用）', async (t) => {
    const dir = staticFixture(t);
    const { server, base } = await start({}, dir);
    try {
      const anon = await (await fetch(base + '/')).text();
      assert.match(anon, /MH_BACKGROUNDS\s*=\s*\["background\.png","night\.webp"\]/);
      const cookie = await login(base);
      const authed = await (await fetch(base + '/', { headers: { Cookie: cookie } })).text();
      assert.match(authed, /MH_BACKGROUNDS\s*=\s*\["background\.png","night\.webp"\]/);
      assert.ok(authed.includes('id="bgSelect"'), '仪表页应有背景选择控件');
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('静态目录不存在时服务照常启动，背景列表为空', async (t) => {
    const { server, base } = await start({}, path.join(os.tmpdir(), 'mh-static-missing-' + process.pid));
    try {
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /MH_BACKGROUNDS\s*=\s*\[\]/);
      assert.equal((await rawGet(base, '/static/background.png')).status, 404);
    } finally { server.closeAllConnections(); server.close(); }
  });
});
