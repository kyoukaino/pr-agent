# 上下文管理与行号锚定

> 本文说明 PR-Agent 在多轮审查中如何管理上下文窗口（三区记忆压缩）、如何保证评论行号能被 GitHub 接受，以及文件组、审查工作区（挂载目录）和初始任务的结构。

## 1. 问题

一个文件组的审查通常需要 10～20 轮 `read_file` / `grep_code`，工具返回的代码片段很快会把上下文撑满：

1. **简单截断会丢失任务**：滑动窗口丢弃早期消息后，模型会忘记审查目标和 Diff。
2. **只做摘要会丢失轨迹**：调用工具的那一轮，assistant 消息的正文通常为空，信息都在工具调用的参数里。只摘要正文，模型就不知道自己读过什么、提交过什么评论，于是重复探索、重复提交。
3. **改动前缀会破坏缓存**：各家的提示缓存都以请求前缀为单位。DeepSeek 按 Token 前缀匹配；OpenAI 只在消息边界（断点）处查找，Anthropic 按内容块哈希。只要修改了系统提示或初始任务所在的消息，之后的请求就要把很大的 Diff 重新计算一遍。

## 2. 三区记忆压缩

**源码**：[`src/domain/compression.ts`](../../src/domain/compression.ts)

每次调用模型之前，如果上下文 Token 数超过 `maxContextTokens × warningWatermark`（默认值见 [配置参考](../guides/configuration-reference.md#32-预算控制配置-budget)），就先对消息序列分区并压缩。放在调用之前检查，是因为 GitHub App 会话在接着上一次对话继续时会追加一条新消息（新提交的 diff 或作者的回复），这条消息本身就可能让上下文越过阈值。

### Token 测量

**源码**：[`src/runtime/budget.ts`](../../src/runtime/budget.ts) 中的 `ContextMeter`

不使用分词器。上下文大小以 **API 对上一次请求计费的 `prompt_tokens` 为锚点**，加上锚点之后新追加消息（上一轮的回复与工具调用、这一轮的工具结果、会话追加的后续消息）的字符估算。估算只覆盖新增的一小段，误差影响很小。各协议的 `promptTokens` 都已换算为包含缓存命中与缓存写入的总输入量。

- **字符估算**：字符数 ÷ 2.35（`CHARS_PER_TOKEN`），是 DeepSeek 在代码类上下文上的实测系数；`reasoning_content` 不回传给 API，不计入。
- **没有锚点时估算整个请求**：子任务的第一次调用、会话恢复后（会话文件不保存每条消息的 usage）、压缩改写历史之后（上一次的计数已作废）。此时还要加上工具定义的估算，它随每个请求发送但不在消息里。
- **余量**：水位线之上留有 `maxContextTokens × (1 − warningWatermark)` 的窗口，取值时应让它大于一次工具输出的上限（40k 字符，约 17k token）。
- **审查开始之前**还没有任何 API 返回值，文件组分组预算（`× 0.25`，超过它的单个文件改为从挂载读取，见 [第 4 节](#4-文件组审查工作区与初始任务)）也使用同一字符估算。

每次压缩都写入 trace 的 `compressions` 数组，见 [运行时架构](runtime-architecture.md#7-run-trace)。

### 分区与记忆槽

越过阈值时，消息序列按下图分区：

```text
┌───────────────────┬──────────────┬───────────────────────────┬──────────────────────────┐
│ Frozen [0..1]     │ Memory [2]   │ Compress                  │ Active                   │
│ 系统提示 + 初始任务│ 上次压缩的记忆│ [historyStart..compressEnd)│ [compressEnd..N]         │
│ 永不修改          │ （首次时没有）│ 较早的完整轮次            │ 最近若干完整轮次         │
└───────────────────┴──────────────┴───────────────────────────┴──────────────────────────┘
                            │                  │
                            └────────┬─────────┘
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
     从工具调用直接提取（确定性）          LLM 摘要（读取工具结果）
     · 旧轨迹原样保留，新调用接在后面      · 合并上次摘要与新的历史
     · 名称 + 参数，评论标记 recorded      · 事实 / 已证实或排除的假设 / 待查疑点
     · 失败调用附错误
                    └────────────────┬────────────────┘
                                     ▼ 整条替换 Memory 槽位
┌───────────────────┬──────────────────────────────────┬──────────────────────────┐
│ [0] 系统提示      │ [2] user：<actions_taken>         │ Active（原样保留）       │
│ [1] 初始任务      │         + <previous_review_summary>│                          │
└───────────────────┴──────────────────────────────────┴──────────────────────────┘
```

**缓存不变量**：`[0]`、`[1]` 两条消息从不修改，压缩只会替换 `[2]` 这一个记忆槽位。无论是按 Token 前缀、按消息边界还是按内容块匹配的缓存，系统提示和 Diff 在每次压缩后都能继续命中；需要重新计算的只有记忆本身和它后面的内容。以 DeepSeek 实测：压缩后的第一轮命中约 1.3k Token 的冻结区，下一轮记忆槽位也进入缓存。

记忆槽位的消息内容如下（`role: "user"`，紧跟在初始任务之后）：

```text
Working memory of your earlier turns on this file group (older turns were compressed).

<actions_taken>
- grep_code {"pattern":"verifyUserToken|authenticateAdmin"}
- read_file {"path":"package.json"}
- code_comment {"path":"src/auth/jwt.ts","line":5,"severity":"P0","title":"Token signature is never verified"} → recorded
- read_file {"path":"src/gone.ts"} → Error executing tool 'read_file': file 'src/gone.ts' does not exist
(Results are summarized below; re-run a call only if you need the exact output. Comments marked "recorded" are already submitted; do NOT submit them again.)
</actions_taken>

<previous_review_summary>
（模型从工具结果中归纳的事实、已验证的假设和待查疑点）
</previous_review_summary>
```

- **Frozen**：系统提示、仓库规则、Diff 与 PR 背景，从不裁剪，也从不修改。
- **Memory**：结构化地保存在消息的 `memory` 字段（`{ actions, summary }`）中，`content` 由它渲染而来；`memory` 字段只在内部使用，不会发给 API。
- **轨迹（`<actions_taken>`）**：按调用顺序列出所有被压缩的工具调用，只保留**名称和参数**，不保留工具结果，因此能看出哪些证据引出了哪条评论。`code_comment` 只保留位置、级别和标题，不含正文：被接受的标记 `→ recorded`，并提示模型不要重复提交；失败的调用（包括被拒绝的评论）附上错误首行，避免模型重试同样会失败的调用。参数超过 300 字符的部分截断。会话中的后续事件（作者推送了哪个提交、改了哪些文件；谁在哪条发现下回复了）以 `- [event] …` 记入轨迹，与工具调用按发生顺序排列；这些事件消息的正文（diff、回复内容）只作为摘要的输入。再次压缩时，旧轨迹原样保留，新的调用接在后面，不经过 LLM 改写。
- **摘要（`<previous_review_summary>`）**：工具结果只作为摘要调用的输入，不进入压缩后的上下文。再次压缩时，上次的摘要和新的历史一起交给摘要模型，合并成一份新摘要。摘要只写结论，不复述调用过的工具或提交过的评论，因为它们已经记录在轨迹里。
- **Active**：最近的若干完整轮次原样保留。分区总是落在轮次边界上，assistant 的工具调用与对应的工具结果不会被拆开。

### 活跃区大小

活跃区不是固定轮数，而是从最新一轮往前累加，直到达到 `maxContextTokens × warningWatermark × 0.5 − (Frozen + Memory) 的 Token 数`（各部分均按字符估算，与压缩后的复查口径一致）。留出一半余量，是为了让"Frozen + Memory + 活跃区"明显低于触发线，避免下一轮立刻再次压缩。如果所有轮次都放得下，就不压缩，也不调用 LLM。

### 失败与停止

- 摘要调用失败时保留原消息不变；若是因为取消而失败，则继续向上抛出。
- 压缩后对整个请求重新估算，仍超过水位线，说明 Frozen 区（或累积的记忆）本身过大，子任务以 `compression` 停止。
- 摘要调用的花费计入成本预算。

> 上下文窗口只用于压缩判断，不限制花费（`softWatermark` 为后续后台压缩预留，当前不生效）；花费由 `maxCostUsd` 控制，见 [运行时架构](runtime-architecture.md#2-预算控制)。

## 3. Diff 渲染与行号锚定

### 3.1 带行号的 Diff

**源码**：[`src/domain/diff-parser.ts`](../../src/domain/diff-parser.ts)

为了避免模型自己数行号出错，送给模型的 Diff 中每一行都带有 GitHub 评论所需的行号：

- `R<n> + code`：新文件第 n 行，新增行（`side: RIGHT`）
- `L<n> - code`：旧文件第 n 行，删除行（`side: LEFT`）
- `R<n>   code`：上下文行

```xml
<file_diff path="src/auth.ts" type="modify">
@@ -15,6 +15,7 @@
R15   function verifyToken(token: string) {
R16 +   if (process.env.DEBUG === "true") return true;
R17   }
</file_diff>
```

### 3.2 锚点校验（`DiffAnchorRelocator`）

**源码**：[`src/domain/relocator.ts`](../../src/domain/relocator.ts)

GitHub 要求行内评论的行号必须落在 Diff 的 hunk 内，否则整个 Review 会被 HTTP 422 拒绝。提交前对每条评论做三级处理：

1. **落在 hunk 内**：原样作为行内评论；多行评论的起始行也必须在同一个 hunk 内，否则退化为单行。
2. **距离最近的 hunk 边缘不超过 15 行**：移到该边缘，并在正文注明原始行号；同时丢弃 suggestion 代码块，因为它会替换错误的行。
3. **更远，或文件不在 Diff 中**：不作为行内评论，改写进 Review 正文的 "Findings Outside the Diff" 小节，问题不会丢失，Review 也能提交成功。

## 4. 文件组、审查工作区与初始任务

**源码**：[`src/domain/grouping.ts`](../../src/domain/grouping.ts)、[`src/domain/workspace.ts`](../../src/domain/workspace.ts)、[`src/domain/prompt.ts`](../../src/domain/prompt.ts)、[`src/domain/coverage.ts`](../../src/domain/coverage.ts)

设计讨论与 GitHub diff 接口的实测限制见 [RFC-002](large-pr-context-rfc.md)。

### 4.1 文件组

生成文件 / lockfile 和没有文本 hunk 的文件（二进制、纯重命名、权限变更）不审查，记入 `skippedFiles`。其余文件按 `groupTokenBudget = maxContextTokens × warningWatermark × 0.25`（默认约 51k token）分组：

- **diff 放得下**：只有一组，agent 一次看到全部改动。
- **放不下**：按路径顺序贪心打包，每组一个对话，顺序执行。
- **单个文件超过组预算（oversized）**：单独成组。初始任务里只放它的 hunk 索引（每个 hunk 的头部、`R<n>` 范围、在 `@pr-diff` 文件中的行范围），由 agent 用 `read_file` 分段读取。不会因为文件太大就跳过。
- **组数超过 `review.maxInlineGroups`（默认 8）**：低风险文件（测试、文档；`.github/` 下的除外）不再分组，改为按需审查（on demand）。它们仍可从 `@pr-diff` 读取，不占用预算份额；全是低风险文件的 PR 照常全量审查。配置文件不算低风险，因为配置会改变行为，CI 工作流也是安全面。

### 4.2 审查工作区（挂载目录）

除 head 版本的代码外，agent 需要的其他内容都以只读目录的形式挂载在仓库旁边，统一用 `read_file` 读取、用 `grep_code`（`path` 指定该目录）搜索；默认的全仓库搜索不进入挂载目录。不新增工具，因此工具定义（缓存前缀）不随数据源变化。

| 挂载点              | 内容                                                                                                                                                            | 提供方                                             | 可信度   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------- |
| `@pr-diff`          | 整个 PR 的改动：每个文件一份 `<path>.diff`（与 prompt 中相同的 `R<n>`/`L<n>` 锚点，可直接用于 `code_comment`），`index.md` 列出全部文件、审查方式与 hunk 行范围 | 每次审查自动生成                                   | 被审代码 |
| `@incremental-diff` | 增量审查时，自上次已审查提交以来的改动，结构同上                                                                                                                | 增量审查自动生成                                   | 被审代码 |
| `@base`             | merge base 版本中被修改、删除或重命名的文件（按旧路径）                                                                                                         | GitHub App、CLI `--git`、基准评测（checkout 模式） | 被审代码 |
| `@pr`               | `description.md`（PR 描述全文）、`commits.md`（提交信息）                                                                                                       | GitHub App；基准评测只有描述                       | 不可信   |
| `@ci-logs`          | 失败 CI 任务的日志                                                                                                                                              | GitHub App                                         | 不可信   |

`read_file` 读取 `@pr-diff` / `@incremental-diff` 下的文件时不再加 `N | ` 行号前缀，避免与 `R<n>`/`L<n>` 锚点混淆。每次读取都在完整的行处截断（最多 400 行、40k 字符），返回头中的行范围就是实际展示的行。

### 4.3 初始任务（Frozen 区 `[1]`）的结构

初始任务分两段：前一段是整个审查共用的内容，各组逐字节相同；后一段是本组专有的内容。各组因此共享前缀缓存，直到组名出现的位置。

```text
[1] user
    ┌ 审查级：所有组完全相同 ───────────────────────────
    │ 开场说明（组数）
    │ <requirement_background>   PR 标题与正文
    │ <ci_results>               CI 摘要（不可信）
    │ <workspace>                挂载目录、用途、可信度
    │ <changed_files>            全部变更文件：增删行数、所在组、审查方式
    │ <review_scope>             仅增量审查
    │ <findings_from_previous_reviews> / <open_findings>
    ├ 组级：本组专有 ───────────────────────────────────
    │ Your file group: "<组名>"
    │ <already_reported_findings_in_earlier_rounds>
    │ <target_file_diffs>        每个文件：完整 diff，或 mode="mounted" 的 hunk 索引
    │ 指令
    └───────────────────────────────────────────────────
```

审查方式（`<changed_files>` 与 `index.md` 中相同）：`inline`（diff 在本组 prompt 中）、`oversized`（所在组从挂载读取）、`on demand`（不属于任何组，按需读取）、`previously reviewed`（增量审查中自上次审查以来未变）、`skipped`（不审查）。会话延续时追加的后续消息同样带 `<workspace>` 段，提示挂载内容已按新 head 重新生成。

### 4.4 覆盖率

从挂载读取的 diff（oversized、on demand）按 hunk 统计覆盖率：某个 hunk 的完整行范围（含头部）被 `read_file` 返回过（可以分多次）才算已读。内联的 diff 在 prompt 中，视为已覆盖。未读完的文件写入 Review 正文的 "Partially Reviewed" 小节，并列出未读 hunk 的锚点范围；统计结果写入 `ReviewRunResult.coverage`、SQLite 的 `metrics_json` 和基准评测的审查记录。
