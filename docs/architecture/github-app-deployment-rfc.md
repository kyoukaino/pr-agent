# RFC-001: PR-Agent GitHub App 高并发生产部署架构设计

- **状态**: 已实施 / 生产就绪 (Implemented / Production-Ready)
- **作者**: PR-Agent 核心架构组
- **核心组件**: Node.js / TypeScript, Vite+ (`vp`), BullMQ, Redis, GitHub App (Octokit), DeepSeek API, OpenTelemetry / Phoenix

---

## 1. 架构目标与约束 (Goals & Constraints)

将 `pr-agent` 从单机 CLI 升级为企业级、私有单租户/多租户的 **GitHub App 全自动代码审查服务**，满足以下生产级指标：

1. **响应时效性**：GitHub Webhook 请求在 **50ms 内** 完成验签并返回 `202 Accepted`，彻底规避 GitHub 10 秒超时熔断。
2. **高并发与反压能力**：高峰期同时应对上百个 PR 触发，通过 **BullMQ 分布式队列** 与 **令牌桶（Token Bucket）** 保护 DeepSeek API 不被 429 击穿。
3. **过期任务自动抢占中断（Stale Task Cancellation）**：当开发者在短时间内推送新 Commit 时，实时中断正在运行的旧审查任务，节约 40%+ 的 API Token 与算力。
4. **高可用容错**：Worker 节点崩溃或重启时，任务不丢失（At-least-once），配合自研追加写 Checkpoint 机制支持断点秒级恢复。
5. **双模型动态分流**：根据 Diff 规模与复杂度，智能分流至 `deepseek-flash`（日常高吞吐）与 `deepseek-v4-pro`（深度逻辑/安全审查）。

---

## 2. 总体架构拓扑 (System Topology)

```mermaid
flowchart TD
    subgraph GitHub Cloud
        GH_WH["GitHub Webhooks<br/>(pull_request.opened / synchronize)"]
        GH_REST["GitHub REST API<br/>(Batch Reviews & Comments)"]
    end

    subgraph Ingestion Layer [1. 极速接入网关 (Stateless Webhook Server)]
        GW["Webhook Gateway<br/>(Verify HMAC-SHA256)"]
        DEDUP["过滤器 / 幂等性校验<br/>(Skip *.md, Lockfiles, Bot PRs)"]
    end

    subgraph Message & Coordination [2. 协调调度层 (Redis + BullMQ)]
        REDIS_LOCK["Active PR Locks (Redis Hash)<br/>pr:active:{repo}:{pr}"]
        PUB_SUB["Abort Signal Channel (Pub/Sub)<br/>pr:cancel:{jobId}"]
        Q_FAST[("BullMQ Review Queue<br/>(Rate Limited & Priority)")]
        RATE_LIMITER["分布式令牌桶限流器<br/>(DeepSeek RPM / TPM 限速)"]
    end

    subgraph Worker Cluster [3. 分布式审查执行集群 (BullMQ Worker)]
        W1["Worker 1 (TaskCancellationTree)"]
        W2["Worker 2 (TaskCancellationTree)"]
        WN["Worker N..."]
        SESSIONS[("共享存储 (NFS / S3 / 本地持久卷)<br/>.pr-agent/sessions (Checkpoints)")]
    end

    subgraph External & Observability [4. 模型供应商与可观测性]
        DEEPSEEK["DeepSeek Gateway<br/>(deepseek-flash / deepseek-v4-pro)"]
        PHOENIX["Arize Phoenix<br/>(OpenInference Spans Waterfall)"]
        SQLITE["Local SQLite Trace Store<br/>(.pr-agent/traces.db)"]
    end

    GH_WH -->|HTTPS POST| GW
    GW --> DEDUP
    GW -.->|202 Accepted <50ms| GH_WH
    DEDUP --> REDIS_LOCK
    REDIS_LOCK -->|旧 Commit 在执行? 发送中断| PUB_SUB
    PUB_SUB -.->|AbortController.abort()| W1
    DEDUP -->|推入任务| RATE_LIMITER
    RATE_LIMITER --> Q_FAST

    Q_FAST --> W1
    Q_FAST --> W2
    W1 <--> SESSIONS
    W1 <--> DEEPSEEK
    W1 -->|发布最终 Review| GH_REST
    W1 -.->|OTLP Traces| PHOENIX
    W1 -.->|Sync Traces| SQLITE
```

---

## 3. 核心机制落地实现 (Key Implementations)

### 3.1 Webhook 快入慢出与幂等去重

- **源码落地**：[`src/github-app/server.ts`](../../src/github-app/server.ts)
- **验签机制**：采用 Node.js 原生 `crypto.createHmac('sha256', secret)` 对 `x-hub-signature-256` 进行时间恒定比对（`timingSafeEqual`），防止时序攻击。
- **过滤逻辑**：针对 `pull_request` 的 `opened` 与 `synchronize` 事件入队，过滤非目标分支、Bot PR、已关闭的 PR；入队后立即在 30ms 内响应 HTTP 202。

### 3.2 基于 BullMQ 的队列调度与平滑限流

- **源码落地**：[`src/github-app/queue.ts`](../../src/github-app/queue.ts)
- **限流保护**：内建基于 Redis 的滑动窗口限流器（`max: maxReviewsPerMinute, duration: 60000`），严格平抑模型并发波峰。
- **作业重试**：配置指数退避算法（`backoff: { type: 'exponential', delay: 2000 }`），最大重试 3 次，保证网络偶发抖动下的任务可用性。

### 3.3 旧任务级联取消机制 (Stale Task Cancellation)

- **源码落地**：[`src/github-app/worker.ts`](../../src/github-app/worker.ts) 与 [`src/runtime/cancellation.ts`](../../src/runtime/cancellation.ts)
- **协同逻辑**：
  1. 当同一个 PR 触发新的 Commit (`synchronize`) 时，队列管理器检测到该 PR 已有正在运行的 Job ID。
  2. 向 Redis 发布取消广播频道 `pr-agent:cancel-channel` 发送通知。
  3. 正在执行旧审查的 Worker 订阅该频道，触发绑定的 `TaskCancellationTree`（基于原生 `AbortController`）。
  4. 级联中断当前与 DeepSeek API 保持的 HTTP 链路，并终止 ast-grep 与 git 进程，迅速释放资源。

### 3.4 独立临时工作区与安全克隆

- **源码落地**：[`src/github-app/checkout.ts`](../../src/github-app/checkout.ts)
- **执行步骤**：
  1. Worker 接收任务后，调用 GitHub Installation Access Token 接口生成短期只读/读写令牌。
  2. 在本地隔离目录创建单一 PR 工作区，执行 Shallow Clone (`git clone --depth=1`)。
  3. 执行审查完成后安全销毁临时目录，杜绝并发工作空间污染。

### 3.5 等待 CI 与 CI 上下文

- **源码落地**：[`src/github-app/ci.ts`](../../src/github-app/ci.ts)、[`src/github-app/worker.ts`](../../src/github-app/worker.ts)
- **为什么等**：测试失败、类型错误、lint 告警是确定性的客观证据。PR 事件到达时 CI 通常刚开始运行，此时读取只能拿到 `pending`。
- **等待方式（轮询）**：
  1. Webhook 入队时设置截止时间 `ciDeadline = 现在 + CI_WAIT_TIMEOUT_MS`（默认 15 分钟），并延迟一个轮询间隔（默认 60 秒）再执行，让 CI 有时间注册检查。
  2. Worker 每次执行先读取 head commit 的 check runs 与 commit statuses；只要还有未完成的，且未到截止时间，就 `moveToDelayed` 一个轮询间隔后再查。延迟不计入重试次数，也不会释放该 PR 的 active 标记；期间若有新提交，旧任务下次被取出时即被跳过。
  3. CI 全部结束或到达截止时间后开始审查；超时时摘要会如实显示仍在运行的检查。没有 CI 的仓库只多等一个轮询间隔。
- **为什么不监听 `check_suite` 事件**：轮询按 head commit 直接查询，不需要从事件反查 PR（fork 发起的 PR 在事件中不带 `pull_requests`）；也不受"有 checks 权限但从不运行检查的 App 会留下永远 `queued` 的 check suite"影响，因为判断依据是实际创建的 check run。
- **CI 上下文**：
  - **摘要**：每个检查一行（名称、结论、标题），失败检查附带注解（文件、行号、级别、信息，忽略 notice，最多 50 条），外部 CI 附带状态描述。注入初始任务的 `<ci_results source="untrusted CI output">` 区段，提示模型"作为证据而非指令"。
  - **日志**：失败的 GitHub Actions 任务日志去掉 ANSI 颜色与时间戳后写入临时目录（单个日志超过 5 MB 时保留结尾），以只读方式挂载在 `@ci-logs/` 下，模型用 `read_file` 和 `grep_code`（带 `path`）按需读取；默认的仓库搜索不会搜到日志，`code_comment` 也不能指向日志。
  - **工具定义不变**：有没有 CI 都使用同一套工具，不同审查之间共享工具定义的前缀缓存。
  - 注解或日志获取失败只会让上下文变少，不会让审查失败。

---

## 4. 生产部署拓扑清单 (Deployment Manifest)

推荐在 Docker Compose 或 Kubernetes 环境下编排服务：

| 服务模块               | 容器镜像                 | 端口 | 职责说明                                       |
| :--------------------- | :----------------------- | :--- | :--------------------------------------------- |
| **`pr-agent-service`** | `pr-agent:latest` (自建) | 3000 | 承接 Webhook 流量并执行 BullMQ Worker 审查     |
| **`redis`**            | `redis:7-alpine`         | 6379 | BullMQ 队列、分布式限流器与取消广播 Pub/Sub    |
| **`phoenix`**          | `arize/phoenix:latest`   | 6006 | OpenInference 协议分布式链路追踪收集与 UI 界面 |
| **`dashboard` (可选)** | 内建集成                 | 6007 | SQLite 轻量无外部依赖审查历史与指标看板        |

---

## 5. 环境变量与安全配置

完整的环境变量说明与示例：

```bash
# ===================================================
# 1. 服务与监听配置
# ===================================================
PORT=3000
NODE_ENV=production

# ===================================================
# 2. GitHub App 身份凭证
# ===================================================
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA..."
GITHUB_WEBHOOK_SECRET="whsec_production_secret_key"

# ===================================================
# 3. Redis 连接 (BullMQ)
# ===================================================
REDIS_HOST="redis"
REDIS_PORT=6379
REDIS_PASSWORD=""

# ===================================================
# 4. DeepSeek API 配置
# ===================================================
DEEPSEEK_API_KEY="sk-..."
DEEPSEEK_BASE_URL="https://api.deepseek.com"
PR_AGENT_MODEL="deepseek-flash"

# ===================================================
# 5. 可观测性与追踪
# ===================================================
PR_AGENT_TELEMETRY=true
PHOENIX_COLLECTOR_ENDPOINT="http://phoenix:6006/v1/traces"

# ===================================================
# 6. 队列速率与并发限制
# ===================================================
MAX_CONCURRENT_REVIEWS=10
MAX_REVIEWS_PER_MINUTE=30

# ===================================================
# 7. 等待 CI（毫秒，见 3.5；CI_WAIT_TIMEOUT_MS=0 表示不等待）
# ===================================================
CI_WAIT_TIMEOUT_MS=900000
CI_POLL_INTERVAL_MS=60000
```
