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
  /** 每次尝试的超时（含响应体读取），默认 15 秒；无效值回退默认值 */
  requestTimeoutMs?: number;
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
  const configuredTimeout = deps.requestTimeoutMs ?? 15_000;
  const requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 && configuredTimeout <= 2_147_483_647
    ? configuredTimeout : 15_000;

  async function request<T>(method: string, path: string, body: unknown, token: string): Promise<ApiResponse<T>> {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    try {
      const res = await fetch(fullUrl, { method, headers, body: body === undefined ? undefined : rawBody, signal: controller.signal });
      // 先完整读取响应体：连接中断必须走网络失败，不能被 JSON 解析兜底吞掉。
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* 完整的非 JSON 响应仍保留 HTTP 状态 */ }
      const error = res.status !== 200 && parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : undefined;
      return { status: res.status, payload: res.status === 200 ? (parsed as T) : null, error };
    } catch (e) {
      const failure = controller.signal.aborted ? controller.signal.reason : e;
      const cause = (failure as { cause?: { code?: string } }).cause?.code;
      const msg = (failure instanceof Error ? failure.message : String(failure)) + (cause ? `（${cause}）` : '');
      return { status: 0, payload: null, error: 'network: ' + msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /** opts.retryNetwork：连接被重置等网络层失败时重试一次（仅用于幂等请求，如心跳）；只上报最终结果 */
  return async function api<T>(method: string, path: string, body?: unknown, token = deps.getToken(), opts?: { retryNetwork?: boolean }): Promise<ApiResponse<T>> {
    let result = await request<T>(method, path, body, token);
    if (opts?.retryNetwork === true && result.status === 0) {
      await new Promise((r) => setTimeout(r, 800));
      result = await request<T>(method, path, body, token);
    }
    deps.onResult?.({
      ok: result.status > 0 && result.status < 400,
      status: result.status,
      at: Date.now(),
      error: result.status === 0 ? result.error?.replace(/^network: /, '') : result.error,
    });
    return result;
  };
}
