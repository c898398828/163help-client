# 163help-client 🎵

> 当前版本：**v5.1**

网易云音乐互助播放的**客户端**仓库：客户端源码（monorepo）+ 发布产物（油猴脚本 / Chrome 扩展 / Docker 常驻客户端）都在这里。

## 这是什么

一个网易云音乐**互助播放**工具：用户之间互相帮助播放歌曲——你帮别人放歌赚积分，用积分换别人帮你放歌，从而完成任务（如音乐人每月 650 次播放量任务）。

**不卖播放量、不收费、不搞会员，纯社区互助。**

## 安装方式（三选一）

### 方式 A：油猴脚本

1. 安装浏览器插件 [Tampermonkey](https://www.tampermonkey.net/)（油猴）
2. 打开下方地址，Tampermonkey 会弹出安装确认，点「安装」：

   ```
   https://163music.linyu.qzz.io/music-help.user.js
   ```

3. 打开网页版 [music.163.com](https://music.163.com/)，页面右侧出现「🎵 互助面板」

### 方式 B：Chrome 浏览器扩展（无需 Tampermonkey）

扩展版是油猴脚本的完整移植，额外提供**开机自启 + 标签静音**，适合想把浏览器常驻挂着的人：

1. 下载本仓库 [Releases](https://github.com/y08lin4/163help-client/releases) 里的 `163help-extension-v5.1.zip`（或直接 clone 本仓库取 `extension/` 目录）
2. Chrome 打开 `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」，选择 `extension/` 目录（直接包含 `manifest.json` 的那一层）
5. 扩展会自动打开一个静音的网易云标签，登录后即可使用

> 扩展版只静音网易云标签，其它标签不受影响。

### 方式 C：Docker 常驻客户端（VPS 24 小时在线互助）

不需要打开浏览器，把客户端放进 Docker 容器，在 VPS 上 **24 小时常驻互助**：无头浏览器（Playwright Chromium）真实播放，一个容器 = 一个网易云账号。当前版本 **v5.1**，镜像已公开、匿名可拉取。

**一键脚本（自动选择镜像通道）**：脚本默认先试 GitHub GHCR、失败自动切换 Cloudflare CDN；国内 VPS 可 `IMAGE_SOURCE=cdn` 强制走 CDN（免登录、更稳）：

```bash
curl -fsSL https://raw.githubusercontent.com/y08lin4/163help-client/main/client-docker/scripts/vps-setup.sh -o vps-setup.sh
chmod +x vps-setup.sh
运行 ./vps-setup.sh（交互式输入 UI_PASSWORD，不显示）
```

**双通道手动安装（任选其一）**

通道 A：GitHub GHCR（海外推荐）——镜像已公开、匿名可拉取，无需 `docker login`：

```bash
docker run -d \
  --name 163music-docker-client \
  --restart unless-stopped \
  --memory 1g \
  -e UI_PASSWORD='你的强密码' \
  -e TZ=Asia/Shanghai \
  -p 13000:3000 \
  -v ./data:/data \
  ghcr.io/y08lin4/163help-client/docker-client:latest
```

通道 B：Cloudflare CDN tar（国内推荐）——无需登录任何 registry，国内拉取更稳：

```bash
# 1. 下载 tar 包（附 .sha256 校验文件，可选校验）
curl -fSL -o /tmp/163music-docker-client.tar.gz \
  https://163music.linyu.qzz.io/docker/163music-docker-client-latest.tar.gz
curl -fSL -o /tmp/163music-docker-client.tar.gz.sha256 \
  https://163music.linyu.qzz.io/docker/163music-docker-client-latest.tar.gz.sha256
(cd /tmp && sha256sum -c 163music-docker-client-latest.tar.gz.sha256)

# 2. 导入镜像（镜像名与通道 A 相同，随后执行通道 A 的 docker run 命令即可）
docker load -i /tmp/163music-docker-client.tar.gz
```

**要点**

- **`UI_PASSWORD` 必设强密码**：Web 管理界面登录用，未设置容器会拒绝启动。
- **管理界面**：`http://IP:13000`，粘贴网易云 Cookie + portal 客户端密钥（`mh_ck_` 开头）即可长期运行；宿主机端口冲突时自行映射，如 `-p 13000:3000`。
- **数据持久化**：`-v ./data:/data`（cookie / store / 会话），升级不丢数据。
- **升级**：`docker pull ghcr.io/y08lin4/163help-client/docker-client:latest` → `docker rm -f 163music-docker-client` → 用**相同数据卷**重新 `docker run`；或直接重跑一键脚本（自动重建容器）。
- **常驻参数**：`--restart unless-stopped`（崩溃自动拉起）+ `--memory 1g`（防无头浏览器吃爆内存）+ `-e TZ=Asia/Shanghai`。
- 支持每日活跃时间窗口（跨零点，上限 16 小时）、Docker Compose、VPS 一键脚本；完整说明见 `client-docker/` 目录。

## 仓库结构

```
.
├── music-help.user.js     # 油猴脚本（最新构建产物，自动更新）
├── index.html             # 使用说明/安装引导页
├── extension/             # Chrome MV3 扩展（构建产物，独立版）
├── client-docker/         # Docker 常驻客户端 v4（历史版本，v5 源码见 apps/docker/）
│
├── packages/core/         # 客户端核心逻辑（TS 源码，三端复用：签名/心跳/派单状态机/日志）
├── packages/ui/           # 互助面板 UI（原生 WebComponent，网易云风设计系统）
├── apps/userscript/       # 油猴端壳（entry）
├── apps/extension/        # 扩展端壳（MV3：background/content/popup）
├── apps/docker/           # Docker 端壳（Node + Playwright 无头浏览器）
├── scripts/               # 构建与发布脚本（release.sh / bump.sh）
└── LICENSE
```

- **发布产物**（根目录 user.js / extension/）由私有仓同步与 CI 构建更新，用户无需关心构建过程。
- **源码**（packages/ + apps/）是 v5 客户端的 monorepo，一个核心三端复用。

## 本地验证（Docker / core）

建议使用 **Node.js 24 LTS** 运行 TypeScript 回归测试；Docker 镜像内仍运行预编译后的 JS。

```bash
npm ci --prefix packages/core
npm install --prefix apps/docker --ignore-scripts --no-audit
npm test --prefix packages/core
npm test --prefix apps/docker
npm run build --prefix apps/docker
```

- core 测试会先编译，避免误测旧 `dist/`；测试文件不应加入 `.gitignore`。
- Docker 状态页每 2 秒读取本机快照；远端账号统计在启动、结算后和运行期间每 30 秒刷新。
- “已完成”仅统计本进程获服务端确认入账的任务，不是账号全天的总任务数。
- `ECONNRESET` 表示连接被重置，不能单凭它判定是服务器、代理还是网络设备导致；`409 job_not_active` 则是服务端的任务状态拒绝，不是网络不可达。
- 本地测试使用受控 HTTP 服务和播放器替身，不代表已验证线上账号、音源、服务端结算规则。发布前还需完成一轮真实任务验证。

## 构建与发布

| 操作 | 触发 | 产物 |
|---|---|---|
| `git tag v5*` → push | `.github/workflows/release.yml` | GitHub Release 附 `music-help.user.js` + `163help-extension-v5.x.zip` |
| `git tag docker-v5*` → push | `.github/workflows/docker.yml` | GHCR 镜像 `ghcr.io/y08lin4/163help-client/docker-client`（latest + 版本 tag） |
| 站点分发 | 私有仓 `sync-client.yml` 自动同步 | `163music.linyu.qzz.io`（油猴/扩展安装页） |

## 功能

- 多歌曲挂载（仅支持单曲）
- 偏好选择：短歌优先 / 长歌优先 / 随机
- 只帮不助：只帮别人赚积分，自己不排队
- 个人中心 / 排行榜
- 播放进度心跳（反作弊，无心跳 = 无效播放）
- 错误日志自动上报（限流 + 双层脱敏）
- 播放趋势自动上报：音乐人账号每日自动同步近 30 天播放数据
- SMTP 邮件日报：被助 26/26 达成时自动发送邮件日报（附余额与支撑天数预测）
- 扩展版额外：开机自启 + 标签静音

详细使用说明见 [index.html](index.html)。

## 免责声明

本脚本仅用于个人学习、研究与浏览器自动化实践。请遵守网易云音乐、Linux.do 及相关法律法规，因使用产生的风险由使用者自行承担。

## License

[CC BY-NC 4.0](LICENSE) — 非商业使用
