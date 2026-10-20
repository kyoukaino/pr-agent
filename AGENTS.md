# AGENTS.md

本文件为在此仓库中工作的 AI 编码代理（Claude Code、Codex 等）提供指引。

## 项目概览

PR-Agent：基于 DeepSeek 的自主代码审查 Agent，自研 ReAct 运行时，产出可直接提交到 GitHub `POST /pulls/{n}/reviews` 的 Review 载荷。三种入口：CLI（`src/cli.ts`）、GitHub App 常驻服务（`src/github-app/`）、TypeScript SDK（`src/index.ts` 的 `PRAgent`）。

## 命令

项目严格通过 Vite+（`vp`）管理，不要改用裸 `pnpm` / `npm` / `npx`。Node 与 pnpm 版本由 `package.json` 的 `devEngines` 固定。

```bash
vp install                 # 安装依赖（CI 用 --frozen-lockfile）
vp check                   # 格式 + lint（vp check --fix 自动修复）
vp run typecheck           # tsc -p .，覆盖 src、bench、测试与配置文件
vp test                    # 全部测试（vitest，globals: true）
vp test src/domain/relocator.test.ts        # 单个测试文件
vp test src/domain/relocator.test.ts -t "名称"  # 按用例名过滤
vp pack                    # 构建 dist/cli.mjs、dist/index.mjs（+ 类型声明、复制 dashboard/ui.html）
vp run bench -d aacr -n 20 --seed 42 --run-id <id>   # 基准评测，结果写入 bench/results/<id>/
```

CI（`.github/workflows/ci.yml`）依次运行 `vp check`、`vp run typecheck`、`vp test`、`vp pack`，提交前应全部通过。

全局 `pr-agent` 命令由 `vp install -g .` 链接到本目录、执行 `dist/cli.mjs`：改完源码需先 `vp pack` 才能在 `pr-agent` 命令上看到效果。本地试跑：`DEEPSEEK_API_KEY=... pr-agent review --diff sample.diff`（`sample.diff` 含刻意植入的缺陷）。

## 架构

### 一次审查的主流程（`PRAgent.runReview`，`src/index.ts`）

1. `domain/diff-parser` 解析 diff；生成文件/lockfile、无文本 hunk、单文件超过 `maxContextTokens × warningWatermark` 的文件被跳过并记入 `skippedFiles`。
2. `domain/grouping` 按 token 预算把文件打包成文件组（diff 放得下时只有一组）。
3. 每个文件组是一个子任务，由 `runtime/engine.ts` 的 `AgentRuntimeEngine.executeSubtask` 跑 ReAct 循环；工具定义与执行在 `domain/tools.ts`（`ToolDispatcher`：read_file / grep_code / ast-grep / code_comment / task_done 等）。
4. `domain/assembler.ts` 汇总评论：`domain/relocator.ts` 将行号对照 diff 校验，靠近 hunk 的吸附到边缘，太远的写入 Review 正文，避免 GitHub 422；按 `minSeverityToBlock` 决定 `event`，按 `maxCommentsPerReview` 截断。
5. 可选发布到 GitHub；写入检查点、trace 与 SQLite。

### 运行时（`src/runtime/`）

- `budget.ts`：成本预算以美元计（`llm/pricing.ts` 按 DeepSeek 价格与缓存命中计算），在剩余文件组间公平分配；`maxRounds` 只是防失控的安全上限，不属于预算。预算耗尽/触顶时进入 Grace Round，只允许 `code_comment` / `resolve_finding` / `reply_to_author` / `task_done`。
- `domain/compression.ts`：三区上下文压缩（Frozen / Compress / Active），Frozen 前缀必须保持不变以保护前缀缓存。
- `retry.ts`（指数退避、工具连续失败熔断）、`cancellation.ts`（`AbortSignal` 驱动的取消树）。
- `checkpoint.ts`：JSONL 事件写入 `.pr-agent/sessions/`，支撑 `--resume <runId>`；`trace.ts` 写 `.pr-agent/traces/`；`telemetry/sqlite-store.ts` 写 `.pr-agent/traces.db` 供 `pr-agent view` 看板读取。

### Prompt 与行号约定

`domain/prompt.ts` 组装消息。Diff 以 `R<n>`（新文件行）/ `L<n>`（旧文件行）标注行号，评论锚定在 `R<n>` 上。增量审查时 `L<n>` 指上次已审查的提交而非 PR base。CI 结果、作者回复等外部内容视为不可信，放在带标签的独立 prompt 段落中。

### 审查会话与工具集稳定性

`domain/session.ts` 的 `ReviewSession` 保存每个文件组的完整对话。GitHub App 对同一 PR 的新推送做增量审查：只审查自上次已审查提交以来的变更，把新消息追加到原对话（`routeToGroups`），并通过 `resolve_finding` 关闭已修复的旧发现；作者在评论线程回复时走 `PRAgent.answerReply`，继续负责该文件的对话。`sessionTools` 对一个 PR 会话中的每次运行都开启，使工具集——进而 prompt 缓存前缀——始终不变；CLI 与基准评测不设置它。改动工具定义或系统提示时要考虑对缓存前缀的影响。

### GitHub App（`src/github-app/`）

`server.ts` 校验 Webhook HMAC 后立即返回 202 → `queue.ts`（Redis + BullMQ，限流，每个 PR 的 active job 与锁）→ `worker.ts` 处理：`checkout.ts` 检出 PR、`ci.ts` 收集 head 提交的 CI 结果与失败日志（以 `@ci-logs` 挂载给 agent）、`history.ts` 计算增量 diff 与历史发现、`threads.ts` 管理发现线程、`session-store.ts` 将会话存于 `.pr-agent/pr-sessions/`（仅在 Review 发布后保存）。同一 PR 有新提交时，通过 Redis Pub/Sub `pr-agent:cancel` 中止旧任务。`redelivery.ts` 重放 GitHub 投递失败的事件；`tunnel.ts` 支持 Cloudflare 隧道并自动更新 App 的 webhook URL。

### 配置

`src/config/`：c12 + jiti 加载 `pr-agent.config.ts`，zod 校验（`schema.ts`）。优先级：命令行参数 > 环境变量 > 配置文件 > 默认值。

### 基准评测（`bench/`）

`bench/run.ts` 分 `review` / `eval` 两阶段，可用同一 `--run-id` 续跑或只重评分。数据与仓库缓存在 `bench/.cache/`，结果在 `bench/results/`（均为生成数据，已 gitignore 并排除在格式化之外）。

## 约定

- 模型分工：审查 agent 默认 `deepseek-flash`，基准 Judge 默认 `deepseek-v4-pro`。不要把审查默认模型改成 v4-pro；若用 v4-pro 做审查对比，应换 Judge 或注明同模型偏差。
- 尚未接线的预留设计（如 `TaskCancellationTree` 的父子树、`softWatermark`、`enableAstGrep`、`docs/architecture/github-app-deployment-rfc.md`）在清理时保留；只修正与现有实现冲突或事实错误的部分，文档中标注为"规划中/预留"而非描述为已生效。
- ESM + TypeScript，源码内相对导入带 `.js` 后缀；测试与源文件同目录（`*.test.ts`）。
- 文档（`docs/`、README）用简体中文；代码注释与提交信息用英文。修改行为时同步更新 `docs/` 中对应文档（索引见 `docs/README.md`）。
- Docker 镜像构建设置 `PR_AGENT_SKIP_DTS=1` 跳过类型声明生成。
