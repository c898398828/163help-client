/**
 * Docker 端 API 传输：版本头 + HMAC 签名（服务端 hmac.go 对齐）+ 网络错误兜底。
 *
 * 版本头说明：服务端版本闸门当前只放行 3.x/4.x（5.x 会得到 403 client_upgrade_required），
 * 因此默认按协议等价版本上报（可用环境变量 CLIENT_VERSION 覆盖）；服务端放行 5.x 后可改回。
 */
import { buildSignHeaders, subtleHmac, browserNonce } from '../../../packages/core/src/sign.ts';

export interface ApiDeps {
  base: string;
  version: string;
  clientType: string;
  getToken: () => string;
  /** 每次请求附带的额外头（如 X-Vip-Type：服务端 /api/me、/api/next 消费） */
  extraHeaders?: () => Record<string, string>;
  /** 每次请求结果（供状态条/诊断/日志；网络失败 status=0） */
  onResult?: (r: { ok: boolean; status: number; at: number; error?: string }) => void;
}

export interface ApiResponse<T> {
  status: number;
  payload: T | null;
  /** 非 200 时服务端的错误码（如 client_upgrade_required / invalid_or_expired_token） */
  error?: string;
}

export function createApi(deps: ApiDeps) {
  async function request<T>(method: string, path: string, body: unknown, token: string, report: boolean): Promise<ApiResponse<T>> {
    const fullUrl = deps.base + path;
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...(deps.extraHeaders?.() ?? {}),
      'Content-Type': 'application/json',
      'X-Client-Type': deps.clientType,
      'X-Music-Helper-Version': deps.version,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const sign = await buildSignHeaders(method, fullUrl, rawBody, token, subtleHmac, browserNonce);
    if (sign) Object.assign(headers, sign);
    try {
      const res = await fetch(fullUrl, { method, headers, body: body === undefined ? undefined : rawBody });
      const parsed: unknown = await res.json().catch(() => null);
      const error = res.status !== 200 && parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : undefined;
      if (report) deps.onResult?.({ ok: res.status < 400, status: res.status, at: Date.now(), error });
      return { status: res.status, payload: res.status === 200 ? (parsed as T) : null, error };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      const msg = (e instanceof Error ? e.message : String(e)) + (cause ? `（${cause}）` : '');
      if (report) deps.onResult?.({ ok: false, status: 0, at: Date.now(), error: msg });
      return { status: 0, payload: null, error: 'network: ' + msg };
    }
  }

  /** opts.retryNetwork：连接被重置等网络层失败时重试一次（仅用于幂等请求，如心跳）；只上报最终结果 */
  return async function api<T>(method: string, path: string, body?: unknown, token = deps.getToken(), opts?: { retryNetwork?: boolean }): Promise<ApiResponse<T>> {
    const retry = opts?.retryNetwork === true;
    const first = await request<T>(method, path, body, token, !retry);
    if (retry && first.status === 0) {
      await new Promise((r) => setTimeout(r, 800));
      return request<T>(method, path, body, token, true);
    }
    return first;
  };
}
