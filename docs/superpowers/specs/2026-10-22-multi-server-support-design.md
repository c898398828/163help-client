# 多服务端聚合接入与轮流调度技术规格书 (Multi-Server Support Spec)

> 日期：2026-10-22  
> 状态：Design Approved  
> 适用组件：`apps/docker` (Node.js + Playwright 无头常驻客户端)

---

## 1. 背景与目标

### 1.1 背景
当前互助播放生态中存在多个独立的 163 互助服务端实例（例如官方主服 `https://163music.linyu.qzz.io`，以及社区自建服如 `https://163help.daigua.icu`）。用户在每个服务端各自持有独立账号凭证（`mh_ck_` 客户端密钥）与互助积分。

在既有实现中，`apps/docker` 客户端仅支持连接单个服务端（通过 `API_BASE` 环境变量或单值 `clientKey` 设定）。若用户希望同时在两个或多个服务端赚取积分并贡献播放量，以往只能通过运行多个容器或机器，造成大量计算与内存资源浪费。

### 1.2 核心目标
1. **多服聚合与自定义接入**：支持在单套 `apps/docker` 实例中配置任意数量（1 个、2 个或更多）自定义服务端（包含服务备注名、服务端 URL、客户端密钥与启闭开关）。
2. **并发跑单与轮流调度（Round-Robin）**：在确保底层网易云播放器物理独占的前提下，公平交替为各服务端拉取并播放任务。
3. **零空转与即时避让（Instant Yield）**：当某一服出现无单（`noTarget`）或额度用尽时，该服进入 30 秒独立退避冷却，调度器毫秒级切换至其他活跃服务端，绝不阻塞整体播放流水线。
4. **故障隔离与自愈（Fault Isolation）**：单服出现凭证失效（401）或网络宕机时，仅隔离该故障服务端，其余健康服务端 100% 正常运转；配置修复后自动恢复。
5. **完全向前兼容（Backward Compatibility）**：无缝兼容旧版 `session.json`（单密钥模式）与已有环境变量部署，老用户升级镜像零感知、无迁移负担。

---

## 2. 总体架构与数据模型

### 2.1 架构分层

```
                                  ┌───────────────────────────────┐
                                  │      DockBrowser (Playwright) │
                                  │   (单一网易云页面 / 真实无头播放)  │
                                  └───────────────▲───────────────┘
                                                  │ 独占播放 & 进度订阅
                                  ┌───────────────┴───────────────┐
                                  │     MultiServerScheduler      │
                                  │   (调度仲裁器 / 播放器独占互斥锁) │
                                  └───────▲───────────────▲───────┘
                                          │               │
                                 调度轮询  │               │ 调度轮询
                                          │               │
                            ┌─────────────▼────┐     ┌────▼─────────────┐
                            │  ServerWorker 1  │     │  ServerWorker 2  │
                            │  (163music/主服) │     │  (163help/副服)  │
                            ├──────────────────┤     ├──────────────────┤
                            │ · ClientRuntime  │     │ · ClientRuntime  │
                            │ · AuthManager    │     │ · AuthManager    │
                            │ · JobStateMachine│     │ · JobStateMachine│
                            │ · HeartbeatEngine│     │ · HeartbeatEngine│
                            │ · Transport/Api  │     │ · Transport/Api  │
                            │ · 独立配额与状态  │     │ · 独立配额与状态  │
                            └──────────────────┘     └──────────────────┘
```

### 2.2 数据结构定义 (`apps/docker/src/settings.ts`)

#### 服务端配置项 (`ServerConfigItem`)
```typescript
export interface ServerConfigItem {
  /** 唯一标识符，自动生成（如 "srv-1"） */
  id: string;
  /** 服务备注名（如 "主服 (Linyu)"、"副服 (Daigua)"） */
  name: string;
  /** 服务端接口根地址（如 "https://163music.linyu.qzz.io"） */
  baseUrl: string;
  /** 该服务端的长期客户端密钥（以 mh_ck_ 开头） */
  clientKey: string;
  /** 是否启用该服务端参与跑单调度 */
  enabled: boolean;
}
```

#### 持久化会话配置 (`SessionConfig`)
```typescript
export interface SessionConfig {
  /** 全局单例网易云 Cookie（包含 MUSIC_U） */
  neteaseCookie?: string;
  /** 多服务端配置数组 */
  servers: ServerConfigItem[];

  /** 向前兼容旧版字段（读取时自动迁移至 servers[0]） */
  clientKey?: string;
}
```

#### 多服务端运行状态快照 (`ServerRuntimeState`)
用于 Web 控制台 `/api/state` 接口渲染：
```typescript
export interface ServerRuntimeState {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  configured: boolean;
  authStatus: 'valid' | 'logged_out' | 'no_token';
  acctName: string;
  credits: number;
  helpUsed: number;
  helpLimit: number;
  recv: number;
  recvLimit: number;
  jobsDone: number;
  lastApi: { ok: boolean; status: number; at: number; error?: string } | null;
  cooldownUntil: number; // 0 表示无冷却
}
```

---

## 3. 核心机制与调度算法

### 3.1 播放器锁与轮流调度算法 (`MultiServerScheduler`)
调度器管理一组 `ServerWorker`，并通过基于优先轮替与退避的 Round-Robin 算法分发任务请求：

```
[开始轮询] ───────────┐
      │               │
      ▼               ▼
是否有活跃任务正在播放？
  ├─ 是 ──> 挂起等待当前任务结算完成 / 放弃
  └─ 否 ──> 寻找下一候选 Server：
             1. enabled === true
             2. authStatus !== 'logged_out'
             3. cooldownUntil <= Date.now()
             │
             ├─ 找到候选 Server X：
             │    │
             │    ├── 授权 Server X 调用 next() 领单
             │    │     ├─ [领到歌曲] ──> Server X 独占播放器起播，启动心跳上报
             │    │     │                 调度器挂起等待播放完毕；
             │    │     │                 结算释放锁后，轮替指针后移 (index + 1)
             │    │     │
             │    │     └─ [返回无单 noTarget] ──> Server X 记录 cooldownUntil = now + 30s
             │    │                                立即尝试下一候选 Server（零秒切换！）
             │    │
             │    └─ [遇到网络错误/异常] ──> Server X 指数退避 (5s..30s)
             │
             └─ 所有 Server 均处于无单退避或不可用：
                  调度器休眠至 min(最近冷却结束时间, 3秒)，随后再次检查
```

### 3.2 播放进度与心跳隔离原则
每个 `ServerWorker` 持有独立的 `ClientRuntime`，同时共享底层 `DockBrowser` 的 `progress` 事件监听器：
* 当 Server 1 处于 `playing` 阶段时，Server 2 必定处于 `idle` 阶段；
* `packages/core` 中已保证：处于 `idle` 的 Runtime 在接收到 `player.onProgress` 进度信号时，首行 `if (this.job.phase !== 'playing') return;` 将直接安全丢弃；
* 只有当前正在播放的 Server 能够接收进度并驱动其专属心跳包（`/api/heartbeat`）上报至对应的服务端，实现**物理共享、逻辑隔离**。

---

## 4. 容灾与故障隔离矩阵

| 场景 | 影响范围 | 系统行为 | 恢复策略 |
| :--- | :--- | :--- | :--- |
| **单服密钥失效 (401)** | 仅影响该失效服务端 | 该 Server 标记为 `authStatus='logged_out'`，移出活跃调度队；**其他服务端独占全部算力全速跑单** | 用户在 Web 设置页修正该服密钥并保存后，自动恢复调度 |
| **单服网络超时 / 5xx** | 仅影响该异常服务端 | 该 Server 记录通信失败并短退避（5s..30s）；调度器自动切换至其余可用服务端 | 后台探活协程（每 30s `/api/me`）探测到 200 后自动解除退避 |
| **双服/全服无单** | 全局暂停播放 | 各 Server 分别记录各自独立的 30s 冷却，调度器整体休眠至最早冷却结束时间点 | 任一服冷却到期立即发起拉单，无单则继续休眠，绝不高频刷接口 |
| **浏览器意外崩溃** | 所有服务暂停 | 当前播放单上报 `abandon('browser_crash')` 避免卡单；调度器等待 `recoverBrowser()` 重建无头 Chrome | 浏览器重建完毕后自动恢复双服轮询 |
| **在线配置修改/增删服务** | 短暂平滑等待 | 调度器暂停分发新单；若有在途歌曲则等待其播放结算完毕；完成 `session.json` 写盘并平滑重构 Worker | 重构后无缝开启全新多服务端循环 |

---

## 5. Web 控制台交互设计 (`apps/docker/src/page.ts`)

### 5.1 总览页 (Overview)
* **Now Playing 卡片**：
  * 在状态栏左侧增加高亮服务端归属标识徽章（如 `[主服 · 163music]` / `[副服 · 163help]`）；
  * 保持进度条与 30 条心跳律动图实时同步。
* **服务端状态卡片矩阵 (Server Cards Grid)**：
  * 将原本单体卡片扩展为自适应网格，每个配置的服务端展示独立仪表盘：
    * 服务端备注名与基地址；
    * 运行状态徽章（在线 / 无单避让 / 凭证失效 / 网络异常）；
    * 互助秒数进度：`已用 / 上限 (秒)`；
    * 今日受助进度：`已达 / 上限 (首)`；
    * 当前累积积分；
    * 本服累计完成单数；
    * 最近通信状态（如 `200 正常 · 2s 前`）。
* **日志分流标签**：
  * 日志输出统一增加服务前缀：`[主服]`、`[副服]`，清晰追踪多服运转轨迹。

### 5.2 设置页 (Settings)
* **网易云 Cookie 区域**：保持全局单例文本域。
* **多服务端管理列表**：
  * 列表渲染已配置的服务端；
  * 每个服务端卡片内提供：
    1. 备注名称输入框（如「主服」、「Daigua自建服」）；
    2. 服务端 API 地址输入框（支持自定义 URL）；
    3. 客户端密钥输入框（`mh_ck_xxxx`，安全隐藏）；
    4. 启用/停用 Switch 开关；
    5. 删除按钮（当服务端多于 1 个时展示）。
  * 列表末尾提供 **「➕ 添加新服务端」** 按钮；
  * 底部提供统一「保存并应用」按钮，执行校验、排空并落盘。

---

## 6. 测试与验证策略

### 6.1 单元测试 (`tests/settings.test.ts`)
* 验证老版本 `session.json`（单 `clientKey` 结构）自动迁移升级；
* 验证服务端 URL 规范化（自动去除末尾斜杠）；
* 验证 `clientKey` 必须满足 `mh_ck_` 前缀；
* 验证服务端项的增、删、改、禁用补丁逻辑。

### 6.2 调度器与并发测试 (`tests/scheduler.test.ts`)
* **Round-Robin 轮换验证**：Mock S1 与 S2，验证任务交替执行序列（S1 → S2 → S1 → S2）；
* **无单快速让位测试**：Mock S1 返回 `noTargetReason`，验证 S2 立即被调用起播，无额外延迟；
* **单服 401 隔离测试**：Mock S1 触发 401，验证 S1 停运、S2 独占播放器持续跑单；
* **互斥锁有效性验证**：断言任何时刻绝无两个服务端同时处于 `fetching` 或 `playing` 状态。

---

## 7. 实施计划 (Milestones)

1. **Phase 1**：数据层与配置迁移改造（`settings.ts` + `settings.test.ts`）；
2. **Phase 2**：调度器与 Worker 编排开发（`scheduler.ts` + `scheduler.test.ts`）；
3. **Phase 3**：容器主入口协同接入（`main.ts` + 生命周期整合）；
4. **Phase 4**：Web 控制台界面与 API 升级（`server.ts` + `page.ts`）；
5. **Phase 5**：冒烟验证与回归测试。
