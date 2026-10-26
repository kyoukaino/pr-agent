# RFC-002: 超大 PR 与审查上下文的访问方式

- **状态**: 阶段 0–4 已实现（2026-10）；阶段 5（`git_inspect`）规划中，按需引入
- **相关文档**: [上下文管理](context-management.md)、[运行时架构](runtime-architecture.md)、[GitHub App 架构 RFC](github-app-deployment-rfc.md)

> 本文讨论两个问题：PR 大到放不进一个对话时怎么审查；agent 需要 diff 之外的信息（改动前的代码、其他文件组的改动、提交意图、CI 日志）时通过什么方式访问。结论是统一用只读挂载目录暴露"某个版本下的文件"，只有跨版本才能算出的信息才考虑受限的 git 工具，并分阶段实现。

## 1. 实现前的状况

| 环节       | 当前行为                                                                                                                                         | 源码                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 分组       | 每组 diff 预算 `maxContextTokens × warningWatermark × 0.25`（默认约 51k token），超出时按路径顺序贪心打包，每组一个对话，顺序执行                | `src/domain/grouping.ts`                      |
| 组间可见性 | 其他组只能看到 `<other_changed_files_in_pr>` 中的路径列表，看不到改动内容                                                                        | `src/domain/prompt.ts`                        |
| 超大单文件 | diff 超过 `maxContextTokens × warningWatermark` 的文件记为 `too_large` 并跳过，agent 完全看不到                                                  | `src/index.ts`                                |
| 成本预算   | 默认 $1，在剩余文件组间公平分配；组越多，每组越少                                                                                                | `src/runtime/budget.ts`                       |
| 代码检出   | 只浅检出 head（`--depth=1`），没有 base 版本和历史                                                                                               | `src/github-app/checkout.ts`                  |
| Diff 来源  | GitHub API `pulls.get` 的 diff 格式；变更文件超过 300 个时返回 406，diff 达到十几 MB 时传输可能中断（见 1.1）。增量审查用的 compare API 同样受限 | `src/github-app/worker.ts`                    |
| CI 日志    | 失败任务的日志写入临时目录，挂载为 `@ci-logs`，通过 `read_file` / `grep_code` 读取；默认的全仓库搜索不进入挂载目录                               | `src/github-app/ci.ts`、`src/domain/tools.ts` |

`ToolDispatcher` 的 `mounts` 已是通用机制：多个前缀、各自的越界与符号链接校验。`code_comment` 能评论的范围是整个 PR 的变更文件（`changedPaths`），锚点也对照整个 PR 的 diff 校验，所以一段改动即使不在 prompt 里，也能正常评论。

### 1.1 GitHub diff 接口的限制

官方文档只给出了部分限制，其余来自 2026-10 对公开 PR 的实测（`nodejs/node`、`microsoft/TypeScript`）：

| 接口                        | 限制                                                                                                                                                                                                                  | 来源                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /pulls/{n}`，diff 格式 | 变更文件超过 300 个时返回 406，错误码 `too_large`，提示信息为 "the diff exceeded the maximum number of files (300)"，并建议改用 List pull requests files 或在本地克隆。文档只把 406 列为 "Unacceptable"，没有写明阈值 | 实测：331 个文件失败，109 个文件成功                         |
| 同上                        | 没有观察到行数上限：变更约 3.9 万行、diff 约 8.5 万行（6.7 MB）的 PR 正常返回。网上流传的"3000 行""2 万行"上限均与实测不符                                                                                            | 实测                                                         |
| 同上                        | 体积很大的 diff 先返回 200，但正文可能传输到一半被服务端中断：8 MB 用了约 130 秒，成功；13–18 MB 在约 150 秒时被中断，只收到一部分                                                                                    | 实测；文档对 Get a commit 也提到 "Larger diffs may time out" |
| `GET /pulls/{n}/files`      | 最多返回 3000 个文件；大文件的 `patch` 字段会被省略，阈值未公开（实测 412 行的 JSON 文件被省略，1578 行的源码保留，推测按字节计）                                                                                     | 文档 + 实测                                                  |
| `GET /compare/{basehead}`   | 文件列表最多 300 个，只出现在第一页；不分页时最多 250 个提交。增量审查的 `fetchIncrementalDiff` 用的就是它的 diff 格式                                                                                                | 文档                                                         |

结论：超大 PR 不能指望 GitHub API 提供完整的 diff。`/files` 接口也会省略大文件的 patch，不能作为完整的替代来源。完整的 diff 只能在本地用 git 生成，见阶段 3。

## 2. 两类问题，两层方案

这里其实是两个互相独立的问题，方案也分两层，共用同一套挂载底座：

| 问题                                 | 场景                                                              | 方案                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **规模**：改动太多，放不进一个对话   | 大 PR 被拆成多组，组间互相看不见；超大文件被丢弃；预算被摊薄      | 分组保证覆盖，`@pr-diff` 补足组间可见性，超大文件改为挂载，按风险分层，统计覆盖率                     |
| **访问**：agent 缺少 diff 之外的信息 | 需要看改动前的代码、提交意图、CI 日志；需要知道某行由哪次提交引入 | 按信息形态区分：**快照类**（某个确定版本下的文件）用挂载；**查询类**（需要跨版本计算）用受限 git 工具 |

### 2.1 为什么分组不能被"按需检索"取代

如果只内联一部分 diff、其余让 agent 自己读，能否覆盖全部改动就取决于模型是否主动去读。flash 级别的模型通常读得不够，而且漏审是静默的：Review 看起来正常发布了。分组能保证每一行改动都确实出现在某个对话中，所以它仍是覆盖率的保证。挂载只负责补充上下文，以及在预算不够时承接低风险文件，并且必须配合覆盖率统计（见第 5 节阶段 2）。

### 2.2 快照类与查询类的界线

- **快照类**：内容只取决于"哪个版本、哪个路径"，可以在审查开始前生成好，例如 PR diff、base 版本的文件、PR 描述、提交列表、CI 日志。用挂载：不新增工具，白得 ripgrep 搜索，复用现有的路径校验。
- **查询类**：内容需要在多个版本之间计算，没法预先为每个文件生成，例如 `blame`、"这一行是 PR 中哪次推送引入的"。这类才值得做专用工具。

## 3. 挂载方案设计

### 3.1 挂载点

```text
@pr-diff/
  index.md                    每个文件：类型、增删行数、hunk 头部、所在文件组；超大或分层降级的文件单独标注
  src/auth/session.ts.diff    与仓库路径对应的 promptDiff，保留 R<n> / L<n> 锚点
@base/
  src/auth/session.ts         merge base 版本，只包含 PR 改动或删除的文件
@pr/
  description.md              PR 标题与正文（不可信）
  commits.md                  PR 内的提交列表与提交信息（不可信）
@ci-logs/                     失败任务日志（已实现）
```

- `@pr-diff` 按仓库路径组织，`grep_code(path="@pr-diff", pattern=...)` 一次搜遍所有改动，结果中的 R/L 锚点可以直接用于 `code_comment`。
- `@base` 只放改动过的文件：未改动的文件在 base 与 head 中相同，读 head 即可，因此生成成本很小。
- `@pr` 与 `@ci-logs` 一样来自 PR 参与者或被审代码，视为不可信数据，在 prompt 中标注来源。

### 3.2 生命周期

与 `@ci-logs` 一致：准备阶段写入临时目录，作为 `mounts` 交给 engine 与 `ToolDispatcher`，审查结束后清理。挂载内容是本次审查所基于版本的只读快照。

| 入口       | `@pr-diff`      | `@base`                                                                                                             | `@pr`                            |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| GitHub App | 由 PR diff 生成 | 检出时额外抓取 merge base（`--depth=1`），用临时 index 执行 `git checkout <base> --pathspec-from-file` 写出改动文件 | `pulls.get`、`pulls.listCommits` |
| CLI        | 由 diff 生成    | `--git` 模式下从本地仓库读取；`--diff` 文件模式下没有                                                               | 无                               |
| 基准评测   | 由 diff 生成    | checkout 模式下抓取 merge base 写出；diff-only 模式下没有                                                           | 只有 `description.md`            |

没有对应数据时不挂载，`<workspace>` 段中也不列出。增量审查另有 `@incremental-diff`（自上次已审查提交以来的改动，结构同 `@pr-diff`），过大文件的 hunk 索引指向它。

### 3.3 Prompt 与缓存

- 工具说明只改一次：把 `read_file` / `grep_code` 中针对 `<ci_results>` 的措辞改为"可读取 `<workspace>` 中列出的挂载目录"。改动后固定不变，不随 PR 或会话中的事件变化。
- 挂载点列表随 PR 而变，放在初始任务消息（Frozen 区 `[1]`）中新增的 `<workspace>` 段，不放进系统提示。
- 增量审查时挂载内容按新 head 重新生成，工具定义不变，缓存前缀不受影响。follow-up 消息需提示 `@pr-diff`、`@base` 已更新，之前读到的内容可能过时。
- `read_file` 读取 `.diff` 文件时不加 `N | ` 行号前缀，避免与 R/L 锚点混淆。

## 4. 受限 git 工具设计（按需引入）

仅在 trace 证明查询类需求确实存在时引入，例如 agent 频繁在 `@base` 与 head 之间来回比对，或需要判断某行由哪次推送引入。

```ts
git_inspect({
  op: "blame" | "log",                       // 初期只开放这两个
  rev: "base" | "head" | "last_reviewed",    // 符号名，服务端解析为 SHA
  path: string,
  start_line?: number,
  end_line?: number,
})
```

- 模型只能传符号名，不能传任意 rev 字符串，杜绝 `--output=...` 一类的参数注入和引用语法。
- argv 用固定模板生成，path 放在 `--` 之后，并先经过 `resolvePath` 校验。
- 运行环境加固：`GIT_CONFIG_NOSYSTEM=1` 并隔离 `HOME`；`--no-ext-diff --no-textconv`，防止 PR 中的 `.gitattributes` 触发外部程序；禁用 pager；设置超时，输出复用 `clipOutput` 截断。
- 历史深度是主要成本：检出时按 PR 提交数抓取（`--shallow-exclude=<base>` 或 depth = 提交数 + 1），`blame` 限定在 `base..head` 范围。追溯到 PR 之前需要完整历史，大仓库不可行，不在范围内。
- `last_reviewed` 对应增量审查中 `L<n>` 的含义（上次已审查的提交），两者语义一致。
- 不做 git 命令透传：安全面过大（配置、属性、参数注入），浅检出下多数命令没有意义，过于开放的能力也会让探索成本失控。

### 4.1 两种方式对比

| 维度         | 挂载                               | 受限 git 工具                                      |
| ------------ | ---------------------------------- | -------------------------------------------------- |
| 适合的信息   | 某个版本下的文件，可预先生成       | 需要跨版本计算的结果                               |
| 何时生成     | 审查前全部生成，未使用也有生成成本 | 调用时执行，但仓库中需事先具备足够历史             |
| 搜索         | 直接复用 ripgrep                   | 需要额外的 `git grep` 操作                         |
| 工具集与缓存 | 不新增工具                         | 新增时缓存前缀失效一次，之后每加一个 op 再失效一次 |
| 模型使用难度 | 低，与读文件相同                   | 较高，op × rev 组合更易传错                        |
| 安全面       | 复用 `resolvePath`，只读文件       | 需处理 git 配置、属性、参数注入                    |
| 增量会话     | 每次推送重新生成快照               | `base` / `head` 含义随推送变化                     |
| 测试         | 目录快照即可作为 fixture           | 需构造带历史的临时仓库                             |

## 5. 实现阶段

阶段 0–4 已实现；实现后的行为说明见 [上下文管理](context-management.md#4-文件组审查工作区与初始任务) 与 [GitHub App 架构 RFC](github-app-deployment-rfc.md#34-独立临时工作区与安全克隆)。下面记录各阶段的落地方式、与原计划不同的决定，以及验收情况。实现顺序按依赖排列：先做挂载底座（阶段 0），再做依赖它的阶段 1–4；原计划中"先只做 API 失败时的本地回退"一步，因阶段 3 同时完成，直接以本地生成为默认、GitHub diff 为回退。

### 阶段 0：挂载通用化 ✅

- `ReviewPROptions.ciLogsDir` 改为 `mounts: Record<string, string>`，挂载名与说明集中在 `src/domain/workspace.ts`（`CI_LOGS_MOUNT` 等常量也移到这里）。
- 初始任务新增 `<workspace>` 段，按固定顺序列出挂载点、用途与可信度；后续消息同样带上，提示内容已按新 head 重新生成。
- `read_file` / `grep_code` 的工具说明改为指向 `<workspace>`。这是一次性的工具定义变化：部署后第一次请求的缓存前缀会失效一次。

### 阶段 1：`@pr-diff`、超大文件挂载与初始任务拆分 ✅

- 每次审查都生成 `@pr-diff`（以及增量审查的 `@incremental-diff`）：每个文件一份 `<path>.diff`，内容就是 promptDiff；`index.md` 列出全部文件、审查方式与每个 hunk 在 `.diff` 文件中的行范围（`DiffHunkRange` 新增 `promptStart` / `promptEnd`）。
- 超大文件的阈值从 `maxContextTokens × warningWatermark` 改为组预算 `× 0.25`：介于两者之间的文件以前会整个内联、挤占压缩预算，现在同样单独成组、只放 hunk 索引。`skippedFiles` 的 `too_large` 取消，这类文件的审查方式记为 `oversized`。
- `<other_changed_files_in_pr>` 改为 `<changed_files>`：每个文件一行（路径、增删行数、所在组、审查方式）。
- **初始任务拆分**：审查级内容（背景、CI、挂载点、文件列表、历史发现）放在前面，组名及之后的本组内容放在后面，各组共享前缀缓存。
- `read_file` 读取 diff 挂载中的文件时不加行号前缀；所有读取都在完整的行处截断，返回头中的行范围就是实际展示的行。
- **验收**：单元测试覆盖挂载写出（含路径越界）、hunk 行范围、初始任务的共享前缀与 hunk 索引渲染、diff 挂载的读取。基准评测上的召回率与成本对比**尚未进行**。

### 阶段 2：覆盖率统计与披露 ✅

- `ToolDispatcher` 通过 `onFileRead` 报告每次 `read_file` 实际返回的行范围，`CoverageTracker` 按 hunk 汇总；内联 diff 视为已覆盖。
- 未读完的文件写入 Review 正文的 "Partially Reviewed" 小节（列出未读 hunk 的锚点范围），统计写入 `ReviewRunResult.coverage`、SQLite `metrics_json` 与基准评测的审查记录。看板目前没有专门展示覆盖率，可从 `metrics_json` 查看。

### 阶段 3：本地生成 diff 与 `@base` ✅

- `src/github-app/pr-context.ts`：通过 compare API 取得 merge base，与 head（增量审查时还有上次已审查的提交）一起浅抓取，然后在本地生成 PR diff 与增量 diff（`src/domain/git-snapshot.ts`）。提交抓取失败时回退到 GitHub 的 diff；增量 diff 拿不到时改为全量审查。
- 本地 diff 忽略全局与系统 git 配置，显式指定 `--find-renames`、`--unified=3`、`a/` / `b/` 前缀、`core.quotePath=false`、`--no-ext-diff --no-textconv`，并为 `*.html` 指定 git 内置的 `html` diff 驱动（GitHub 也这样做，否则 HTML 文件 hunk 头部后的上下文文字会不同）。
- `@base` 用临时 index 写出改动文件的旧版本，不触碰仓库自身的 index 与工作区；符号链接写成普通文件。GitHub App、CLI `--git` 与基准评测（checkout 模式）都提供。
- **验收**：14 个真实 PR（`vitejs/vite` 9 个，含 34 个重命名的 PR；`spf13/cobra` 5 个）的本地 diff 与 GitHub 返回的 diff 在文件、hunk 与每一行上完全一致。331 个文件、GitHub 返回 406 的 `nodejs/node` PR 可以在本地生成完整 diff。

### 阶段 4：分层处理与 `@pr` ✅

- 配置项 `review.maxInlineGroups`（默认 8，`0` 表示从不降级）：组数超过它时，测试与文档文件不再分组，改为按需审查，仍可从 `@pr-diff` 读取，并计入覆盖率。与原计划不同，配置文件**不**降级：配置会改变行为，CI 工作流也是安全面；`.github/` 下的文件一律不算低风险。全是低风险文件的 PR 照常全量审查。
- `@pr/description.md`（PR 描述全文）与 `@pr/commits.md`（提交信息）按不可信内容标注；初始任务中的 `<requirement_background>`（标题与正文前 4000 字符）保持不变。
- **验收**：默认值 8 尚未经基准评测校准；大 PR 子集上"分层"与"平均分配预算"的召回率与成本对比**尚未进行**。

### 阶段 5（按需）：`git_inspect`

- 触发条件：trace 显示存在第 4 节所述的查询类需求。
- 初期只开放 `blame`（限定 `base..head`）与 `log`；检出改为按 PR 提交数抓取历史。
- 加入 `MAIN_TOOL_DEFINITIONS`，对所有模式一次性生效。已保存的 PR 会话恢复后第一轮会全量重算，之后恢复缓存命中；在 [上下文管理](context-management.md) 中注明。
- **验收**：参数注入与 `.gitattributes` 外部程序的安全测试；同一会话内工具集保持不变。

## 6. 不在范围内

- 用检索完全取代分组。
- git 命令透传，或追溯到 PR 之前的完整历史。
- 让 `grep_code` 的默认全仓库搜索进入挂载目录（保持现状，避免干扰代码搜索）。
