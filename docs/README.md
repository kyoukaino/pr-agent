# PR-Agent 文档

```text
docs/
├── architecture/
│   ├── runtime-architecture.md        # 调度循环、成本预算、Grace Round、容错、检查点
│   ├── context-management.md          # 三区记忆压缩、带行号的 Diff、锚点校验
│   ├── context-compression-investigation.md # 压缩的讨论与调查记录（token 估算偏差、待办）
│   └── github-app-deployment-rfc.md   # GitHub App 服务架构设计 (RFC-001)
├── guides/
│   ├── cli-reference.md               # review / server / view 子命令与参数
│   ├── configuration-reference.md     # 配置分层、全部配置项与示例
│   └── deployment-guide.md            # Docker Compose 部署与 GitHub App 配置
├── observability/
│   └── telemetry-and-dashboard.md     # OpenTelemetry / Phoenix 链路追踪与本地看板
└── benchmarks/
    └── evaluation-guide.md            # AACR-Bench 与 Martian 评测流程与指标口径
```

## 架构

- [运行时架构](architecture/runtime-architecture.md)：ReAct 调度循环与停止原因；按 DeepSeek 价格与缓存命中计算的成本预算，以及按文件组公平分配的方式；Grace Round 与前缀缓存保护；重试、熔断、取消；检查点与断点续跑。
- [上下文管理](architecture/context-management.md)：Frozen / Compress / Active 三区压缩，保留工具调用轨迹与已提交评论；带 `R<n>` / `L<n>` 行号的 Diff；避免 GitHub 422 的锚点校验。
- [上下文压缩：讨论与调查记录](architecture/context-compression-investigation.md)：异步压缩方案选择、会话场景的问题，以及基于基准测试 trace 的调查（token 估算偏低约 1.7 倍，压缩从未触发）和待办。
- [GitHub App 架构 RFC](architecture/github-app-deployment-rfc.md)：Webhook 验签后立即返回 202、BullMQ 排队限流、新提交到来时取消旧任务。

## 使用

- [CLI 参考](guides/cli-reference.md)：三个子命令的参数、环境变量与常见用法。
- [配置参考](guides/configuration-reference.md)：优先级为命令行参数 > 环境变量 > 配置文件 > 默认值；`model`、`budget`、`review`、`telemetry`、`rules` 各字段说明。
- [部署指南](guides/deployment-guide.md)：Docker Compose（服务 + Redis 7 + Phoenix）、GitHub App 权限与 Webhook、健康检查。

## 可观测性

- [链路追踪与看板](observability/telemetry-and-dashboard.md)：按 OpenInference 语义规范埋点并通过 OTLP 上报 Phoenix；`pr-agent view` 打开基于 SQLite 的本地看板，回放每次审查。

## 评测

- [评测指南](benchmarks/evaluation-guide.md)：AACR-Bench 与 Martian 的数据版本与指标口径、LLM-as-a-Judge、可复现性记录与命令。
