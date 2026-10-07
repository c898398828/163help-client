/**
 * 管理端配置写入（/api/config → session.json）
 * 规则：
 * - 空值不覆盖已保存值（防止「只改一项」时误清另一项）；
 * - clear:true 才显式清空；
 * - key 必须是 mh_ck_ 前缀（个人中心凭证），否则拒绝，避免存进无法使用的凭证。
 */

export interface SessionConfig {
  neteaseCookie?: string;
  clientKey?: string;
  [k: string]: unknown;
}

export interface ConfigPatch {
  cookie?: unknown;
  key?: unknown;
  clear?: unknown;
}

export interface SaveResult {
  saved: string[];
  error?: string;
}

const KEY_PREFIX = 'mh_ck_';

export function applyConfigPatch(cur: SessionConfig, patch: ConfigPatch): SaveResult {
  if (patch && patch.clear === true) {
    delete cur.neteaseCookie;
    delete cur.clientKey;
    return { saved: ['clear'] };
  }
  const cookie = typeof patch?.cookie === 'string' ? patch.cookie.trim() : '';
  const key = typeof patch?.key === 'string' ? patch.key.trim() : '';
  if (!cookie && !key) {
    return { saved: [], error: '请填写 Cookie 或客户端密钥（留空不会覆盖已保存值）' };
  }
  if (key && !key.startsWith(KEY_PREFIX)) {
    return { saved: [], error: `客户端密钥需以 ${KEY_PREFIX} 开头（个人中心 → 凭证管理）` };
  }
  const saved: string[] = [];
  if (cookie && cookie !== cur.neteaseCookie) { cur.neteaseCookie = cookie; saved.push('cookie'); }
  if (key && key !== cur.clientKey) { cur.clientKey = key; saved.push('key'); }
  return { saved };
}
