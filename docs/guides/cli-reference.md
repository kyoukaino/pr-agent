# PR-Agent CLI 命令行全量参考手册

> 本文系统性梳理 `pr-agent` CLI 提供的所有子命令、参数选项、环境变量及经典实战场景。

---

## 1. 命令总览

PR-Agent CLI 由 [`src/cli.ts`](../../src/cli.ts) 驱动，打包后生成可执行文件 `dist/cli.mjs`。主要提供三大核心子命令：

```text
pr-agent [command] [options]

Commands:
  review    审查 Pull Request 或 Git Diff，输出对齐 GitHub REST API 的审查载荷
  server    启动私有单租户 GitHub App Webhook 接收网关与 BullMQ 异步 Worker 守护进程
  view      启动轻量级本地 SQLite 可观测性与审查历史回放面板 (默认端口 6007)
```

---

## 2. `pr-agent review`：代码审查

核心审查命令，支持审查本地差异文件、当前 Git 仓库最近提交，或直接发布审查到 GitHub。

### 2.1 参数选项列表

| 标志 / 参数               | 类型    | 默认值               | 说明                                                                                                                        |
| :------------------------ | :------ | :------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `-d, --diff <file>`       | string  | -                    | 待审查的 Git Diff 文件路径（与 `--git` 二选一必填）                                                                         |
| `--git`                   | boolean | false                | 自动从本地当前 Git 仓库提取变更（`HEAD~1..HEAD`；没有上一个提交时为 `HEAD` 与工作区的差异），并把改动前的文件挂载为 `@base` |
| `-o, --owner <owner>`     | string  | `my-org`             | GitHub 仓库所有者 / 组织名                                                                                                  |
| `-r, --repo <repo>`       | string  | `my-repo`            | GitHub 仓库名称                                                                                                             |
| `-p, --pr <number>`       | number  | `1`                  | Pull Request 编号                                                                                                           |
| `-c, --commit <sha>`      | string  | `git rev-parse HEAD` | 目标 Commit SHA（用于 GitHub Review 锚定）                                                                                  |
| `-m, --model <name>`      | string  | `deepseek-flash`     | 指定模型 (`deepseek-flash`, `deepseek-v4-pro`)                                                                              |
| `--config <path>`         | string  | -                    | 显式指定配置文件路径（如 `./my-team.config.ts`）                                                                            |
| `-t, --temperature <num>` | number  | `0.1`                | 采样温度 (0.0 ~ 2.0)，代码审查推荐保持在 0.1                                                                                |
| `-b, --background <text>` | string  | -                    | 业务/需求背景说明，注入初始提示词以提升审查针对性                                                                           |
| `--max-cost <usd>`        | number  | `1`                  | 单次审查的花费上限（美元），按剩余文件组数公平分配                                                                          |
| `--resume <runId>`        | string  | -                    | 从检查点恢复之前中断的审查任务（跳过已审查文件组）                                                                          |
| `--publish`               | boolean | false                | 审查完成后直接通过 GitHub REST API 提交 Review（需配置 `GITHUB_TOKEN`）                                                     |
| `--json`                  | boolean | false                | 以纯 JSON 格式输出最终 Review 载荷至标准输出（适用于 CI/CD）                                                                |

### 2.2 典型实战用例

#### 用例 A：审查本地文件与指定规则配置

```bash
pr-agent review \
  --diff sample.diff \
  --owner my-org \
  --repo my-service \
  --pr 128 \
  --config ./pr-agent.config.ts
```

#### 用例 B：本地开发阶段一键审查未提交变更

在当前工作区任意终端执行：

```bash
pr-agent review --git
```

#### 用例 C：CI/CD 自动化流水线消费审查结果 (JSON 模式)

在 GitHub Actions / GitLab CI 中捕获载荷并传递给下游检查：

```bash
REVIEW_JSON=$(pr-agent review --diff changes.diff --json)
echo "$REVIEW_JSON" | jq '.event'
```

#### 用例 D：断点续跑 (从中断的会话中秒级恢复)

若网络闪断或进程中断，可传入上次会话的 runId：

```bash
pr-agent review --diff sample.diff --resume run_1792313982938_rbkbu
```

#### 用例 E：审查并直接在 GitHub PR 下发布评审评论

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
pr-agent review \
  --diff sample.diff \
  --owner my-org \
  --repo payment-gateway \
  --pr 42 \
  --publish
```

---

## 3. `pr-agent server`：GitHub App 生产常驻服务

启动集成了 Webhook 接入、签名验签、BullMQ 任务队列与分布式执行的常驻后端。

### 3.1 启动方式

```bash
pr-agent server
```

### 3.2 必备环境变量

启动 `server` 前必须配置以下环境变量（或在 `.env` 中声明）：

- `GITHUB_APP_ID`：GitHub App 注册 ID
- `GITHUB_APP_PRIVATE_KEY`：GitHub App 私钥内容或私钥文件路径
- `GITHUB_WEBHOOK_SECRET`：Webhook 签名校验密钥
- `DEEPSEEK_API_KEY`：DeepSeek API 密钥
- `REDIS_HOST` & `REDIS_PORT`：Redis 实例连接信息

### 3.3 暴露的 HTTP 端点

- `POST /webhook`：接收 GitHub Webhook 请求，50ms 内完成 HMAC 验签并入队，返回 HTTP 202。
- `GET /health`：存活探针，返回当前队列积压状态与 Worker 运行健康度。

---

## 4. `pr-agent view`：本地可观测性与审查面板

开箱即用的轻量级审查历史面板，基于本地 SQLite 存储，**无需部署任何外部数据库或 Docker 服务**即可快速启动。

### 4.1 参数选项列表

| 标志 / 参数         | 类型   | 默认值                | 说明                             |
| :------------------ | :----- | :-------------------- | :------------------------------- |
| `-p, --port <port>` | number | `6007`                | Web 控制台绑定的端口号           |
| `-h, --host <host>` | string | `127.0.0.1`           | 绑定网卡地址                     |
| `--db <path>`       | string | `.pr-agent/traces.db` | 自定义 SQLite 数据库文件存储路径 |

### 4.2 启动与功能

```bash
pr-agent view --port 6007
```

启动后终端将输出访问链接：

```text
=== PR-Agent Observability Hub (SQLite Native) ===
Dashboard available at: http://127.0.0.1:6007
Connected to local SQLite: .pr-agent/traces.db
```

浏览器打开该地址，即可直观查看：

1. **全局审查指标**：累计审查数、发现的 P0~P4 缺陷数分布、Token 总体开销与平均耗时。
2. **审查列表与详情**：按 PR 列出历史审查结果，点击可钻取每条内联建议及 GitHub 决策状态（`APPROVE` / `REQUEST_CHANGES`）。
3. **Trace 链路回放**：完整回放每轮交互中的模型思考过程（`reasoningContent`）、工具调用参数与返回内容。
