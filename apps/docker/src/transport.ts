/**
 * Docker 端传输层：请求形状与重试策略对齐 4.x 客户端（扩展 4.0.21 / 旧版 docker）。
 * - 心跳：带 neteaseId/neteaseName（服务端据此校验播放账号，缺了可能判为无效播放）；
 *         心跳幂等，网络抖动自动重试一次
 * - 结算：网络/5xx 有界重试（最多 3 次，间隔 1.5s）——「网络/服务端失败不作废本次有效播放」；
 *         4xx（403/409 等）是服务端最终裁决，不重试
 * - 401：key 凭证无 session refresh → canRefresh=false，由 core 停循环并保留凭证
 */
import type { ApiResponse } from './api.ts';

export interface Identity { id: string; name: string; vipType: number }

/** 仅含任务标识与安全错误码，不携带凭证、播放账号或原始响应。 */
export interface HeartbeatRejection { jobId: string; status: number; error: string }

export interface TransportDeps {
  api: <T>(method: string, path: string, body?: unknown, token?: string, opts?: { retryNetwork?: boolean }) => Promise<ApiResponse<T>>;
  getIdentity: () => Promise<Identity>;
  /** 结算尝试次数（默认 3）与间隔（默认 1500ms） */
  finishAttempts?: number;
  finishDelayMs?: number;
  /** 一次心跳最终失败时报告一次；诊断异常不得影响心跳结果。 */
  onHeartbeatRejected?: (failure: HeartbeatRejection) => void;
}

/** 结算可重试的服务端状态（网络层失败 status=0 同样重试） */
const RETRY_FINISH_STATUSES = [500, 502, 503, 504];

// 仅透传已有协议中的错误标识；任意文本可能包含 token、Cookie、URL 或账号。
const HEARTBEAT_ERROR_CODES = new Set([
  'job_not_active', 'job_expired', 'heartbeat_lost',
  'invalid_or_expired_token', 'token_expired', 'client_upgrade_required',
]);

function hasError(error: unknown): boolean {
  return Boolean(error); // 空串/null/false/0 与旧成功响应中的「无错误」语义兼容。
}

export function createTransport(deps: TransportDeps) {
  const api = deps.api;
  const attempts = Math.max(1, deps.finishAttempts ?? 3);
  const delayMs = deps.finishDelayMs ?? 1500;
  const emptyIdentity: Identity = { id: '', name: '', vipType: 0 };

  return {
    next: async (token: string) => api('POST', '/api/next', {}, token),

    /** 结算：网络/5xx 重试，4xx 直接返回 */
    finish: async <T = { settled?: boolean }>(token: string, input: unknown): Promise<ApiResponse<T>> => {
      let r = await api<T>('POST', '/api/play/finish', input, token);
      for (let i = 1; i < attempts; i += 1) {
        if (!(r.status === 0 || RETRY_FINISH_STATUSES.includes(r.status))) break;
        await new Promise((res) => setTimeout(res, delayMs));
        r = await api<T>('POST', '/api/play/finish', input, token);
      }
      return r;
    },

    abandon: async (token: string, reason: string, detail: string, jobId?: string) => {
      await api('POST', '/api/play/abandon', { jobId, reason, detail }, token);
    },

    /** 心跳：附带网易云身份；HTTP 200 仍需有效对象且没有显式业务拒绝。 */
    heartbeat: async (token: string, input: unknown): Promise<boolean> => {
      let ident = emptyIdentity;
      try { ident = await deps.getIdentity(); } catch { /* 页面繁忙：降级 */ }
      const body: Record<string, unknown> = { ...(input as Record<string, unknown>), neteaseId: ident.id, neteaseName: ident.name };
      let response: ApiResponse<unknown>;
      try { response = await api('POST', '/api/play/heartbeat', body, token, { retryNetwork: true }); }
      catch { response = { status: 0, payload: null }; }
      const payload = response.payload !== null && typeof response.payload === 'object' && !Array.isArray(response.payload)
        ? response.payload as Record<string, unknown> : null;
      const rawError = hasError(response.error) ? response.error : payload?.error;
      // 兼容旧服务端的无 ok 字段对象，不臆造新的成功响应字段。
      if (response.status === 200 && payload && payload.ok !== false && !hasError(rawError)) return true;

      const fallback = response.status === 0 ? 'heartbeat_network_error'
        : response.status !== 200 ? `heartbeat_http_${response.status}`
        : payload ? 'heartbeat_rejected' : 'heartbeat_invalid_response';
      const error = typeof rawError === 'string' && HEARTBEAT_ERROR_CODES.has(rawError) ? rawError : fallback;
      try {
        void Promise.resolve(deps.onHeartbeatRejected?.({
          jobId: typeof body.jobId === 'string' ? body.jobId : '', status: response.status, error,
        })).catch(() => {});
      } catch { /* 诊断失败不能变成播放/网络错误 */ }
      return false;
    },

    refresh: async () => null, // key 凭证不走 session refresh
    canRefresh: false, // 401 直接停循环（保留已保存密钥），不做刷新重试
    me: () => api('GET', '/api/me'),
    sendLog: async (p: unknown) => { await api('POST', '/api/client/log', p); },
  };
}
