import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import { createApi } from '../src/api.ts';

interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }

/** 本地捕获服务器：记录收到的请求头/体，并按脚本返回响应 */
async function captureServer(reply: { status?: number; body?: unknown } = {}) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? { ok: true }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, seen };
}

/** 参考签名：与服务端 hmac.go 对齐（同 core/tests/sign.test.ts 的规格） */
function refSign(method: string, pathWithQuery: string, rawBody: string, token: string, ts: string, nonce: string): string {
  const key = token.startsWith('mh_ck_') ? createHash('sha256').update(token).digest('hex') : token;
  return createHmac('sha256', key).update([method, pathWithQuery, ts, nonce, rawBody].join('\n')).digest('hex');
}

describe('docker API 传输（版本头 + HMAC 签名）', () => {
  test('请求带版本头、客户端类型、Bearer 与签名三件套；签名可被服务端算法校验', async () => {
    const { server, base, seen } = await captureServer();
    try {
      const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'mh_ck_test' });
      const r = await api('POST', '/api/next', {});
      assert.equal(r.status, 200);
      const req = seen[0]!;
      assert.equal(req.headers['x-music-helper-version'], '4.0.21');
      assert.equal(req.headers['x-client-type'], 'docker');
      assert.equal(req.headers['authorization'], 'Bearer mh_ck_test');
      const ts = String(req.headers['x-timestamp']);
      const nonce = String(req.headers['x-nonce']);
      assert.match(ts, /^\d+$/);
      assert.equal(req.headers['x-signature'], refSign('POST', '/api/next', req.body, 'mh_ck_test', ts, nonce));
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('无 token 时降级不签名（不带 Authorization / 签名头）', async () => {
    const { server, base, seen } = await captureServer();
    try {
      const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => '' });
      await api('GET', '/api/me');
      const req = seen[0]!;
      assert.equal(req.headers['authorization'], undefined);
      assert.equal(req.headers['x-signature'], undefined);
      assert.equal(req.headers['x-music-helper-version'], '4.0.21');
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('403 响应透出服务端错误码（如 client_upgrade_required），onResult 标记不健康', async () => {
    const { server, base } = await captureServer({ status: 403, body: { error: 'client_upgrade_required', latestVersion: '4.0.21' } });
    try {
      const results: Array<{ ok: boolean; status: number; error?: string }> = [];
      const api = createApi({ base, version: '5.1', clientType: 'docker', getToken: () => 'mh_ck_x', onResult: (r) => results.push(r) });
      const r = await api('GET', '/api/me');
      assert.equal(r.status, 403);
      assert.equal(r.error, 'client_upgrade_required');
      assert.equal(results[0]!.ok, false);
      assert.equal(results[0]!.status, 403);
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('网络失败 → status 0 且带原因（含底层 cause 码），不抛出', async () => {
    const results: Array<{ ok: boolean; status: number; error?: string }> = [];
    const api = createApi({ base: 'http://127.0.0.1:9', version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
    const r = await api('GET', '/api/me');
    assert.equal(r.status, 0);
    assert.equal(r.payload, null);
    assert.match(String(r.error), /^network: /);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.status, 0);
  });

  test('extraHeaders：每次请求附带（如 X-Vip-Type，服务端 /api/me、/api/next 消费）', async () => {
    const { server, base, seen } = await captureServer();
    try {
      const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', extraHeaders: () => ({ 'X-Vip-Type': '11' }) });
      await api('GET', '/api/me');
      assert.equal(seen[0]!.headers['x-vip-type'], '11');
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('retryNetwork：连接被重置时自动重试一次（心跳幂等），只上报最终结果', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      if (hits === 1) { req.socket.destroy(); return; } // 模拟 ECONNRESET
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const results: Array<{ ok: boolean; status: number }> = [];
      const api = createApi({ base: `http://127.0.0.1:${port}`, version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
      const r = await api('POST', '/api/play/heartbeat', {}, undefined, { retryNetwork: true });
      assert.equal(r.status, 200);
      assert.equal(hits, 2, '应发生一次重试');
      assert.equal(results.length, 1, '只上报最终结果（中间失败不上报，避免日志噪音）');
      assert.equal(results[0]!.ok, true);
    } finally { server.closeAllConnections(); server.close(); }
  });
});
