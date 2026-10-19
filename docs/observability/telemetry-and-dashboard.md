# 可观测性与 Dashboard 完全手册

> 本文系统性介绍 PR-Agent 的双轨可观测性架构：基于 OpenTelemetry + Arize Phoenix 的分布式追踪系统，以及零依赖、开箱即用的本地 SQLite 审查面板。

---

## 1. 可观测性双轨架构全景

PR-Agent 提供了“集群级分布式追踪”与“轻量化本地开箱即用”双轨支持：

```mermaid
flowchart TD
    Agent["PR-Agent Runtime 执行循环"] --> TraceRecorder["RunTraceRecorder (.pr-agent/traces/*.json)"]
    Agent --> OtelManager["AgentTelemetry (OpenTelemetry SDK)"]

    subgraph Track 1 [分布式链路追踪 (Arize Phoenix)]
        OtelManager --> OpenInference["OpenInference Semantic Conventions<br/>(AGENT / LLM / TOOL)"]
        OpenInference --> OtlpExporter["OTLP/HTTP Exporter"]
        OtlpExporter --> PhoenixServer["Arize Phoenix (端口 6006)<br/>调用链路瀑布流 / Token 开销分析"]
    end

    subgraph Track 2 [本地轻量看板 (SQLite Native)]
        TraceRecorder --> SqliteStore["SqliteTraceStore (.pr-agent/traces.db)"]
        SqliteStore --> LocalServer["Dashboard Server (端口 6007)<br/>pr-agent view"]
        LocalServer --> BrowserUI["内置现代化 Web UI (ui.html)<br/>缺陷统计 / 审查详情 / 推理回放"]
    end
```

---

## 2. OpenTelemetry + OpenInference 语义追踪

**源码实现**：[`src/telemetry/otel.ts`](../../src/telemetry/otel.ts)

PR-Agent 深度对齐了 LLM 行业标准的 **OpenInference 语义规范**（`@arizeai/openinference-semantic-conventions`），将执行过程划分为三类 Span：

| Span 类型   | 标识符                   | 追踪范围与记录指标                                                                                                                     |
| :---------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| **`AGENT`** | `PRAgent.reviewPR`       | 整个 PR 审查的顶层 Span，记录最终结论、评论数与 Token 总量                                                                             |
| **`AGENT`** | `subtask.<group>`        | 单个文件组的多轮 ReAct 调度生命周期，标记 `subtask.stop_reason`                                                                        |
| **`LLM`**   | `llm.completion.<model>` | Prompt / Completion Token、缓存命中 Token（`llm.token_count.prompt_details.cache_read`）、花费（`llm.cost.total`，美元）、模型名与时延 |
| **`TOOL`**  | `tool.<tool_name>`       | 记录工具调用的函数名、JSON 输入参数、执行耗时与返回字符串截屏                                                                          |

### 2.1 启动与连接 Arize Phoenix

Arize Phoenix 是专为 LLM Agent 打造的开源追踪面板。

1. 使用 Docker 快速启动 Phoenix 实例：
   ```bash
   docker run -d -p 6006:6006 --name phoenix arize/phoenix:latest
   ```
2. 在 `pr-agent.config.ts` 或环境变量中配置：
   ```bash
   export PR_AGENT_TELEMETRY=true
   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:6006/v1/traces"
   ```
3. 在浏览器访问 `http://localhost:6006`，即可查看完整的调用调用链调用拓扑、输入输出 Token 消耗、时延瀑布流分析及异常报错堆栈。

---

## 3. 本地轻量化 SQLite 看板 (`pr-agent view`)

**源码实现**：

- 存储与指标聚合：[`src/telemetry/sqlite-store.ts`](../../src/telemetry/sqlite-store.ts)
- HTTP 服务端与安全防护：[`src/dashboard/server.ts`](../../src/dashboard/server.ts)
- 响应式 UI 模板：[`src/dashboard/ui.html`](../../src/dashboard/ui.html)

### 3.1 零外部依赖特性

无需安装 Redis、无需运行 Docker、无需配置 Phoenix。CLI 会在审查过程中自动将事件流与 Trace 数据持久化至本地 `.pr-agent/traces.db` SQLite 数据库中。

### 3.2 启动控制台

```bash
pr-agent view --port 6007
```

控制台即时输出：

```text
=== PR-Agent Observability Hub (SQLite Native) ===
Dashboard available at: http://127.0.0.1:6007
Connected to local SQLite: .pr-agent/traces.db
```

### 3.3 核心功能面板

1. **全局审查大盘 (Metrics Overview)**：
   - 累计审查总数、通过率（APPROVE vs REQUEST_CHANGES）。
   - 缺陷严重度分布看板（P0 致命阻塞、P1 严重缺陷、P2 主要逻辑、P3 次要缺陷、P4 代码风格）。
   - 累计 Token 消耗与花费（美元，按 DeepSeek 价格与缓存命中计算，与成本预算同一口径）。
2. **审查记录列表 (Review Explorer)**：
   - 按仓库、PR 编号、Commit SHA 列出历史审查明细与最终结论。
   - 支持通过搜索框过滤特定缺陷关键字或文件路径。
3. **确定性 Trace 逐轮复盘 (Reasoning & Tool Waterfall)**：
   - 点击任意一条历史记录，可直接展开完整的单轮交互细节。
   - 完整呈现 DeepSeek 模型的 **`reasoning_content`（深度思考推导链）**。
   - 点击工具节点查看输入参数（如 `grep_code` 搜索的 pattern）和返回匹配结果。

### 3.4 安全与防护机制

- **防 DNS Rebinding 攻击**：[`server.ts`](../../src/dashboard/server.ts) 校验 HTTP Host 请求头，仅允许来自 `localhost`、`127.0.0.1` 及指定绑定 IP 的访问，防止恶意第三方网站通过跨域重定向窃取内网代码审查敏感信息。
- **无外部 CORS 暴露**：UI 与 API 严格同源交付，全面保障代码隐私。
