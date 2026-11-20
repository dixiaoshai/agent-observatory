# 自定义会话来源

Agent Stats 可以在不使用 Agent Trace 或 Codex 的情况下，导入你提供的规范化用量数据。安装 Python 包后运行：

```sh
agent-stats example --output ./custom-source.json
agent-stats --db ./stats.sqlite3 import-json --input ./custom-source.json
agent-stats --db ./stats.sqlite3 summary
agent-stats --db ./stats.sqlite3 serve --archive-only --no-content
```

`example` 把随包提供的合成 JSON 导出为新文件，不打开数据库；目标文件已存在时拒绝覆盖。源码树中的 `docs/custom-source.example.json` 与包内资源由测试对齐。`--archive-only` 阻止看板读取本地 Codex 日志。既有的 `import` 与 `import-archive` 命令分别保留给 Codex 与 Trace 专用场景。

## JSON v1

根对象恰好包含 `version`（整数 1）、`source` 与 `instance`（非空字符串）、`sessions`（数组）。每个 session 要求非空字符串 `id` 与 `turns` 数组；可选字段为 `started_at`、`project`、`title`、`status`。每个 turn 要求非空字符串 `id`；可选字段为 `started_at`、`model`、`token_total`、`input_tokens`、`cached_input_tokens`、`output_tokens`、`tools`（工具名数组）。除 `tools` 外，可选字段可为 null。时间戳必须带时区。Token 计数为非负整数（最大 2^53-1）；缓存输入不得超过输入，且三者同时提供时总量必须等于输入加输出。缺失计数保持未知，不按零处理。不支持的字段会被拒绝。不要把 prompt 或密钥放进这些元数据字段：它们会存入数据库并由看板展示。

身份由（`source`、`instance`、session `id`）与 session 内的 turn `id` 共同限定。请选择稳定 ID。导入相同快照会跳过；变化后的快照替换整个 session，未出现的 session 不会被删除。批次内重复 ID 会被拒绝。整个批次先校验后写入，数据库失败会回滚整批。自定义身份与原生 Codex / Trace 身份相互独立。不同 provider 必须选择不同的 source / instance 命名空间。导入假定用量按 session 归属，不从其他 session 继承；若来源存在重叠用量，请先适配再导入。

## 查询结果中的观测用量、费用与覆盖

上述自定义 JSON v1 输入保持不变：它接受 turn / session 事实，不接受请求级记录或已记录成本。原生 Codex 累计快照保留按来源区分的差分、重放、重置与分叉基线处理。两种输入都不能证明 API 请求的完整清单。

Trace 的 pi / dsh 输入在 `usage_records` 中保留逐调用字段存在性（事件 ID、来源引用、记录身份、时间戳、模型、稀疏 `usage`、记录成本及其依据）。这些 ID 标识来源观测，不是 provider 请求 ID。adapter 合成的 `cumulative` 无法恢复缺失字段。一个已结算的 assistant 记录若没有用量，会产生一条空观测；显式零仍为零。压缩（compaction）用量是独立观测，不是推断出的 assistant 请求。重复归档页不会重复累加同一事实。

- 只有在每条相关观测都提供该字段时，`token_total` 与各 Token 分类才是在**观测记录范围内**完整的；`token_known` 与 `usage_known` 在部分轮次中仍保留已知小计。缺失字段保持 null，即使后续请求报告了值或显式零。
- `recorded_cost_usd` 只对每条观测都有成本的、可归属的观测记录完整；`recorded_cost_known_usd` 是它们的已知小计。只要存在任一记录成本，`estimated_cost` / `estimated_cost_known` 就保留该记录成本口径：缺失费用绝不用今天的价目表补齐。`api_estimated_cost` / `api_estimated_cost_known` 另行暴露当前 API 等价估算。若不存在记录成本，旧的 `estimated_cost` 字段使用该估算。`provider` 与 harness `model_rates` 是不同的来源依据，二者都不承诺是完整账单。
- 会话级 `account_scoped` 仅在来源明确记录账号范围时出现且为 `true`；缺失表示登录方式未知，不编码为 API Key 或 `false`。Codex 原生 `session_meta.creator_account_id` 与归档 `session.auth` 事件只保留这一布尔含义，不保存原始账号 ID；同一会话有多份 rollout 时只采用被选中修订的证据。模型 `codex-auto-review` 且 `account_scoped` 为 `true`、轮次 `started_at >= 2026-10-06T00:00:00Z` 时，费用按免费规则返回 `estimated_cost=0`、`cost_basis='free'`、`cost_source='free_waiver'` 且无分类明细；其他情况仍保持未知。`creator_account_id` 也会用于 Codex Agent 身份 / PAT，日志无法区分登录方式，因此该信号不等于已确认的 ChatGPT 登录。
- 轮次（有观测时）、会话、汇总、模型 / 日期分组与详情会话上的 `request_coverage` 带有 `scope=observed_usage_records`，统计有 / 无用量、有 / 无成本的观测记录数以及逐字段存在情况。当前所有输入的 `total_requests`、`usage_ratio`、`cost_ratio` 均为 **null**。不要把 assistant 消息数、Token 快照或 `cost_samples / turns` 当作请求覆盖。`unresolved_turns` 包含缺失或被隔离的观测；`attribution_uncertain_turns` 标记可能重叠的分叉观测。
- 分叉时间未知会导致成本不完整并阻断去重聚合，只保留带标注的观测小计。看板会把这些与已知可归属合计区分开，并始终把实际请求覆盖标为未知。

### 既有归档与升级

pi / dsh 用量 metadata 是 v1 字段扩展，**不**兼容旧的严格消费方。产出前需先升级 Stats、Journal 与 Knowledge；旧消费方会拒绝该页且不推进游标。非法 metadata 仍会回滚整页与游标。

新版 Stats 接受旧 v1 事件，但缺少新 metadata 的旧 / 混合 pi / dsh 记录（或已结算 assistant 缺少对应新快照）会被隔离：其完整合计与 API 估算保持未知，只保留可用的观测小计。读取旧的 Stats 投影会应用相同限制，但不改写已存储数据库；丢失的字段存在性无法从旧合成计数器恢复。

如需历史恢复，应基于已授权的来源显式创建**新的 Trace 归档与新的消费方数据库**。仅重新导入同一来源不会升级旧的规范化行：Trace 未变的 `record_hash` 快速路径会跳过它们。该能力不执行自动迁移、来源重绑定、生产数据重采或变更流修订修复。参见 [Trace 协议文档](../../agent-trace/docs/protocol.md)。

## Python provider API

```python
from agent_stats.core import Store
from agent_stats.sources import NormalizedSession, import_source

class MyProvider:
    source = "my-agent"
    instance = "laptop"

    def sessions(self) -> list[NormalizedSession]:
        return [{"id": "s1", "turns": [{"id": "t1", "token_total": 42}]}]


store = Store("./stats.sqlite3")
report = import_source(store, MyProvider())
print(report, store.query()["summary"])
```

`SourceProvider` 是结构化类型协议；`NormalizedSession` 与 `NormalizedTurn` 描述输入记录。也可以调用 `import_sessions(store, source, instance, sessions)` 传入可迭代对象，或用 `import_document(store, document)` 传入 JSON 对象。三者使用同一套校验，返回 `scanned`、`imported` 与 `skipped`。非法数据抛出 `ValueError`；provider 迭代错误会在任何导入写入之前抛出。调用方拥有 Store 连接与事务：savepoint 会加入已有事务，因此调用方必须提交或回滚。
