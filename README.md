# PR-Agent

基于 DeepSeek 的自主代码审查 Agent，输出可直接提交到 GitHub Pull Request Review API 的审查结果。

PR-Agent 使用自研的轻量 Agent Runtime 驱动 ReAct 式审查循环，支持命令行、GitHub App 常驻服务和 TypeScript SDK 三种使用方式，并内置 OpenTelemetry 链路追踪与本地 SQLite 看板。

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [使用](#使用)
- [配置](#配置)
- [SDK](#sdk)
- [部署](#部署)
- [基准评测](#基准评测)
- [开发](#开发)
- [项目结构](#项目结构)
- [文档](#文档)
- [许可证](#许可证)

## 特性

- **兼容 GitHub Review API**：输出结构与 `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` 一致，包含 `commit_id`、`event`（`APPROVE` / `REQUEST_CHANGES` / `COMMENT`）、汇总正文与行内评论。行号会对照 Diff 校验：靠近修改块的评论吸附到块边缘，离得太远的写进 Review 正文，避免整个 Review 因 HTTP 422 被拒绝。
- **自研 Agent Runtime**：ReAct 调度循环；按 DeepSeek 价格与缓存命中计算的成本预算（默认每个 PR 1 美元），按文件组公平分配；三区上下文压缩（Frozen / Compress / Active），保留工具调用轨迹与已提交评论；预算用尽或触发轮次安全上限时的 Grace Round；指数退避重试与工具连续失败熔断。
- **断点续跑**：会话以 JSONL 形式写入 `.pr-agent/sessions/`，可通过 `--resume <runId>` 恢复中断的审查。
- **GitHub App 服务**：Webhook HMAC 校验后立即返回 202，审查任务经 Redis + BullMQ 排队限流；同一 PR 推送新提交时自动取消旧任务。
- **可观测性**：基于 OpenInference 语义约定上报 OTLP 链路到 [Arize Phoenix](https://github.com/Arize-ai/phoenix)；也可用 `pr-agent view` 打开本地 SQLite 看板。
- **基准评测**：内置 [AACR-Bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) 与 Martian Benchmark 评测流水线，使用 LLM-as-a-Judge 计算 Precision / Recall / F1。

## 快速开始

### 前置要求

- Node.js 22+
- [Vite+](https://viteplus.dev)（`vp` 命令行）
- DeepSeek API Key
- 可选：Redis 7（运行 `server` 时需要）、Docker

### 安装与构建

```bash
vp install
vp pack           # 产出 dist/cli.mjs、dist/index.mjs 及类型声明
vp install -g .   # 全局安装 pr-agent 命令（链接到本目录）
```

全局安装链接到当前目录，`pr-agent` 执行的是本目录的 `dist/cli.mjs`：修改源码后重新 `vp pack` 即可生效，无需重新安装。卸载用 `vp remove -g pr-agent`。

### 第一次审查

```bash
export DEEPSEEK_API_KEY="sk-..."
pr-agent review --diff sample.diff
```

`sample.diff` 是仓库自带的示例，包含若干刻意植入的安全缺陷。

## 使用

PR-Agent 提供三个子命令，完整选项见 [CLI 参考](docs/guides/cli-reference.md)。

### `review`：审查代码变更

```bash
# 审查 diff 文件
pr-agent review --diff sample.diff --owner my-org --repo my-service --pr 10

# 审查本地仓库最近一次提交（HEAD~1..HEAD）
pr-agent review --git

# 指定模型
pr-agent review --diff sample.diff --model deepseek-v4-pro

# 限定本次审查的花费上限（美元，默认 1）
pr-agent review --diff sample.diff --max-cost 0.5

# 输出纯 JSON（适用于 CI）
pr-agent review --diff sample.diff --json

# 恢复中断的会话
pr-agent review --diff sample.diff --resume <runId>

# 直接发布到 GitHub PR
export GITHUB_TOKEN="ghp_..."
pr-agent review --diff sample.diff --owner my-org --repo my-service --pr 10 --publish
```

### `server`：运行 GitHub App 服务

```bash
export GITHUB_APP_ID="123456"
export GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
export GITHUB_WEBHOOK_SECRET="..."
export REDIS_HOST="127.0.0.1"

pr-agent server
```

### `view`：本地看板

```bash
pr-agent view --port 6007
```

然后访问 <http://127.0.0.1:6007>。

## 配置

配置优先级：**命令行参数 > 环境变量 > 配置文件 > 默认值**。在项目根目录创建 `pr-agent.config.ts`：

```ts
import { defineConfig } from "pr-agent";

export default defineConfig({
  model: "deepseek-flash", // deepseek-flash | deepseek-v4-pro
  temperature: 0.1,
  budget: {
    maxCostUsd: 1, // 每个 PR 的花费上限（美元）
    totalTimeoutMs: 1_800_000,
  },
  limits: {
    maxRounds: 100, // 每个文件组的轮次安全上限，不属于预算
  },
  review: {
    minSeverityToBlock: "P1", // P0 / P1 问题会触发 REQUEST_CHANGES
    maxCommentsPerReview: 30,
    enableAstGrep: true,
  },
  rules: [
    "Verify JWT and authentication secrets are not hardcoded or leaked in logs",
    "Ensure all async database and external network calls have timeout handling",
  ],
  telemetry: {
    enabled: true,
    serviceName: "pr-agent",
    phoenixEndpoint: "http://localhost:6006/v1/traces",
  },
});
```

| 模型              | 适用场景                      |
| ----------------- | ----------------------------- |
| `deepseek-flash`  | 默认；吞吐高、延迟低，适合 CI |
| `deepseek-v4-pro` | 长上下文、复杂推理的深度审查  |

全部配置项见 [配置参考](docs/guides/configuration-reference.md)。

## SDK

```ts
import { PRAgent } from "pr-agent";

const agent = new PRAgent({
  model: "deepseek-flash",
  rules: ["Check for SQL injection vulnerabilities"],
});

const review = await agent.reviewPR({
  owner: "my-org",
  repo: "payment-gateway",
  pull_number: 42,
  commit_id: "8eb83340a487b1150af00701b94f01af97e4b4d6",
  rawDiff: diffText,
  background: "Refactoring payment gateway idempotency key verification",
});

console.log(review.event); // "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
console.log(review.comments);
```

## 部署

使用 Docker Compose 启动 PR-Agent 服务、Redis 7 与 Arize Phoenix：

```bash
cp .env.example .env   # 填写 DeepSeek 与 GitHub App 凭据
docker compose up -d --build
curl http://localhost:3000/health
```

GitHub App 的创建与权限配置见 [部署指南](docs/guides/deployment-guide.md)。

## 基准评测

```bash
# 在 AACR-Bench 上随机抽取 20 个 PR 评测
vp run bench -d aacr -n 20 --seed 42 --run-id aacr-sample-20

# 复用已有审查结果，仅用另一个 Judge 模型重新评分
vp run bench -d aacr --run-id aacr-sample-20 --stage eval --judge-model deepseek-v4-pro

# Martian Benchmark 全量评测
vp run bench -d martian --run-id martian-full
```

结果写入 `bench/results/<run-id>/`。评测方法与指标口径见 [评测指南](docs/benchmarks/evaluation-guide.md)。

## 开发

```bash
vp check --fix       # 格式化与 lint
vp run typecheck     # 类型检查（src、bench、测试与配置文件）
vp test              # 运行测试
vp pack              # 构建
```

## 项目结构

```text
.
├── src/
│   ├── index.ts        # SDK 入口与 PRAgent 协调器
│   ├── cli.ts          # CLI 入口
│   ├── config/         # 配置加载与校验（c12 + jiti + zod）
│   ├── domain/         # Diff 解析、行号校验、上下文压缩、Prompt 组装
│   ├── runtime/        # Agent Runtime：调度、成本预算、重试、取消、Checkpoint
│   ├── llm/            # DeepSeek 客户端与价格表（成本计算）
│   ├── github-app/     # Webhook 服务、BullMQ 队列、任务取消
│   ├── dashboard/      # 本地看板
│   └── telemetry/      # OTLP 导出与 SQLite 存储
├── bench/              # AACR-Bench / Martian 评测
├── docs/               # 技术文档
├── pr-agent.config.ts  # 默认配置
├── Dockerfile
└── docker-compose.yml
```

## 文档

| 文档                                                                  | 内容                                      |
| --------------------------------------------------------------------- | ----------------------------------------- |
| [运行时架构](docs/architecture/runtime-architecture.md)               | ReAct 调度、预算控制、Grace Round         |
| [上下文管理](docs/architecture/context-management.md)                 | 三区压缩、水位线触发、行号校验            |
| [GitHub App 架构 RFC](docs/architecture/github-app-deployment-rfc.md) | Webhook 处理、队列限流、过期任务取消      |
| [CLI 参考](docs/guides/cli-reference.md)                              | 子命令、选项与环境变量                    |
| [配置参考](docs/guides/configuration-reference.md)                    | 配置项与 Schema                           |
| [部署指南](docs/guides/deployment-guide.md)                           | Docker Compose、GitHub App 配置、健康检查 |
| [可观测性](docs/observability/telemetry-and-dashboard.md)             | Phoenix 链路追踪与本地看板                |
| [评测指南](docs/benchmarks/evaluation-guide.md)                       | AACR-Bench 与 Martian 评测流程            |

完整索引见 [docs/README.md](docs/README.md)。

## 许可证

[MIT](LICENSE)
