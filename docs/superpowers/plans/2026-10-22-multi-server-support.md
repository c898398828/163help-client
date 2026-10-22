# 多服务端聚合接入与轮流调度实施计划 (Multi-Server Support Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `apps/docker` 客户端实现多服务端（如 `163music.linyu.qzz.io` 与 `163help.daigua.icu` 等自定义服务端）的聚合接入、轮流调度（Round-Robin）、故障隔离与 Web 控制台可视化管理。

**Architecture:** 
- 在数据层通过 `ServerConfigItem[]` 支持自定义服务端列表并无缝向前兼容既有配置；
- 在调度层引入中央调度器（`MultiServerScheduler`），基于播放器互斥锁（Player Mutex）在各服务端 Worker 间公平分配播放权，支持无单（`noTarget`）即时避让与单服 401 故障隔离；
- 在展现层升级 Web 控制台，提供多服务端独立额度卡片矩阵与动态表单配置。

**Tech Stack:** Node.js (v18+), TypeScript, Playwright, Node native test runner (`node --test`), esbuild.

**Spec:** `docs/superpowers/specs/2026-10-22-multi-server-support-design.md`

## Global Constraints
- 所有修改收敛在 `apps/docker`，不破坏 `packages/core` 公共导出和已有契约；
- 保留对旧版 `session.json`（单 `clientKey` 结构）以及单环境变量（`API_BASE`、`CLIENT_KEY`）的 100% 自动迁移与兼容；
- 每个服务端的客户端密钥必须以 `mh_ck_` 开头；服务端根地址必须规范化为无末尾斜杠；
- 单一网易云播放器物理独占，同一时刻绝不允许两个服务端同时起播或处于拉单竞态；
- 遵循 TDD 规范：测试先行，确保单元与集成测试均跑通。

---

### Task 1: 数据模型与配置管理改造 (`settings.ts`)

**Files:**
- Modify: `apps/docker/src/settings.ts`
- Modify: `apps/docker/tests/settings.test.ts`

**Interfaces:**
- Consumes: `SessionConfig`, `ConfigPatch`
- Produces:
  ```typescript
  export interface ServerConfigItem {
    id: string;
    name: string;
    baseUrl: string;
    clientKey: string;
    enabled: boolean;
  }
  export function normalizeServerUrl(url: string): string;
  export function migrateLegacyConfig(cur: SessionConfig, defaultBaseUrl?: string): SessionConfig;
  export function applyConfigPatch(cur: SessionConfig, patch: ConfigPatch): SaveResult;
  ```

- [ ] **Step 1: 编写数据模型与配置迁移测试**

在 `apps/docker/tests/settings.test.ts` 中追加针对多服务端与配置迁移的测试用例：
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyConfigPatch, migrateLegacyConfig, normalizeServerUrl, type SessionConfig } from '../src/settings.ts';

test('normalizeServerUrl 规范化 URL', () => {
  assert.equal(normalizeServerUrl('https://163music.linyu.qzz.io/'), 'https://163music.linyu.qzz.io');
  assert.equal(normalizeServerUrl('http://192.168.1.100:8080/api/'), 'http://192.168.1.100:8080/api');
});

test('migrateLegacyConfig 自动将旧版单 key 转换为 servers 数组', () => {
  const legacy: SessionConfig = {
    neteaseCookie: 'MUSIC_U=test',
    clientKey: 'mh_ck_legacy',
    servers: [],
  };
  const migrated = migrateLegacyConfig(legacy, 'https://default.server');
  assert.equal(migrated.servers.length, 1);
  assert.equal(migrated.servers[0].clientKey, 'mh_ck_legacy');
  assert.equal(migrated.servers[0].baseUrl, 'https://default.server');
  assert.equal(migrated.servers[0].enabled, true);
});

test('applyConfigPatch 支持多服务端数组写入与校验', () => {
  const cur: SessionConfig = { servers: [] };
  const patch = {
    servers: [
      { id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io/', clientKey: 'mh_ck_s1', enabled: true },
      { id: 's2', name: '副服', baseUrl: 'https://163help.daigua.icu', clientKey: 'mh_ck_s2', enabled: false }
    ]
  };
  const res = applyConfigPatch(cur, patch);
  assert.equal(res.saved.includes('servers'), true);
  assert.equal(cur.servers.length, 2);
  assert.equal(cur.servers[0].baseUrl, 'https://163music.linyu.qzz.io'); // 末尾斜杠剔除
  assert.equal(cur.servers[1].enabled, false);
});

test('applyConfigPatch 校验服务端密钥前缀', () => {
  const cur: SessionConfig = { servers: [] };
  const patch = {
    servers: [
      { id: 's1', name: '主服', baseUrl: 'https://163music.linyu.qzz.io', clientKey: 'bad_token', enabled: true }
    ]
  };
  const res = applyConfigPatch(cur, patch);
  assert.equal(Boolean(res.error), true);
  assert.equal(res.saved.length, 0);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --test apps/docker/tests/settings.test.ts`  
预期：FAIL，报 `normalizeServerUrl` 或 `migrateLegacyConfig` 未定义。

- [ ] **Step 3: 实现配置与数据模型改造**

在 `apps/docker/src/settings.ts` 中实现：
```typescript
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
    cur.clientKey = key;
    if (cur.servers.length === 0) {
      cur.servers.push({
        id: 'default',
        name: '默认服务端',
        baseUrl: normalizeServerUrl(defaultBaseUrl || 'https://163music.linyu.qzz.io'),
        clientKey: key,
        enabled: true,
      });
      saved.push('servers');
    } else if (cur.servers[0].clientKey !== key) {
      cur.servers[0].clientKey = key;
      saved.push('servers');
    }
    if (!saved.includes('key')) saved.push('key');
  }

  // 多服务端 servers 数组写入
  if (Array.isArray(patch?.servers)) {
    const nextServers: ServerConfigItem[] = [];
    for (let i = 0; i < patch.servers.length; i++) {
      const item = patch.servers[i];
      if (!item || typeof item !== 'object') continue;
      const baseUrl = normalizeServerUrl(String(item.baseUrl || ''));
      const sKey = String(item.clientKey || '').trim();
      const name = String(item.name || `服务端 ${i + 1}`).trim();
      const enabled = item.enabled !== false;

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
        id: String(item.id || `srv-${Date.now()}-${i}`).trim(),
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
```

- [ ] **Step 4: 运行测试验证通过**

运行：`node --test apps/docker/tests/settings.test.ts`  
预期：PASS（全部测试通过）。

- [ ] **Step 5: 提交更改**

```bash
git add apps/docker/src/settings.ts apps/docker/tests/settings.test.ts
git commit -m "feat(docker): 支持多服务端配置模型与向前兼容迁移

Co-Authored-By: BaoCode <noreply@baocode.dev>"
```

---

### Task 2: 多服调度仲裁器开发 (`scheduler.ts`)

**Files:**
- Create: `apps/docker/src/scheduler.ts`
- Create: `apps/docker/tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `ServerConfigItem`
- Produces:
  ```typescript
  export interface SchedulerTurnGrant {
    serverId: string;
    release: (outcome: 'settled' | 'abandoned' | 'no_job' | 'error') => void;
  }
  export class MultiServerScheduler {
    constructor(opts?: { noTargetCooldownMs?: number });
    registerServer(id: string, getEligibility: () => { enabled: boolean; eligible: boolean }): void;
    unregisterServer(id: string): void;
    setCooldown(serverId: string, ms?: number): void;
    getCooldownUntil(serverId: string): number;
    acquireTurn(serverId: string): Promise<(() => void) | null>;
    requestNextTurn(): Promise<SchedulerTurnGrant | null>;
    pause(): void;
    resume(): void;
    reset(): void;
  }
  ```

- [ ] **Step 1: 编写调度器单元与并发测试**

创建 `apps/docker/tests/scheduler.test.ts`：
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiServerScheduler } from '../src/scheduler.ts';

test('Round-Robin 交替调度', async () => {
  const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 1000 });
  scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
  scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

  const t1 = await scheduler.requestNextTurn();
  assert.equal(t1?.serverId, 's1');
  t1.release('settled');

  const t2 = await scheduler.requestNextTurn();
  assert.equal(t2?.serverId, 's2');
  t2.release('settled');

  const t3 = await scheduler.requestNextTurn();
  assert.equal(t3?.serverId, 's1');
  t3.release('settled');
});

test('无单 noTarget 即时避让下一服务', async () => {
  const scheduler = new MultiServerScheduler({ noTargetCooldownMs: 5000 });
  scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
  scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

  const t1 = await scheduler.requestNextTurn();
  assert.equal(t1?.serverId, 's1');
  scheduler.setCooldown('s1', 5000);
  t1.release('no_job');

  // s1 在冷却中，下一次应该立刻给 s2
  const t2 = await scheduler.requestNextTurn();
  assert.equal(t2?.serverId, 's2');
  t2.release('settled');
});

test('互斥锁：同一时间只能有一个服务获得播放权', async () => {
  const scheduler = new MultiServerScheduler();
  scheduler.registerServer('s1', () => ({ enabled: true, eligible: true }));
  scheduler.registerServer('s2', () => ({ enabled: true, eligible: true }));

  const t1 = await scheduler.requestNextTurn();
  assert.equal(t1?.serverId, 's1');

  // 在 t1 未释放前，尝试获取下一个 turn 应该等待或返回 null
  let nextGranted = false;
  const pNext = scheduler.requestNextTurn().then((t) => {
    nextGranted = true;
    return t;
  });

  // 短暂等待，验证 pNext 仍在排队未立即放行
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(nextGranted, false);

  t1.release('settled');
  const t2 = await pNext;
  assert.equal(t2?.serverId, 's2');
  t2?.release('settled');
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --test apps/docker/tests/scheduler.test.ts`  
预期：FAIL，找不到模块 `../src/scheduler.ts`。

- [ ] **Step 3: 实现 MultiServerScheduler**

创建 `apps/docker/src/scheduler.ts`：
```typescript
export interface SchedulerTurnGrant {
  serverId: string;
  release: (outcome: 'settled' | 'abandoned' | 'no_job' | 'error') => void;
}

interface RegisteredServer {
  id: string;
  getEligibility: () => { enabled: boolean; eligible: boolean };
  cooldownUntil: number;
}

export class MultiServerScheduler {
  private servers: RegisteredServer[] = [];
  private cursor = 0;
  private activeHolder: string | null = null;
  private waitQueue: Array<() => void> = [];
  private paused = false;
  private readonly defaultCooldownMs: number;

  constructor(opts?: { noTargetCooldownMs?: number }) {
    this.defaultCooldownMs = opts?.noTargetCooldownMs ?? 30_000;
  }

  registerServer(id: string, getEligibility: () => { enabled: boolean; eligible: boolean }): void {
    const existing = this.servers.find((s) => s.id === id);
    if (existing) {
      existing.getEligibility = getEligibility;
    } else {
      this.servers.push({ id, getEligibility, cooldownUntil: 0 });
    }
  }

  unregisterServer(id: string): void {
    this.servers = this.servers.filter((s) => s.id !== id);
    if (this.activeHolder === id) {
      this.activeHolder = null;
      this.pumpQueue();
    }
  }

  setCooldown(serverId: string, ms?: number): void {
    const s = this.servers.find((x) => x.id === serverId);
    if (s) {
      s.cooldownUntil = Date.now() + (typeof ms === 'number' ? ms : this.defaultCooldownMs);
    }
  }

  getCooldownUntil(serverId: string): number {
    const s = this.servers.find((x) => x.id === serverId);
    return s ? s.cooldownUntil : 0;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pumpQueue();
  }

  reset(): void {
    this.activeHolder = null;
    this.cursor = 0;
    this.waitQueue = [];
    this.servers = [];
  }

  async acquireTurn(serverId: string): Promise<(() => void) | null> {
    while (this.activeHolder !== null && this.activeHolder !== serverId) {
      if (this.paused) return null;
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    if (this.paused) return null;
    this.activeHolder = serverId;
    return () => {
      if (this.activeHolder === serverId) {
        this.activeHolder = null;
        this.pumpQueue();
      }
    };
  }

  async requestNextTurn(): Promise<SchedulerTurnGrant | null> {
    while (this.activeHolder !== null) {
      if (this.paused) return null;
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    if (this.paused || this.servers.length === 0) return null;

    const n = this.servers.length;
    const now = Date.now();
    let picked: RegisteredServer | null = null;

    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const s = this.servers[idx];
      const elig = s.getEligibility();
      if (elig.enabled && elig.eligible && s.cooldownUntil <= now) {
        picked = s;
        this.cursor = (idx + 1) % n;
        break;
      }
    }

    if (!picked) return null;

    this.activeHolder = picked.id;
    return {
      serverId: picked.id,
      release: (_outcome) => {
        if (this.activeHolder === picked.id) {
          this.activeHolder = null;
          this.pumpQueue();
        }
      },
    };
  }

  private pumpQueue(): void {
    const next = this.waitQueue.shift();
    if (next) next();
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`node --test apps/docker/tests/scheduler.test.ts`  
预期：PASS（全部测试通过）。

- [ ] **Step 5: 提交更改**

```bash
git add apps/docker/src/scheduler.ts apps/docker/tests/scheduler.test.ts
git commit -m "feat(docker): 增加多服务端调度仲裁器 MultiServerScheduler

Co-Authored-By: BaoCode <noreply@baocode.dev>"
```

---

### Task 3: ServerWorker 封装与 Core Runtime 协同 (`worker.ts`)

**Files:**
- Create: `apps/docker/src/worker.ts`
- Create: `apps/docker/tests/worker.test.ts`

**Interfaces:**
- Consumes: `ClientRuntime`, `ServerConfigItem`, `MultiServerScheduler`
- Produces:
  ```typescript
  export class ServerWorker {
    readonly config: ServerConfigItem;
    readonly runtime: ClientRuntime;
    constructor(deps: WorkerDeps);
    start(): Promise<void>;
    stop(): Promise<void>;
    getState(): ServerRuntimeState;
  }
  ```

- [ ] **Step 1: 编写 ServerWorker 单元测试**

创建 `apps/docker/tests/worker.test.ts`：
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerWorker } from '../src/worker.ts';
import { MultiServerScheduler } from '../src/scheduler.ts';

test('ServerWorker 初始化与状态收集', async () => {
  const scheduler = new MultiServerScheduler();
  const config = {
    id: 's1',
    name: '测试主服',
    baseUrl: 'https://mock.server',
    clientKey: 'mh_ck_test',
    enabled: true,
  };
  const worker = new ServerWorker({
    config,
    scheduler,
    clientVersion: '5.1',
    getIdentity: async () => ({ id: 'u1', name: 'User', vipType: 0 }),
    player: {
      play: async () => true,
      stop: async () => {},
      onProgress: () => {},
    },
    pushLog: () => {},
  });

  const state = worker.getState();
  assert.equal(state.id, 's1');
  assert.equal(state.name, '测试主服');
  assert.equal(state.enabled, true);
  await worker.stop();
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --test apps/docker/tests/worker.test.ts`  
预期：FAIL，找不到模块 `../src/worker.ts`。

- [ ] **Step 3: 实现 ServerWorker**

创建 `apps/docker/src/worker.ts`：
```typescript
import { ClientRuntime } from '../../../packages/core/src/index.ts';
import type { ServerConfigItem } from './settings.ts';
import { createApi } from './api.ts';
import { createTransport } from './transport.ts';
import { MultiServerScheduler } from './scheduler.ts';

export interface ServerRuntimeState {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  configured: boolean;
  authStatus: string;
  acctName: string;
  credits: number;
  helpUsed: number;
  helpLimit: number;
  recv: number;
  recvLimit: number;
  jobsDone: number;
  lastApi: { ok: boolean; status: number; at: number; error?: string } | null;
  cooldownUntil: number;
}

export interface WorkerDeps {
  config: ServerConfigItem;
  scheduler: MultiServerScheduler;
  clientVersion: string;
  getIdentity: () => Promise<{ id: string; name: string; vipType: number }>;
  player: {
    play: (musicId: string, durationMs: number, ownerName: string) => Promise<any>;
    stop: () => Promise<void> | void;
    onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number) => void) => void;
  };
  pushLog: (level: string, msg: string) => void;
}

export class ServerWorker {
  readonly config: ServerConfigItem;
  readonly runtime: ClientRuntime;
  private scheduler: MultiServerScheduler;
  private pushLog: (level: string, msg: string) => void;
  private state: ServerRuntimeState;
  private currentReleaseTurn: (() => void) | null = null;

  constructor(deps: WorkerDeps) {
    this.config = deps.config;
    this.scheduler = deps.scheduler;
    this.pushLog = deps.pushLog;

    this.state = {
      id: deps.config.id,
      name: deps.config.name,
      baseUrl: deps.config.baseUrl,
      enabled: deps.config.enabled,
      configured: Boolean(deps.config.clientKey.trim()),
      authStatus: '',
      acctName: '',
      credits: 0,
      helpUsed: 0,
      helpLimit: 9000,
      recv: 0,
      recvLimit: 26,
      jobsDone: 0,
      lastApi: null,
      cooldownUntil: 0,
    };

    const setLastApi = (r: { ok: boolean; status: number; at: number; error?: string }) => {
      this.state.lastApi = { ok: r.ok, status: r.status, at: r.at, error: r.error };
      if (!r.ok) {
        if (r.status === 401) {
          this.pushLog('error', `[${this.config.name}] 凭证被拒绝 (401)，已停止本服领单`);
        } else if (r.status === 0) {
          this.pushLog('warn', `[${this.config.name}] 网络不可达 (${r.error || '超时'})`);
        }
      }
    };

    const api = createApi({
      base: deps.config.baseUrl,
      version: deps.clientVersion,
      clientType: 'docker',
      getToken: () => this.config.clientKey,
      extraHeaders: () => ({}),
      onResult: setLastApi,
    });

    const transport = createTransport({
      api,
      getIdentity: deps.getIdentity,
      onHeartbeatRejected: (f) => {
        this.pushLog('warn', `[${this.config.name}] 心跳未获确认：${f.error}（任务 ${f.jobId}）`);
      },
    });

    const gatedTransport = {
      ...transport,
      next: async (token: string) => {
        if (!this.config.enabled) {
          return { status: 200, payload: { musicId: null, noTargetReason: 'server_disabled' } };
        }
        const releaseTurn = await this.scheduler.acquireTurn(this.config.id);
        if (!releaseTurn) {
          return { status: 200, payload: { musicId: null, noTargetReason: 'scheduler_paused' } };
        }
        this.currentReleaseTurn = releaseTurn;
        try {
          const res = await transport.next(token);
          if (!res.payload || !res.payload.jobId) {
            // 无单或失败，立即让出播放权
            if (res.payload?.noTargetReason) {
              this.scheduler.setCooldown(this.config.id);
              this.state.cooldownUntil = this.scheduler.getCooldownUntil(this.config.id);
            }
            this.releaseCurrentTurn();
          }
          return res;
        } catch (e) {
          this.releaseCurrentTurn();
          throw e;
        }
      },
      finish: async (token: string, input: any) => {
        try {
          return await transport.finish(token, input);
        } finally {
          this.releaseCurrentTurn();
        }
      },
      abandon: async (token: string, r: string, d: string, jobId?: string) => {
        try {
          await transport.abandon(token, r, d, jobId);
        } finally {
          this.releaseCurrentTurn();
        }
      },
    };

    this.runtime = new ClientRuntime({
      adapter: {
        clientType: 'docker',
        version: deps.clientVersion,
        storage: {
          getToken: () => this.config.clientKey,
          setToken: () => {},
          clearToken: () => {},
          getExpires: () => 0,
          setExpires: () => {},
        },
        probeNetwork: async () => true,
        hasPage: false,
      },
      transport: gatedTransport,
      player: deps.player,
    } as any);

    this.scheduler.registerServer(this.config.id, () => ({
      enabled: this.config.enabled,
      eligible: this.state.authStatus !== 'logged_out',
    }));

    this.runtime.bus.on('job:settled', (s: any) => { if (s?.credited) this.state.jobsDone++; });
    this.runtime.bus.on('auth:user', (u: any) => {
      this.state.acctName = u?.displayName || '';
      this.state.credits = u?.credits || 0;
    });
    this.runtime.bus.on('auth:status', (s: string) => { this.state.authStatus = s; });
    this.runtime.bus.on('limits:updated', (s: any) => {
      this.state.helpUsed = s?.helpedToday || 0;
      this.state.helpLimit = s?.helpedLimit || 9000;
      this.state.recv = s?.receivedToday || 0;
      this.state.recvLimit = s?.receivedLimit || 26;
    });
    this.runtime.bus.on('log:append', (e: any) => {
      this.pushLog(e.level, `[${this.config.name}] ${e.msg}`);
    });
  }

  private releaseCurrentTurn(): void {
    if (this.currentReleaseTurn) {
      const rel = this.currentReleaseTurn;
      this.currentReleaseTurn = null;
      rel();
    }
  }

  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.clientKey.trim()) return;
    await this.runtime.start(true);
  }

  async stop(): Promise<void> {
    this.releaseCurrentTurn();
    this.scheduler.unregisterServer(this.config.id);
    await this.runtime.suspend('worker_stopped');
  }

  getState(): ServerRuntimeState {
    this.state.cooldownUntil = this.scheduler.getCooldownUntil(this.config.id);
    return { ...this.state };
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`node --test apps/docker/tests/worker.test.ts`  
预期：PASS（全部测试通过）。

- [ ] **Step 5: 提交更改**

```bash
git add apps/docker/src/worker.ts apps/docker/tests/worker.test.ts
git commit -m "feat(docker): 封装 ServerWorker 统一接入 Core Runtime 与调度器

Co-Authored-By: BaoCode <noreply@baocode.dev>"
```

---

### Task 4: 主入口与多服生命周期整合 (`main.ts`)

**Files:**
- Modify: `apps/docker/src/main.ts`
- Modify: `apps/docker/tests/main.test.ts`

**Interfaces:**
- Consumes: `MultiServerScheduler`, `ServerWorker`, `SessionConfig`
- Produces: 多服务端协同主进程与配置热重载

- [ ] **Step 1: 编写多服生命周期与配置测试**

在 `apps/docker/tests/main.test.ts` 中增加针对多服务 Worker 生命周期初始化的测试用例：
```typescript
test('main 配置热重载支持无缝重构 ServerWorker 列表', async () => {
  // 验证配置变更时旧 Worker 正常 suspend，新 Worker 正常加入调度
});
```

- [ ] **Step 2: 重构 main.ts 引入多服调度**

更新 `apps/docker/src/main.ts`：
1. 载入配置时调用 `migrateLegacyConfig(boot, BASE)`；
2. 实例化全局 `MultiServerScheduler`；
3. 维护 `workers: Map<string, ServerWorker>`；
4. 环境变量兼容注入：若存在 `SERVER_1_URL`、`SERVER_1_KEY` 等则合并注入；
5. 重写 `state.onConfig`，排空旧 Worker 并根据最新 `cur.servers` 重新构建 Worker 映射；
6. 在 `state` 快照上透出 `servers: Array<ServerRuntimeState>`，供 `/api/state` 消费。

- [ ] **Step 3: 运行主测试套件验证通过**

运行：`node --test apps/docker/tests/main.test.ts`  
预期：PASS（全部测试通过）。

- [ ] **Step 4: 提交更改**

```bash
git add apps/docker/src/main.ts apps/docker/tests/main.test.ts
git commit -m "feat(docker): 主入口集成 MultiServerScheduler 与多服生命周期

Co-Authored-By: BaoCode <noreply@baocode.dev>"
```

---

### Task 5: Web 控制台 API 与页面 UI 升级 (`server.ts`, `page.ts`)

**Files:**
- Modify: `apps/docker/src/server.ts`
- Modify: `apps/docker/src/page.ts`
- Modify: `apps/docker/tests/server.test.ts`
- Modify: `apps/docker/tests/page.test.ts`

**Interfaces:**
- Consumes: `state.servers`
- Produces:
  - `/api/state` JSON 包含 `servers: ServerRuntimeState[]`
  - `/api/config` 接收并返回 `servers` 变更
  - 玻璃拟态控制台渲染多服卡片矩阵与动态增删配置表单

- [ ] **Step 1: 编写控制台 API 与页面测试**

在 `apps/docker/tests/server.test.ts` 中验证 `/api/state` 返回多服状态：
```typescript
test('/api/state 透出 servers 数组', async () => {
  // 验证返回状态体中包含 servers 字段且正确反映各服指标
});
```

- [ ] **Step 2: 升级 server.ts 的 /api/state 返回**

在 `apps/docker/src/server.ts` 的 `GET /api/state` 处理中，补充 `servers: state.servers || []`，保持旧字段（`acctName`、`credits` 等）聚合透出。

- [ ] **Step 3: 升级 page.ts 前端视图与交互**

在 `apps/docker/src/page.ts` 中：
1. **总览页**：
   - Now Playing 标题前增设服务端名称徽章；
   - 渲染 `#serverCards` 容器，利用 `state.servers` 动态渲染每个服务端的指标卡片；
2. **设置页**：
   - 增加多服务端管理表单（动态增删改各服务行的「备注名」、「地址」、「密钥」、「启用开关」）；
   - 提供「➕ 添加自定义服务端」按钮与各行删除按钮；
   - 点击保存时组装 `{ cookie, servers }` 提交至 `/api/config`。

- [ ] **Step 4: 运行控制台测试**

运行：`node --test apps/docker/tests/server.test.ts apps/docker/tests/page.test.ts`  
预期：PASS。

- [ ] **Step 5: 提交更改**

```bash
git add apps/docker/src/server.ts apps/docker/src/page.ts apps/docker/tests/server.test.ts apps/docker/tests/page.test.ts
git commit -m "feat(docker): 控制台 UI 与 API 支持多服务端卡片展示与动态配置

Co-Authored-By: BaoCode <noreply@baocode.dev>"
```

---

### Task 6: 全链路冒烟验证与回归 (`smoke.mjs`)

**Files:**
- Modify: `apps/docker/smoke.mjs`

- [ ] **Step 1: 执行本地完整单元测试集**

运行：`node --test apps/docker/tests/*.test.ts`  
预期：所有单测（60+ 测试）100% 通过。

- [ ] **Step 2: 执行构建打包验证**

运行：`node ./node_modules/esbuild/bin/esbuild apps/docker/src/main.ts --bundle --format=esm --platform=node --outfile=apps/docker/dist/main.js --external:playwright-core`  
预期：构建成功，生成 `apps/docker/dist/main.js`，无编译与打包错误。

- [ ] **Step 3: 冒烟测试验证**

运行：`node apps/docker/smoke.mjs`  
预期：通过。

- [ ] **Step 4: 最终提交**

```bash
git commit -m "test(docker): 完成多服务端聚合调度全链路验证与构建确认

Co-Authored-By: BaoCode <noreply@baocode.dev>"
```
