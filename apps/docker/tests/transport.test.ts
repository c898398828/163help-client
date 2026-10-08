import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, type HeartbeatRejection } from '../src/transport.ts';
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

  test('心跳兼容没有显式拒绝的成功对象，不要求服务端新增字段', async () => {
    for (const payload of [{ ok: true }, {}, { received: true }, { ok: true, error: '' }, { error: null }, { ok: true, error: false }, { ok: true, error: 0 }]) {
      const { api } = fakeApi([{ status: 200, payload }]);
      const rejected: HeartbeatRejection[] = [];
      const t = createTransport({ api: api as never, getIdentity: async () => identity,
        onHeartbeatRejected: failure => rejected.push(failure) });
      assert.equal(await t.heartbeat('mh_ck_private', { jobId: 'j1' }), true);
      assert.deepEqual(rejected, [], '成功心跳不发出失败诊断');
    }
  });

  test('HTTP 200 的空值、非对象或数组不能确认心跳', async () => {
    for (const payload of [null, 'ok', true, 1, [], [{ ok: true }]]) {
      const { api, calls } = fakeApi([{ status: 200, payload }]);
      const rejected: HeartbeatRejection[] = [];
      const t = createTransport({ api: api as never, getIdentity: async () => identity,
        onHeartbeatRejected: failure => rejected.push(failure) });
      assert.equal(await t.heartbeat('mh_ck_private', { jobId: 'j1' }), false, JSON.stringify(payload));
      assert.deepEqual(rejected, [{ jobId: 'j1', status: 200, error: 'heartbeat_invalid_response' }]);
      assert.equal(calls.length, 1, '一次调用只报告最终结果，不新增业务重试');
    }
  });

  test('HTTP 200 的业务拒绝不能续心跳，失败原因每次只报告一次', async () => {
    const cases = [
      { payload: { ok: false }, error: 'heartbeat_rejected' },
      { payload: { ok: false, error: 'job_not_active' }, error: 'job_not_active' },
      { payload: { ok: true, error: 'job_expired' }, error: 'job_expired' },
      { payload: { error: { message: 'secret' } }, error: 'heartbeat_rejected' },
      { payload: { error: ['secret'] }, error: 'heartbeat_rejected' },
    ];
    for (const entry of cases) {
      const { api } = fakeApi([{ status: 200, payload: entry.payload }]);
      const rejected: HeartbeatRejection[] = [];
      const t = createTransport({ api: api as never, getIdentity: async () => identity,
        onHeartbeatRejected: failure => rejected.push(failure) });
      assert.equal(await t.heartbeat('mh_ck_private', { jobId: 'j1' }), false);
      assert.deepEqual(rejected, [{ jobId: 'j1', status: 200, error: entry.error }]);
    }
  });

  test('心跳 HTTP 或网络失败保留可诊断状态，不暴露原始错误文本', async () => {
    const cases = [
      { status: 409, error: 'job_not_active', expected: 'job_not_active' },
      { status: 401, error: 'invalid_or_expired_token', expected: 'invalid_or_expired_token' },
      { status: 503, error: 'server failed at https://private.example', expected: 'heartbeat_http_503' },
      { status: 0, error: 'network: fetch failed MUSIC_U=private', expected: 'heartbeat_network_error' },
    ];
    for (const entry of cases) {
      const { api, calls } = fakeApi([entry]);
      const rejected: HeartbeatRejection[] = [];
      const t = createTransport({ api: api as never, getIdentity: async () => identity,
        onHeartbeatRejected: failure => rejected.push(failure) });
      assert.equal(await t.heartbeat('mh_ck_private', { jobId: 'j1' }), false);
      assert.deepEqual(rejected, [{ jobId: 'j1', status: entry.status, error: entry.expected }]);
      assert.deepEqual(calls[0]!.opts, { retryNetwork: true });
    }
  });

  test('诊断只允许已知错误标识，token、Cookie、URL、网易云身份均不透传', async () => {
    for (const error of ['mh_ck_private', 'MUSIC_U=private', 'https://private.example', identity.id, identity.name]) {
      const { api } = fakeApi([{ status: 200, payload: { ok: false, error, token: 'mh_ck_private', ...identity } }]);
      const rejected: HeartbeatRejection[] = [];
      const t = createTransport({ api: api as never, getIdentity: async () => identity,
        onHeartbeatRejected: failure => rejected.push(failure) });
      assert.equal(await t.heartbeat('mh_ck_private', { jobId: 'j1' }), false);
      assert.deepEqual(rejected, [{ jobId: 'j1', status: 200, error: 'heartbeat_rejected' }]);
    }
  });

  test('请求抛出异常也只报告一次安全的网络失败', async () => {
    const rejected: HeartbeatRejection[] = [];
    const t = createTransport({ api: async () => { throw new Error('MUSIC_U=private'); },
      getIdentity: async () => identity, onHeartbeatRejected: failure => rejected.push(failure) });
    assert.equal(await t.heartbeat('mh_ck_private', { jobId: 'j1' }), false);
    assert.deepEqual(rejected, [{ jobId: 'j1', status: 0, error: 'heartbeat_network_error' }]);
  });

  test('诊断回调异常不改变心跳失败结果', async () => {
    const { api } = fakeApi([{ status: 409, error: 'job_not_active' }]);
    let reports = 0;
    const t = createTransport({ api: api as never, getIdentity: async () => identity,
      onHeartbeatRejected: () => { reports++; throw new Error('diagnostic sink failed'); } });
    assert.equal(await t.heartbeat('mh_ck_private', { jobId: 'j1' }), false);
    assert.equal(reports, 1);
  });
});
