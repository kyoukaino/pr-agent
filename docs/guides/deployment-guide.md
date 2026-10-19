# PR-Agent 生产部署与运维指南

> 本文系统性阐述 PR-Agent 作为常驻服务在企业私有云环境下的容器化编排、GitHub App 授权配置、高可用部署及监控运维规范。

---

## 1. 部署架构方案选择

PR-Agent 服务端由以下基础设施组成：

1. **PR-Agent 核心常驻服务**：负责 Webhook 验签、代码浅克隆检出、ReAct 执行及结果回传。
2. **Redis 7**：为 BullMQ 异步队列提供持久化作业存储、限流器状态及过期任务取消广播通道。
3. **Cloudflare Tunnel**：把 GitHub Webhook 转发到服务，主机无需开放任何公网端口（也适用于只有 IPv6 的主机：GitHub 只能向 IPv4 地址投递 Webhook）。
4. **SQLite / Arize Phoenix（可选）**：本地 SQLite 记录每次审查；Phoenix 链路追踪面板通过 `observability` profile 按需启用。

推荐部署方式：

- **中小规模 / 私有内网**：采用 **Docker Compose** 一键编排（最简维护成本）。
- **大型企业 / 高并发多租户**：采用 **Kubernetes** 部署，无状态网关与 Worker 分离，配置 HPA 自动水平扩缩容。

---

## 2. 基于 Docker Compose 的一键部署

项目根目录已内置生产就绪的 [`docker-compose.yml`](../../docker-compose.yml) 与优化过的多阶段构建 [`Dockerfile`](../../Dockerfile)。

### 2.1 准备环境配置文件 (`.env`)

复制示例环境变量并填入真实凭据：

```bash
cp .env.example .env
```

GitHub App 的三项凭据可以由创建脚本生成（见 [第 3 节](#3-github-app-创建与权限配置步骤)），把输出文件的内容合并进 `.env` 即可。

核心配置项核验清单：

```dotenv
# 服务端口（仅绑定 127.0.0.1，供主机上的健康检查使用）
PORT=3000

# GitHub App 凭证 (来自 GitHub Developer Settings)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA..."
GITHUB_WEBHOOK_SECRET="whsec_prod_your_random_secret_string"

# DeepSeek 模型通信
DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
DEEPSEEK_BASE_URL="https://api.deepseek.com"
PR_AGENT_MODEL="deepseek-flash"

# 并发与限流（每个并发审查都持有一份代码检出和一个 Agent，小内存主机保持 1）
MAX_CONCURRENT_REVIEWS=1
MAX_REVIEWS_PER_MINUTE=30

# 等待 CI：最长等待时间与轮询间隔（毫秒）；CI_WAIT_TIMEOUT_MS=0 表示不等待
CI_WAIT_TIMEOUT_MS=900000
CI_POLL_INTERVAL_MS=60000

# Quick Tunnel：服务自动把 App 的 Webhook URL 更新为隧道当前地址；使用固定域名时置空
CLOUDFLARED_METRICS_URL=http://tunnel:2000

# 容器内存上限与可观测性
PR_AGENT_MEM_LIMIT=768m
PR_AGENT_TELEMETRY=false
```

### 2.2 构建镜像

镜像按 [Vite+ 官方 Docker 指南](https://viteplus.dev/guide/docker) 多阶段构建：用 `ghcr.io/voidzero-dev/vite-plus` 执行 `vp install` 和 `vp pack`，另起一个阶段只安装生产依赖，运行阶段是 `debian:bookworm-slim` 加上 `package.json` 中固定版本的 Node.js 与 git，不包含 vp。

小内存主机（1 GB 左右）上构建很可能因内存不足失败，建议在开发机构建后传过去：

```bash
# 开发机（目标主机为 x86_64）
docker build --platform linux/amd64 -t pr-agent:latest .
docker save pr-agent:latest | gzip | ssh <host> 'gunzip | docker load'
```

也可以推送到镜像仓库，并在 `.env` 中设置 `PR_AGENT_IMAGE=ghcr.io/<owner>/pr-agent:<tag>`。

### 2.3 启动容器编排

```bash
# 启动服务、Redis 与隧道 (后台守护进程)
docker compose up -d

# 需要 Phoenix 链路追踪面板时（额外约 1 GB 内存，并设置 PR_AGENT_TELEMETRY=true）
docker compose --profile observability up -d

# 检查容器运行状态
docker compose ps
```

默认启动三个容器，除服务端口绑定在 `127.0.0.1:3000` 外不向主机发布任何端口：

- `pr-agent-service`：Webhook 服务与 Worker（内存上限 `PR_AGENT_MEM_LIMIT`）
- `pr-agent-redis`：仅容器网络可达，`noeviction` 策略，避免 BullMQ 任务被淘汰
- `pr-agent-tunnel`：cloudflared

### 2.4 Webhook 入口：Cloudflare Tunnel

- **Quick Tunnel（默认，无需域名）**：cloudflared 分配一个随机的 `*.trycloudflare.com` 地址，每次重启都会变化。服务通过 cloudflared metrics 的 `/quicktunnel` 接口读取当前地址，启动时及之后每分钟检查一次，变化时用 App 身份调用 `PATCH /app/hook/config` 更新 Webhook URL。地址切换间隙中投递失败的 PR 事件不会丢：Webhook 重新指向隧道后，服务会读取 `/app/hook/deliveries`，重新投递 24 小时内所有尝试都失败的 `pull_request` 事件（不使用隧道时，在服务启动时做一次）。已审查过的提交会被 Worker 跳过，所以重复投递不会导致重复审查。Quick Tunnel 本身不保证可用性。
- **Named Tunnel（固定域名，推荐长期使用）**：在 Cloudflare 后台创建隧道，把主机名路由到 `http://pr-agent:3000`；`.env` 中设置 `CLOUDFLARE_TUNNEL_TOKEN`，并把 `CLOUDFLARED_METRICS_URL` 置空；将 compose 中 `tunnel` 的 command 换成 `tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}`；最后在 App 设置中把 Webhook URL 改为 `https://<主机名>/webhook`。

---

## 3. GitHub App 创建与权限配置步骤

为了让 PR-Agent 能够自动接收 Webhook 并对 Pull Request 发表审查评论，需要在 GitHub 组织或个人账号下注册一个私有 GitHub App。

### 3.0 用脚本创建（推荐）

[`scripts/create-github-app.ts`](../../scripts/create-github-app.ts) 走 GitHub 的 [App Manifest 流程](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)，一次性配置好下面 3.1–3.3 的权限、事件与 Webhook：

```bash
node scripts/create-github-app.ts --name pr-agent-yourname          # 个人账号
node scripts/create-github-app.ts --name pr-agent-yourorg --org yourorg
```

按提示在浏览器打开本地页面，在 GitHub 上确认创建后，App ID、私钥与 Webhook Secret 会写入 `.env.github-app`（已被 git 与 Docker 忽略），把它合并进部署主机的 `.env` 后删除即可。

Webhook URL 默认是一个无法解析的占位地址：使用 Quick Tunnel 时服务启动后会自动改成隧道地址；使用固定域名时传入 `--webhook-url https://<主机名>/webhook`。**服务部署好之前不要安装 App**，否则安装事件会投递失败。之后在 App 页面点击 **Install App**，选择要审查的仓库（见 3.4 第 3 步）。

### 3.1 基础设置 (General Settings)

1. 进入 GitHub -> **Settings** -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**。
2. 填写应用名称（如 `MyOrg-PR-Agent`）。
3. **Webhook URL**：填写公开公网地址或反向代理域名，格式为：
   `https://pr-agent.yourcompany.com/webhook`（没有公网入口时见 [2.4 Cloudflare Tunnel](#24-webhook-入口cloudflare-tunnel)）。
4. **Webhook Secret**：生成一个高强度随机字符串，必须与 `.env` 中的 `GITHUB_WEBHOOK_SECRET` 一致。

### 3.2 权限范围 (Repository Permissions)

在 Permissions 页面为应用分配以下最小特权：

| 权限项 (Permission) | 访问级别 (Access) | 设立原因                                                                                                                |
| :------------------ | :---------------- | :---------------------------------------------------------------------------------------------------------------------- |
| **Pull Requests**   | **Read & Write**  | 读取 PR 变更信息并在 PR 下批量提交行级内联评论与审查结论                                                                |
| **Contents**        | **Read & Write**  | 浅克隆代码供 `read_file` 和 `grep_code` 读取；关闭已修复发现的讨论（`resolveReviewThread`）要求写权限，App 不会推送代码 |
| **Metadata**        | **Read-only**     | (默认要求) 检索基础仓库元数据                                                                                           |
| **Checks**          | **Read-only**     | 读取 head commit 的检查结果与失败注解，作为审查的 CI 上下文                                                             |
| **Commit statuses** | **Read-only**     | 读取 Jenkins 等外部 CI 写入的提交状态                                                                                   |
| **Actions**         | **Read-only**     | 下载失败的 GitHub Actions 任务日志，供 Agent 按需读取                                                                   |

缺少后三项权限时审查照常进行，只是没有对应的 CI 上下文。

### 3.3 订阅事件 (Subscribe to Events)

勾选以下 Webhook 事件监听：

- `[x] Pull request`：监听 PR 创建（`opened`）、推送新 Commit（`synchronize`），以及关闭（`closed`，用于删除该 PR 的会话）。
- `[x] Pull request review comment`：监听作者在发现讨论中的回复，由 Agent 作答（见 [RFC 3.6](../architecture/github-app-deployment-rfc.md#36-会话延续增量重审与发现关闭)）。

等待 CI 采用轮询，不需要订阅 `check_suite` 等额外事件（见 [RFC 3.5](../architecture/github-app-deployment-rfc.md#35-等待-ci-与-ci-上下文)）。

### 3.4 生成私钥并安装到仓库

1. 点击页面底部的 **Generate a private key**，下载 `.pem` 私钥文件。
2. 将私钥内容复制至 `.env` 中的 `GITHUB_APP_PRIVATE_KEY`（保留换行转义 `\n`）。
3. 点击左侧 **Install App**，将该应用安装至需要开启代码审查的仓库或整个 Organization。

---

## 4. 服务健康探针与监控运维

### 4.1 健康状态探针 (`/health`)

向网关发送探针请求：

```bash
curl -i http://localhost:3000/health
```

正常响应示例：

```json
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ok",
  "service": "pr-agent-github-app",
  "timestamp": "2026-10-19T08:50:00.000Z",
  "queue": {
    "waiting": 0,
    "active": 2,
    "failed": 0
  }
}
```

### 4.2 容器日志查看与排错

```bash
# 查看实时日志流
docker compose logs -f pr-agent

# 查看 Redis 运行状况
docker compose exec redis redis-cli info memory
```

### 4.3 优雅关闭与平滑升级

服务内建了 `SIGTERM` / `SIGINT` 捕获钩子，关闭时会依次：

1. 停止接受新的 Webhook 连接；
2. 等待当前正在执行的 Worker 轮次完成安全 Checkpoint 落地；
3. 关闭 BullMQ 队列与 Redis 连接；
4. 安全退出，保证审查任务不发生脏数据丢失。
