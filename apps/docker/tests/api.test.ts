import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import { createApi } from '../src/api.ts';

interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }

/** 本地捕获服务器：记录收到的请求头/体，并按脚本返回响应 */
async function captureServer(reply: { status?: number; body?: unknown } | ((res: http.ServerResponse, attempt: number) => void) = {}) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      if (typeof reply === 'function') { reply(res, seen.length); return; }
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

  test('默认配置也有有限超时，不依赖调用方选择时限', async (t) => {
    // 仅加速长定时器；仍使用真实 fetch/AbortSignal 验证默认超时生效。
    const originalSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      originalSetTimeout(callback, Number.isFinite(delay) && delay! > 400 ? 30 : delay, ...args));
    const { server, base } = await captureServer((res) => {
      const timer = setTimeout(() => res.end('{"ok":true}'), 400);
      res.on('close', () => clearTimeout(timer));
    });
    try {
      const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k' });
      const r = await api('GET', '/api/me');
      assert.equal(r.status, 0);
      assert.match(r.error!, /^network: .*timeout/i);
    } finally { server.closeAllConnections(); server.close(); }
  });

  for (const stallBody of [false, true]) {
    test(`请求超时覆盖${stallBody ? '响应体读取' : '响应头等待'}，未选择重试的 POST 只发送一次`, async () => {
      const { server, base, seen } = await captureServer((res) => {
        if (stallBody) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"ok":');
        }
        // 旧实现最终收到成功响应，让缺少超时的回归确定失败而不是挂住测试进程。
        const timer = setTimeout(() => res.end(stallBody ? 'true}' : '{"ok":true}'), 400);
        res.on('close', () => clearTimeout(timer));
      });
      try {
        const results: Array<{ ok: boolean; status: number; error?: string }> = [];
        const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', requestTimeoutMs: 50, onResult: (r) => results.push(r) });
        const r = await api('POST', '/api/next', {});
        assert.equal(r.status, 0);
        assert.equal(r.payload, null);
        assert.match(r.error!, /^network: .*timeout/i);
        assert.equal(seen.length, 1);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.ok, false);
        assert.equal(results[0]!.status, 0);
        assert.match(results[0]!.error!, /timeout/i);
      } finally { server.closeAllConnections(); server.close(); }
    });
  }

  test('retryNetwork：超时后使用独立时限重试，成功时只报告最终结果', async () => {
    const { server, base, seen } = await captureServer((res, attempt) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok":');
      const timer = setTimeout(() => res.end('true}'), attempt === 1 ? 400 : 20);
      res.on('close', () => clearTimeout(timer));
    });
    try {
      const results: Array<{ ok: boolean; status: number }> = [];
      const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', requestTimeoutMs: 100, onResult: (r) => results.push(r) });
      const r = await api('POST', '/api/play/heartbeat', {}, undefined, { retryNetwork: true });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { ok: true });
      assert.equal(seen.length, 2);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, true);
      assert.equal(results[0]!.status, 200);
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('retryNetwork：两次都超时后终止，只上报最终网络失败', async () => {
    const { server, base, seen } = await captureServer((res) => {
      const timer = setTimeout(() => res.end('{"ok":true}'), 400);
      res.on('close', () => clearTimeout(timer));
    });
    try {
      const results: Array<{ ok: boolean; status: number; error?: string }> = [];
      const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', requestTimeoutMs: 50, onResult: (r) => results.push(r) });
      const r = await api('POST', '/api/play/heartbeat', {}, undefined, { retryNetwork: true });
      assert.equal(r.status, 0);
      assert.equal(r.payload, null);
      assert.match(r.error!, /^network: .*timeout/i);
      assert.equal(seen.length, 2);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, false);
      assert.equal(results[0]!.status, 0);
      assert.equal(results[0]!.error, r.error!.slice('network: '.length));
    } finally { server.closeAllConnections(); server.close(); }
  });

  test('响应体读取 ECONNRESET 必须作为网络失败透出，未选择重试的 POST 不重试', async (t) => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      attempts += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated', { cause: { code: 'ECONNRESET' } }));
        },
      }), { status: 200 });
    });
    const results: Array<{ ok: boolean; status: number; error?: string }> = [];
    const api = createApi({ base: 'http://localhost', version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
    const r = await api('POST', '/api/next', {});
    assert.equal(r.status, 0);
    assert.equal(r.payload, null);
    assert.match(r.error!, /^network: .*ECONNRESET/);
    assert.equal(attempts, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.status, 0);
    assert.match(results[0]!.error!, /ECONNRESET/);
  });

  test('retryNetwork：响应头到达后连接断开也重试，只上报恢复后的响应', async () => {
    const { server, base, seen } = await captureServer((res, attempt) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (attempt === 1) {
        res.write('{"ok":');
        const timer = setTimeout(() => res.destroy(), 50);
        res.on('close', () => clearTimeout(timer));
      } else {
        res.end('{"ok":true}');
      }
    });
    try {
      const results: Array<{ ok: boolean; status: number }> = [];
      const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
      const r = await api('POST', '/api/play/heartbeat', {}, undefined, { retryNetwork: true });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { ok: true });
      assert.equal(seen.length, 2);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, true);
    } finally { server.closeAllConnections(); server.close(); }
  });

  for (const status of [200, 503]) {
    test(`完整的非 JSON HTTP ${status} 响应仍保留状态且不重试`, async () => {
      const { server, base, seen } = await captureServer((res) => {
        res.writeHead(status);
        res.end('not JSON');
      });
      try {
        const results: Array<{ ok: boolean; status: number }> = [];
        const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
        const r = await api('POST', '/api/play/heartbeat', {}, undefined, { retryNetwork: true });
        assert.equal(r.status, status);
        assert.equal(r.payload, null);
        assert.equal(r.error, undefined);
        assert.equal(seen.length, 1);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, status);
      } finally { server.closeAllConnections(); server.close(); }
    });
  }

  for (const status of [200, 403, 500]) {
    test(`retryNetwork：首个 HTTP ${status} 响应只上报一次且不重试`, async () => {
      const body = status === 200 ? { ok: true } : { error: 'server_error' };
      const { server, base, seen } = await captureServer({ status, body });
      try {
        const results: Array<{ ok: boolean; status: number; at: number; error?: string }> = [];
        const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
        const r = await api('POST', '/api/play/heartbeat', {}, undefined, { retryNetwork: true });
        assert.equal(r.status, status);
        assert.deepEqual(r.payload, status === 200 ? body : null);
        assert.equal(seen.length, 1, 'HTTP 响应不得触发网络重试');
        assert.equal(results.length, 1, '首个响应也是最终结果，必须上报');
        assert.equal(results[0]!.ok, status < 400);
        assert.equal(results[0]!.status, status);
        assert.equal(results[0]!.error, status === 200 ? undefined : 'server_error');
        assert.ok(Number.isFinite(results[0]!.at));
      } finally { server.closeAllConnections(); server.close(); }
    });
  }

  for (const path of ['/api/next', '/api/play/finish', '/api/play/abandon', '/api/client/log']) {
    test(`未选择重试的 POST ${path} 在连接重置时只发送一次`, async () => {
      const { server, base, seen } = await captureServer((res) => res.destroy());
      try {
        const results: Array<{ ok: boolean; status: number }> = [];
        const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
        const r = await api('POST', path, {});
        assert.equal(r.status, 0);
        assert.equal(seen.length, 1);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.ok, false);
        assert.equal(results[0]!.status, 0);
      } finally { server.closeAllConnections(); server.close(); }
    });
  }

  for (const finalStatus of [0, 403]) {
    test(`retryNetwork：网络失败后最终 ${finalStatus}，最多两次尝试且只上报最终失败`, async () => {
      const { server, base, seen } = await captureServer((res, attempt) => {
        if (attempt === 1 || finalStatus === 0) { res.destroy(); return; }
        res.writeHead(finalStatus, { 'Content-Type': 'application/json' });
        res.end('{"error":"client_upgrade_required"}');
      });
      try {
        const results: Array<{ ok: boolean; status: number; error?: string }> = [];
        const api = createApi({ base, version: '4.0.21', clientType: 'docker', getToken: () => 'k', onResult: (r) => results.push(r) });
        const r = await api('POST', '/api/play/heartbeat', {}, undefined, { retryNetwork: true });
        assert.equal(r.status, finalStatus);
        assert.equal(r.payload, null);
        assert.equal(seen.length, 2);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.ok, false);
        assert.equal(results[0]!.status, finalStatus);
        if (finalStatus === 0) {
          assert.match(r.error!, /^network: /);
          assert.equal(results[0]!.error, r.error!.slice('network: '.length));
        } else {
          assert.equal(r.error, 'client_upgrade_required');
          assert.equal(results[0]!.error, 'client_upgrade_required');
        }
      } finally { server.closeAllConnections(); server.close(); }
    });
  }

  test('retryNetwork：连接重置后重新签名（新 nonce），保留请求体与 token，只上报最终结果', async () => {
    const { server, base, seen } = await captureServer((res, attempt) => {
      if (attempt === 1) { res.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    try {
      const results: Array<{ ok: boolean; status: number }> = [];
      const api = createApi({
        base, version: '4.0.21', clientType: 'docker', getToken: () => 'wrong_default_token',
        extraHeaders: () => ({ 'X-Vip-Type': '11' }), onResult: (r) => results.push(r),
      });
      const path = '/api/play/heartbeat?source=docker';
      const body = { jobId: 'job-1', playedMs: 10 };
      const r = await api('POST', path, body, 'mh_ck_retry', { retryNetwork: true });
      assert.equal(r.status, 200);
      assert.equal(seen.length, 2, '应发生一次重试');
      for (const req of seen) {
        assert.equal(req.url, path);
        assert.equal(req.method, 'POST');
        assert.equal(req.body, JSON.stringify(body));
        assert.equal(req.headers['authorization'], 'Bearer mh_ck_retry');
        assert.equal(req.headers['x-music-helper-version'], '4.0.21');
        assert.equal(req.headers['x-client-type'], 'docker');
        assert.equal(req.headers['x-vip-type'], '11');
        const ts = String(req.headers['x-timestamp']);
        const nonce = String(req.headers['x-nonce']);
        assert.match(ts, /^\d+$/);
        assert.match(nonce, /^[a-f0-9]{32}$/);
        assert.equal(req.headers['x-signature'], refSign('POST', path, req.body, 'mh_ck_retry', ts, nonce));
      }
      assert.notEqual(seen[0]!.headers['x-nonce'], seen[1]!.headers['x-nonce']);
      assert.notEqual(seen[0]!.headers['x-signature'], seen[1]!.headers['x-signature']);
      assert.equal(results.length, 1, '只上报最终结果（中间失败不上报，避免日志噪音）');
      assert.equal(results[0]!.ok, true);
    } finally { server.closeAllConnections(); server.close(); }
  });
});
