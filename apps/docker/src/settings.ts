/**
 * 管理端配置写入（/api/config → session.json）
 * 规则：
 * - 空值不覆盖已保存值（防止「只改一项」时误清另一项）；
 * - clear:true 才显式清空；
 * - key 必须是 mh_ck_ 前缀（个人中心凭证），否则拒绝，避免存进无法使用的凭证；
 * - 支持多服务端（servers 数组），自动剔除 API 地址末尾斜杠；
 * - 旧版单 key 自动向前迁移并同步维护。
 */

export interface ServerConfigItem {
  id: string;
  name: string;
  baseUrl: string;
  clientKey: string;
  enabled: boolean;
}

export interface SessionConfig {
  neteaseCookie?: string;
  servers: ServerConfigItem[];
  clientKey?: string;
  [k: string]: unknown;
}

export interface ConfigPatch {
  cookie?: unknown;
  key?: unknown;
  servers?: unknown;
  clear?: unknown;
}

export interface SaveResult {
  saved: string[];
  error?: string;
}

const KEY_PREFIX = 'mh_ck_';

export function normalizeServerUrl(url: string): string {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

export function migrateLegacyConfig(cur: SessionConfig, defaultBaseUrl: string = 'https://163music.linyu.qzz.io'): SessionConfig {
  if (!cur.servers) cur.servers = [];
  if (cur.clientKey && cur.clientKey.trim().startsWith(KEY_PREFIX) && cur.servers.length === 0) {
    cur.servers.push({
      id: 'default',
      name: '默认服务端',
      baseUrl: normalizeServerUrl(defaultBaseUrl),
      clientKey: cur.clientKey.trim(),
      enabled: true,
    });
  }
  return cur;
}

export function applyConfigPatch(cur: SessionConfig, patch: ConfigPatch, defaultBaseUrl?: string): SaveResult {
  if (!cur.servers) cur.servers = [];
  migrateLegacyConfig(cur, defaultBaseUrl);

  if (patch && patch.clear === true) {
    delete cur.neteaseCookie;
    delete cur.clientKey;
    cur.servers = [];
    return { saved: ['clear'] };
  }

  const saved: string[] = [];
  const cookie = typeof patch?.cookie === 'string' ? patch.cookie.trim() : '';
  const key = typeof patch?.key === 'string' ? patch.key.trim() : '';

  if (cookie && cookie !== cur.neteaseCookie) {
    cur.neteaseCookie = cookie;
    saved.push('cookie');
  }

  // 旧版单 key 写入兼容：如果传了 key，更新或创建 servers[0]
  if (key) {
    if (!key.startsWith(KEY_PREFIX)) {
      return { saved: [], error: `客户端密钥需以 ${KEY_PREFIX} 开头（个人中心 → 凭证管理）` };
    }
    if (key !== cur.clientKey) {
      cur.clientKey = key;
      saved.push('key');
    }
    if (cur.servers.length === 0) {
      cur.servers.push({
        id: 'default',
        name: '默认服务端',
        baseUrl: normalizeServerUrl(defaultBaseUrl || 'https://163music.linyu.qzz.io'),
        clientKey: key,
        enabled: true,
      });
    } else if (cur.servers[0].clientKey !== key) {
      cur.servers[0].clientKey = key;
    }
  }

  // 多服务端 servers 数组写入
  if (Array.isArray(patch?.servers)) {
    const nextServers: ServerConfigItem[] = [];
    for (let i = 0; i < patch.servers.length; i++) {
      const item = patch.servers[i];
      if (!item || typeof item !== 'object') continue;
      const baseUrl = normalizeServerUrl(String((item as any).baseUrl || ''));
      const sKey = String((item as any).clientKey || '').trim();
      const name = String((item as any).name || `服务端 ${i + 1}`).trim();
      const enabled = (item as any).enabled !== false;

      if (!baseUrl) {
        return { saved: [], error: `第 ${i + 1} 个服务端的 API 地址不能为空` };
      }
      try {
        const u = new URL(baseUrl);
        if (!['http:', 'https:'].includes(u.protocol)) {
          return { saved: [], error: `第 ${i + 1} 个服务端的 API 地址必须是 http 或 https 协议` };
        }
      } catch {
        return { saved: [], error: `第 ${i + 1} 个服务端的 API 地址格式非法：${baseUrl}` };
      }

      if (sKey && !sKey.startsWith(KEY_PREFIX)) {
        return { saved: [], error: `服务端「${name}」的客户端密钥需以 ${KEY_PREFIX} 开头` };
      }

      nextServers.push({
        id: String((item as any).id || `srv-${Date.now()}-${i}`).trim(),
        name,
        baseUrl,
        clientKey: sKey,
        enabled,
      });
    }

    cur.servers = nextServers;
    if (!saved.includes('servers')) saved.push('servers');
  }

  if (saved.length === 0 && !patch?.servers && !cookie && !key) {
    return { saved: [], error: '请填写 Cookie 或配置服务端' };
  }

  return { saved };
}
