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

export interface TransportDeps {
  api: <T>(method: string, path: string, body?: unknown, token?: string, opts?: { retryNetwork?: boolean }) => Promise<ApiResponse<T>>;
  getIdentity: () => Promise<Identity>;
  /** 结算尝试次数（默认 3）与间隔（默认 1500ms） */
  finishAttempts?: number;
  finishDelayMs?: number;
}

/** 结算可重试的服务端状态（网络层失败 status=0 同样重试） */
const RETRY_FINISH_STATUSES = [500, 502, 503, 504];

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

    abandon: async (token: string, reason: string, detail: string) => {
      await api('POST', '/api/play/abandon', { reason, detail }, token);
    },

    /** 心跳：附带网易云身份；身份获取失败降级为空身份，不阻塞上报 */
    heartbeat: async (token: string, input: unknown): Promise<boolean> => {
      let ident = emptyIdentity;
      try { ident = await deps.getIdentity(); } catch { /* 页面繁忙：降级 */ }
      const body = { ...(input as Record<string, unknown>), neteaseId: ident.id, neteaseName: ident.name };
      return (await api('POST', '/api/play/heartbeat', body, token, { retryNetwork: true })).status === 200;
    },

    refresh: async () => null, // key 凭证不走 session refresh
    canRefresh: false, // 401 直接停循环（保留已保存密钥），不做刷新重试
    me: () => api('GET', '/api/me'),
    sendLog: async (p: unknown) => { await api('POST', '/api/client/log', p); },
  };
}
