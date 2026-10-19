# PR-Agent 生产部署与运维指南

> 本文系统性阐述 PR-Agent 作为常驻服务在企业私有云环境下的容器化编排、GitHub App 授权配置、高可用部署及监控运维规范。

---

## 1. 部署架构方案选择

PR-Agent 服务端由三部分核心基础设施组成：

1. **PR-Agent 核心常驻服务**：负责 Webhook 验签、代码浅克隆检出、ReAct 执行及结果回传。
2. **Redis 7**：为 BullMQ 异步队列提供持久化作业存储、限流器状态及过期任务取消广播通道。
3. **Arize Phoenix / SQLite**：提供链路追踪可观测性面板。

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

核心配置项核验清单：

```dotenv
# 服务对外监听端口
PORT=3000

# GitHub App 凭证 (来自 GitHub Developer Settings)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA..."
GITHUB_WEBHOOK_SECRET="whsec_prod_your_random_secret_string"

# DeepSeek 模型通信
DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
DEEPSEEK_BASE_URL="https://api.deepseek.com"
PR_AGENT_MODEL="deepseek-flash"

# 并发与限流
MAX_CONCURRENT_REVIEWS=10
MAX_REVIEWS_PER_MINUTE=30

# 等待 CI：最长等待时间与轮询间隔（毫秒）；CI_WAIT_TIMEOUT_MS=0 表示不等待
CI_WAIT_TIMEOUT_MS=900000
CI_POLL_INTERVAL_MS=60000
```

### 2.2 启动容器编排

执行以下命令即可一键构建并启动服务：

```bash
# 启动所有服务 (后台守护进程)
docker compose up -d --build

# 检查容器运行状态
docker compose ps
```

控制台应显示三项服务均处于 Healthy 或 Running 状态：

- `pr-agent-service` -> 端口 `3000`
- `pr-agent-redis` -> 端口 `6379`
- `pr-agent-phoenix` -> 端口 `6006`

---

## 3. GitHub App 创建与权限配置步骤

为了让 PR-Agent 能够自动接收 Webhook 并对 Pull Request 发表审查评论，需要在 GitHub 组织或个人账号下注册一个私有 GitHub App：

### 3.1 基础设置 (General Settings)

1. 进入 GitHub -> **Settings** -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**。
2. 填写应用名称（如 `MyOrg-PR-Agent`）。
3. **Webhook URL**：填写公开公网地址或反向代理域名，格式为：
   `https://pr-agent.yourcompany.com/webhook`（本地测试可通过 smee.io 或 ngrok 转发）。
4. **Webhook Secret**：生成一个高强度随机字符串，必须与 `.env` 中的 `GITHUB_WEBHOOK_SECRET` 一致。

### 3.2 权限范围 (Repository Permissions)

在 Permissions 页面为应用分配以下最小特权：

| 权限项 (Permission) | 访问级别 (Access) | 设立原因                                                    |
| :------------------ | :---------------- | :---------------------------------------------------------- |
| **Pull Requests**   | **Read & Write**  | 读取 PR 变更信息并在 PR 下批量提交行级内联评论与审查结论    |
| **Contents**        | **Read-only**     | 在隔离临时区浅克隆代码，以便执行 `read_file` 和 `grep_code` |
| **Metadata**        | **Read-only**     | (默认要求) 检索基础仓库元数据                               |
| **Checks**          | **Read-only**     | 读取 head commit 的检查结果与失败注解，作为审查的 CI 上下文 |
| **Commit statuses** | **Read-only**     | 读取 Jenkins 等外部 CI 写入的提交状态                       |
| **Actions**         | **Read-only**     | 下载失败的 GitHub Actions 任务日志，供 Agent 按需读取       |

缺少后三项权限时审查照常进行，只是没有对应的 CI 上下文。

### 3.3 订阅事件 (Subscribe to Events)

勾选以下 Webhook 事件监听：

- `[x] Pull request`：监听 PR 创建（`opened`）与推送新 Commit（`synchronize`）。

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
