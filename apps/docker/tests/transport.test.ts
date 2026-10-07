import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../src/transport.ts';
import type { ApiResponse } from '../src/api.ts';

interface Call { method: string; path: string; body: unknown; token?: string; opts?: unknown }

function fakeApi(replies: Array<Partial<ApiResponse<unknown>>>) {
  const calls: Call[] = [];
  let i = 0;
  const api = async (method: string, path: string, body?: unknown, token?: string, opts?: unknown): Promise<ApiResponse<unknown>> => {
    calls.push({ method, path, body, token, opts });
    const r = replies[Math.min(i, replies.length - 1)] ?? { status: 200, payload: {} };
    i += 1;
    return { status: r.status ?? 200, payload: (r.payload ?? null) as never, error: r.error };
  };
  return { api, calls };
}

const identity = { id: '8888', name: 'CoC', vipType: 11 };

describe('docker 传输层（对齐 4.x 请求形状）', () => {
  test('放弃请求携带准确 jobId，不能只发送原因', async () => {
    const { api, calls } = fakeApi([{ status: 200, payload: { ok: true } }]);
    const t = createTransport({ api: api as never, getIdentity: async () => identity });
    await t.abandon('old-token', 'playback_stalled', '40s', 'old-job');
    assert.deepEqual(calls[0]!.body, { jobId: 'old-job', reason: 'playback_stalled', detail: '40s' });
    assert.equal(calls[0]!.token, 'old-token');
  });

  test('心跳体带 neteaseId / neteaseName，并保留进度字段', async () => {
    const { api, calls } = fakeApi([{ status: 200, payload: { ok: true } }]);
    const t = createTransport({ api: api as never, getIdentity: async () => identity });
    const ok = await t.heartbeat('mh_ck_x', { jobId: 'j1', playedMs: 12_000, positionMs: 12_000, durationMs: 300_000, monotonic: true });
    assert.equal(ok, true);
    assert.equal(calls[0]!.path, '/api/play/heartbeat');
    assert.deepEqual(calls[0]!.body, {
      jobId: 'j1', playedMs: 12_000, positionMs: 12_000, durationMs: 300_000, monotonic: true, neteaseId: '8888', neteaseName: 'CoC',
    });
    assert.equal((calls[0]!.opts as { retryNetwork?: boolean }).retryNetwork, true, '心跳幂等：网络抖动可重试');
  });

  test('结算：网络/5xx 有界重试（最多 3 次），4xx 视为最终裁决不重试', async () => {
    const a = fakeApi([{ status: 502, error: 'bad_gateway' }, { status: 502, error: 'bad_gateway' }, { status: 200, payload: { settled: true } }]);
    const t1 = createTransport({ api: a.api as never, getIdentity: async () => identity, finishDelayMs: 10 });
    const r1 = await t1.finish('k', { jobId: 'j1' });
    assert.equal(r1.status, 200);
    assert.equal(a.calls.length, 3, '两次失败后第三次成功');

    const b = fakeApi([{ status: 409, error: 'job_not_active' }]);
    const t2 = createTransport({ api: b.api as never, getIdentity: async () => identity, finishDelayMs: 10 });
    const r2 = await t2.finish('k', { jobId: 'j1' });
    assert.equal(r2.status, 409);
    assert.equal(b.calls.length, 1, '409 是服务端最终裁决，不重试');

    // 网络层失败（status 0）同样重试
    const c = fakeApi([{ status: 0, error: 'network: fetch failed' }, { status: 200, payload: { settled: true } }]);
    const t3 = createTransport({ api: c.api as never, getIdentity: async () => identity, finishDelayMs: 10 });
    assert.equal((await t3.finish('k', { jobId: 'j1' })).status, 200);
    assert.equal(c.calls.length, 2);
  });

  test('身份获取失败不影响心跳（降级为空身份，仍上报进度）', async () => {
    const { api, calls } = fakeApi([{ status: 200, payload: { ok: true } }]);
    const t = createTransport({ api: api as never, getIdentity: async () => { throw new Error('page busy'); } });
    const ok = await t.heartbeat('k', { jobId: 'j1', playedMs: 1000, positionMs: 1000, durationMs: 1000, monotonic: true });
    assert.equal(ok, true);
    assert.equal((calls[0]!.body as { neteaseId: string }).neteaseId, '');
  });
});
