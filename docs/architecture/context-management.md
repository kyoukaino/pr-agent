# 上下文管理与行号锚定

> 本文说明 PR-Agent 在多轮审查中如何管理上下文窗口（三区记忆压缩），以及如何保证评论行号能被 GitHub 接受。

## 1. 问题

一个文件组的审查通常需要 10～20 轮 `read_file` / `grep_code`，工具返回的代码片段很快会把上下文撑满：

1. **简单截断会丢失任务**：滑动窗口丢弃早期消息后，模型会忘记审查目标和 Diff。
2. **只做摘要会丢失轨迹**：调用工具的那一轮，assistant 消息的正文通常为空，信息都在工具调用的参数里。只摘要正文，模型就不知道自己读过什么、提交过什么评论，于是重复探索、重复提交。
3. **频繁重写会破坏缓存**：DeepSeek 的前缀缓存依赖请求前缀不变，压缩次数越少越好。

## 2. 三区记忆压缩

**源码**：[`src/domain/compression.ts`](../../src/domain/compression.ts)

每轮工具执行后，如果上下文 Token 数超过 `maxContextTokens × warningWatermark`（默认 128k × 0.8），就对消息序列分区并压缩：

```text
┌──────────────────────┬─────────────────────────────┬──────────────────────────┐
│ Frozen [0..1]        │ Compress [2..compressEnd)   │ Active [compressEnd..N]  │
│ 系统提示 + 初始任务  │ 较早的完整轮次              │ 最近若干完整轮次         │
└──────────────────────┴─────────────────────────────┴──────────────────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                              ▼
           LLM 摘要（探索轨迹）          从工具调用中直接提取
                                         已成功提交的评论列表
                    └──────────────┬───────────────┘
                                   ▼ 追加到初始任务消息之后
┌──────────────────────────────────────────────┬──────────────────────────┐
│ [0] 系统提示                                 │ Active（原样保留）       │
│ [1] 初始任务 + <previous_review_summary>     │                          │
│              + <comments_already_submitted>  │                          │
└──────────────────────────────────────────────┴──────────────────────────┘
```

- **Frozen**：系统提示、仓库规则、Diff 与 PR 背景，从不裁剪。
- **Compress**：送去摘要的历史。序列化时保留每次工具调用的**名称和参数**，以及对应工具结果，交给模型的摘要提示要求覆盖三点：已读过的文件与已执行的搜索、已证实或排除的假设、尚未提交的疑点。
- **已提交评论**：不依赖摘要质量，直接从压缩区里结果为 "Comment recorded" 的 `code_comment` 调用中提取，以 `- [P1] path:line: title` 的形式原样列出，并提示模型不要重复提交。
- **Active**：最近的若干完整轮次原样保留。分区总是落在轮次边界上，assistant 的工具调用与对应的工具结果不会被拆开。

### 活跃区大小

活跃区不是固定轮数，而是从最新一轮往前累加，直到达到 `maxContextTokens × warningWatermark × 0.5 − Frozen 区 Token 数`。留出一半余量，是为了让"Frozen + 摘要 + 活跃区"明显低于触发线，避免下一轮立刻再次压缩。如果所有轮次都放得下，就不压缩，也不调用 LLM。

### 失败与停止

- 摘要调用失败时保留原消息不变；若是因为取消而失败，则继续向上抛出。
- 压缩后仍超过水位线，说明 Frozen 区本身过大，子任务以 `compression` 停止。
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
