/**
 * API 签名（与 server hmac.go verifyRequestSignature 对齐；与 4.x 在用的客户端算法一致）。
 * - 密钥：mh_ck_ 客户端密钥 → sha256(token) 小写 hex（服务端只存 key 哈希）；会话 token → token 本身
 * - 消息：METHOD\npath?query\ntimestamp\nnonce\nrawBody（path 含 query，与 r.URL.RequestURI() 一致）
 * - 请求头：X-Timestamp / X-Nonce / X-Signature（小写 hex）
 * - nonce 每次请求全新生成（修复「重试复用 nonce → 403 疑似重放」）
 * 浏览器环境：hmacFn 由各端注入（crypto.subtle 实现 / node crypto 实现），core 不直接依赖运行时 API。
 */

export type HmacFn = (secret: string, data: string) => Promise<string>;
export type NonceFn = () => string;

export interface SignHeaders {
  'X-Timestamp': string; // unix 秒
  'X-Nonce': string; // 16 字节 hex
  'X-Signature': string; // hmac-sha256 小写 hex
}

/** 无法签名（无 token）时返回 null，调用方降级不签名 */
export async function buildSignHeaders(
  method: string,
  fullUrl: string,
  rawBody: string,
  token: string,
  hmacFn: HmacFn,
  nonceFn: NonceFn,
): Promise<SignHeaders | null> {
  if (!token) return null;
  const u = new URL(fullUrl);
  const path = u.pathname + u.search; // 与服务端 r.URL.RequestURI() 一致
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = nonceFn(); // 每次全新，绝不复用
  const key = token.startsWith('mh_ck_') ? await subtleSha256(token) : token;
  const msg = [method.toUpperCase(), path, timestamp, nonce, rawBody || ''].join('\n');
  return { 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': await hmacFn(key, msg) };
}

export const hexBytes = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/** crypto.subtle 实现的 SHA-256（浏览器/Node18+ 通用，小写 hex） */
export async function subtleSha256(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return hexBytes(new Uint8Array(digest));
}

/** crypto.subtle 实现的 HMAC-SHA256（浏览器/Node18+ 通用） */
export async function subtleHmac(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return hexBytes(new Uint8Array(sig));
}

/** 浏览器 nonce：crypto.getRandomValues（16 字节 hex） */
export function browserNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hexBytes(b);
}
