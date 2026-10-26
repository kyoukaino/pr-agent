# PR-Agent 配置系统全量参考手册

> 本文系统性解析 PR-Agent 基于现代 Node.js 标准构建的分层配置系统、Zod 运行时校验规则及全部配置项详单。

---

## 1. 分层配置优先级体系

PR-Agent 采用业内成熟的现代化分层配置引擎（基于 [`c12`](https://github.com/unjs/c12) + [`jiti`](https://github.com/unjs/jiti) + [`zod`](https://github.com/colinhacks/zod) 实现），加载逻辑位于 [`src/config/loader.ts`](../../src/config/loader.ts)。

配置项解析具有严格的层级优先级，高优先级覆盖低优先级：

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. CLI 显式参数 (--model, --max-cost, -t 等)                 │ ◄── 最高优先级
├─────────────────────────────────────────────────────────────┤
│ 2. 操作系统环境变量 (PR_AGENT_*, DEEPSEEK_API_KEY 等)       │
├─────────────────────────────────────────────────────────────┤
│ 3. 配置文件 (pr-agent.config.ts / .js / .pr-agentrc.json)   │
├─────────────────────────────────────────────────────────────┤
│ 4. 内置默认值 (Zod Schema Default Values)                   │ ◄── 最低优先级
└─────────────────────────────────────────────────────────────┘
```

支持自动识别与免编译热解析以下配置文件命名（按查找顺序）：

- `pr-agent.config.ts`（推荐，原生 TypeScript 智能补全）
- `pr-agent.config.js` / `pr-agent.config.mjs`
- `.pr-agentrc` / `.pr-agentrc.json`

---

## 2. 核心配置文件范式 (`pr-agent.config.ts`)

使用导出的 `defineConfig` 辅助函数可享受 TypeScript 类型安全提示：

```typescript
// pr-agent.config.ts
import { defineConfig } from "pr-agent";

export default defineConfig({
  // 1. 模型与通信
  model: "deepseek-flash",
  baseURL: "https://api.deepseek.com",
  temperature: 0.1,

  // 2. 资源预算控制器
  budget: {
    maxCostUsd: 1,
    maxContextTokens: 256_000,
    softWatermark: 0.6,
    warningWatermark: 0.8,
    roundTimeoutMs: 300_000,
    totalTimeoutMs: 1_800_000,
  },

  // 3. 安全上限（不属于预算）
  limits: {
    maxRounds: 100,
  },

  // 4. 审查策略
  review: {
    minSeverityToBlock: "P1",
    maxCommentsPerReview: 30,
    enableAstGrep: true,
  },

  // 5. 自研可观测性接入
  telemetry: {
    enabled: true,
    serviceName: "pr-agent",
    phoenixEndpoint: "http://localhost:6006/v1/traces",
  },

  // 6. 业务自研审查规范 (动态注入 System Prompt)
  rules: [
    "Verify JWT and authentication secrets are not hardcoded or leaked in logs",
    "Ensure all async database and external network calls have timeout handling",
    "Prevent race conditions in concurrent state mutations",
  ],
});
```

---

## 3. 全量配置项详细清单 (Schema Reference)

所有配置项均在 [`src/config/schema.ts`](../../src/config/schema.ts) 中声明并经过 Zod 强校验：

### 3.1 基础模型配置

| 字段          | 类型   | 默认值                       | 说明                                                          |
| :------------ | :----- | :--------------------------- | :------------------------------------------------------------ |
| `model`       | string | `"deepseek-flash"`           | 选用的模型名称。候选：`deepseek-flash`、`deepseek-v4-pro`     |
| `apiKey`      | string | `undefined`                  | 模型 API Key。若缺省则自动回退读取环境变量 `DEEPSEEK_API_KEY` |
| `baseURL`     | string | `"https://api.deepseek.com"` | API 服务端根地址                                              |
| `temperature` | number | `0.1`                        | 采样温度 (0.0 ~ 2.0)。代码审查要求高度确定性，推荐 `<= 0.2`   |

### 3.2 预算控制配置 (`budget`)

| 字段                      | 类型   | 默认值    | 说明                                                                                                                                     |
| :------------------------ | :----- | :-------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.maxCostUsd`       | number | `1`       | 单个 PR 审查的花费上限（美元，按 DeepSeek 价格与缓存命中计算），按剩余组数公平分给各文件组；`0` 为不限。环境变量 `PR_AGENT_MAX_COST_USD` |
| `budget.maxContextTokens` | number | `256000`  | 用于压缩判断的上下文窗口，不限制花费                                                                                                     |
| `budget.softWatermark`    | number | `0.6`     | 预留：后续非阻塞后台压缩的参考线，当前不触发任何行为                                                                                     |
| `budget.warningWatermark` | number | `0.8`     | 警戒水位阈值（80%），每次调用模型前上下文达到该比例即触发同步记忆压缩                                                                    |
| `budget.roundTimeoutMs`   | number | `300000`  | 单次 LLM 调用的超时（5 分钟），超时按可重试错误处理                                                                                      |
| `budget.totalTimeoutMs`   | number | `1800000` | 单个 PR 审查的总时长上限（30 分钟），与成本一样按剩余组数分配                                                                            |

### 3.3 安全上限 (`limits`)

| 字段               | 类型   | 默认值 | 说明                                                                                                             |
| :----------------- | :----- | :----- | :--------------------------------------------------------------------------------------------------------------- |
| `limits.maxRounds` | number | `100`  | 每个文件组的 ReAct 轮次安全上限，防止失控循环；不属于预算，正常审查应由 `task_done` 结束。触发时执行 Grace Round |

### 3.4 审查策略配置 (`review`)

| 字段                          | 类型    | 默认值 | 说明                                                                                                                                                                                                   |
| :---------------------------- | :------ | :----- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review.minSeverityToBlock`   | string  | `"P1"` | 阻断 PR 并返回 `REQUEST_CHANGES` 的最低缺陷级别。可选 `"P0"`, `"P1"`, `"P2"`, `"P3"`                                                                                                                   |
| `review.maxCommentsPerReview` | number  | `30`   | 单次 Review 的评论数上限，按严重程度保留（P0 优先），超出部分不提交，并在正文中注明省略数量                                                                                                            |
| `review.maxInlineGroups`      | number  | `8`    | 文件组数超过该值时，测试与文档文件不再分组，改为从 `@pr-diff` 按需审查，把预算留给代码（见 [上下文管理](../architecture/context-management.md#41-文件组)）；`0` 表示从不降级。默认值尚未经基准评测校准 |
| `review.enableAstGrep`        | boolean | `true` | 预留：`@ast-grep/napi` 结构化代码检索开关，当前尚未接入工具集                                                                                                                                          |

### 3.5 遥测与追踪配置 (`telemetry`)

| 字段                        | 类型    | 默认值                              | 说明                                      |
| :-------------------------- | :------ | :---------------------------------- | :---------------------------------------- |
| `telemetry.enabled`         | boolean | `true`                              | 是否全局启用 OpenTelemetry 遥测埋点与导出 |
| `telemetry.serviceName`     | string  | `"pr-agent"`                        | 链路追踪服务标识名                        |
| `telemetry.phoenixEndpoint` | string  | `"http://localhost:6006/v1/traces"` | Arize Phoenix OTLP/HTTP 接收端点          |

### 3.6 规则系统配置 (`rules`)

| 字段    | 类型     | 默认值 | 说明                                                                                                       |
| :------ | :------- | :----- | :--------------------------------------------------------------------------------------------------------- |
| `rules` | string[] | `[]`   | 团队自定义审查准则数组。每个规则字符串将自动注入到模型 System Prompt 的 `Repository Specific Rules` 段落下 |

---

## 4. 典型场景配置范例

### 场景 A：日常高吞吐快速审查型 (轻量 PR、极速反馈)

```typescript
export default defineConfig({
  model: "deepseek-flash",
  budget: {
    maxCostUsd: 0.2,
  },
  review: {
    minSeverityToBlock: "P0", // 仅极严重安全与阻断 Bug 才打回
    maxCommentsPerReview: 15,
  },
});
```

### 场景 B：高可靠金融 / 核心系统深度审计型

```typescript
export default defineConfig({
  model: "deepseek-v4-pro",
  temperature: 0.05,
  budget: {
    maxCostUsd: 3,
  },
  review: {
    minSeverityToBlock: "P1",
    maxCommentsPerReview: 50,
  },
  rules: [
    "Strictly check for SQL injection and unsafe ORM raw queries",
    "Ensure all monetary amounts use decimal/bigint instead of floating point numbers",
    "Audit RBAC authorization checks on all mutated controller endpoints",
    "Verify cryptographic signatures use constant-time comparison (crypto.timingSafeEqual)",
  ],
});
```
