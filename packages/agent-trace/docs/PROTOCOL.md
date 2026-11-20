# 共享 Agent 归档协议 v1

本协议描述 Agent Trace 与各消费方之间的批次契约。Trace 不安装宿主 hook，只读取 Codex、pi 与 DeepSeek Harness（`dsh`）已经写入的会话文件。dsh 日志是拼接的 Zstandard 帧，解析前会解码为逻辑 JSONL。

## 所有权与传输

归档拥有捕获的源证据与归一化事件；消费方拥有自己的派生结果与游标，不写归档的 SQLite 表。消费方共享本契约而不是代码；仓库源码中的 [协议一致性样本](../fixtures/protocol/README.md)用于验证不同实现。

第一种传输是 CLI 导出的 JSON 批次文件，使 Python 与 TypeScript 消费方能共享版本化契约而不共享内部数据库模式。第二种传输是只读的本机 HTTP 事件流，由各消费方独立拉取；端点、认证、视图和错误契约固定在[本机 API 文档](LOCAL-API.md)，服务端由 `agent-trace serve` 实现。Stats、Knowledge 与 Journal 的同步逻辑均已实现，Trace 不保存目标清单、投递队列或消费方确认状态。

归档要求显式提供来源路径、实例 ID 和项目 ID，不会自动发现或导入用户历史。数据库的捕获模式在创建时固定：默认 `metadata`，只有显式选择时才为 `content`。metadata 包含有长度上限的请求标题和路径，仍属私密信息。content 捕获包含请求、回答、可见推理摘要、计划和工具参数 / 结果。入库前，常见凭据形态和敏感命名的 JSON 字段会被替换为显式 `[REDACTED:<类别>]` 标记，超大字符串外置为可核验的本地引用（见[正文归档](CONTENT-CAPTURE.md)）。脱敏是启发式的：它不能恢复隐藏 / 加密推理，也不能证明自由散文或私有格式中没有密钥；选择来源时应考虑这一点。归档过程不发起外部网络调用或模型调用。

## 批次信封

```json
{
  "schema_version": 1,
  "archive_id": "persistent-uuid",
  "view": "metadata",
  "after_cursor": 0,
  "next_cursor": 12,
  "has_more": false,
  "events": []
}
```

游标值是非负安全整数，表示全局归档序列中的不透明位置。事件按 `archive_seq` 排序，而不是按时间戳。消费方从零开始，把自己的派生写入与游标一起提交，并在下一次导出时提供自己的游标。空页可以跨过已删除事件继续前进。两种视图共享同一游标空间。消费方按 `archive_id` 分别保存状态，不能在同一份状态中切换视图，除非重新完整重建。每次导出的上界在该次读取时确定；更晚的事件在后续读取中获得。`next_cursor` 是本次扫描到的最后位置（尾部为空时为 `after_cursor`）。

消费方拒绝不支持的版本、向前跳过的游标、非法信封和冲突的事件 ID。此前已接受的完整页面可以重试并按无操作处理；超出已提交游标的重叠页会被拒绝，应从当前游标重新导出。消费方仍须把未知事件类型当作已存证据处理，或跳过而不丢失游标进度。

## 事件信封

```json
{
  "schema_version": 1,
  "event_id": "sha256-hex",
  "archive_seq": 1,
  "runtime": "codex",
  "instance_id": "workstation-a",
  "session_id": "native-session-id",
  "session_key": "[\"codex\",\"workstation-a\",\"native-session-id\"]",
  "project_id": "demo",
  "kind": "message.user",
  "occurred_at": "2026-01-01T00:00:00Z",
  "observed_at": "2026-01-01T00:00:01Z",
  "native_type": "event_msg.user_message",
  "source": {"path": "/selected/log.jsonl", "line": 3, "record_hash": "sha256-hex"},
  "data": {"turn_id": "turn-1", "root_turn_id": null, "model": null, "title": "User request"},
  "body": null,
  "raw": null
}
```

在 metadata 视图中，`body` 和 `raw` **始终**为 null，`data` 只包含白名单负载。content 视图只在捕获过内容时提供它们；未捕获的内容保持 null。在 content 模式下，`body` 和 `raw` 是**脱敏与外置之后**的解析记录；`source.record_hash` 仍标识原始行字节（不含 LF，CRLF 时也不含 CR），因此它声明来源，而不是脱敏副本的哈希。`body` 是便于读取的表示，从来不是权威的完整源记录。消费方用 `event_id` 引用证据。`occurred_at` 在缺失或非法时为 null；导入顺序仍然可用。`runtime` 标识宿主，与模型提供方和模型名分开。

对 Codex v1 适配器，`event_id = SHA256(JSON.stringify([runtime, instance_id, session_id, one_based_line_number]))`。复制 / 移动保持身份。两**不同**行上的相同内容不会去重。可用时保留原生 ID 与解析器版本；未来的适配器可以使用原生 ID 代替序号位置。事件身份不得依赖归一化版本。未知记录保持为 `source.unknown`，在捕获时保留原始原生类型和原始负载。

一个会话身份可能由多个 rollout 文件覆盖，Codex 也可能原地重写某个 rollout。归档对每个会话只保留一个 revision：取最后事件时间最大的文件，再取记录数最多的文件。更新的 revision 替换旧 revision；相同 revision 原地协调（同一路径中变化的记录被替换，未变化的记录保留 `event_id` 与序列位置；从另一路径读到有变化的获胜 revision 时整体替换，使会话头与用量保持同一来源，相同副本仍不重复导入）；更旧的 revision 直接跳过而不回滚。已有会话的项目变更仍以 `SOURCE_CONFLICT` 失败。旧版分页只返回当前还存在的普通事件，不传播 revision 移除；需要同步这些变化的客户端必须显式协商下述扩展。

当 `/v1/status` 的 `protocol.event_removals` 为 `true` 时，客户端可以对 `/v1/events` 请求 `revisions=1`。响应额外包含 `removed_events` 数组（无移除时为空），条目只有 `archive_seq`（变更序号）和 `removed_seq`（此前分配的旧事件序号）。两数组各自按 `archive_seq` 升序，条目共享同一游标和分页上限。移除与替换在归档事务内提交，移除标记的序号先于替换事件；消费方按序删除自己已持久化的旧事件并重建受影响投影，每页与游标原子提交；修订跨页时，投影在追平前可能暂不完整。若旧序号不在消费方库中（例如全量回放、项目过滤），移除是空操作。标记不保存旧事件的内容或身份；整会话删除仍通过 `session.deleted` 传播。未请求 `revisions=1` 时，响应不带此数组。

升级不会为旧归档中已经发生的重写补造移除标记；从旧版分页切换到此扩展的消费方需要以当前归档从游标 0 回放到新投影，再继续增量消费。

一个 Codex rollout 可能包含多条 `session_meta`：恢复会话会追加新身份，子代理 rollout 会在自身身份之后重复父身份。最后一条记录是权威记录；整个文件按该 `session_id` 和项目归档，更早的身份标记不会发出。这与直接日志读取器的归属一致，也把 token 保留在一个会话中。会话 `title` 是从来源 `session_index.jsonl` / 最新的可读 `state_*.sqlite` 读取的可选显示元数据；它从不改变事件身份、隐私保证或游标语义。

合并到同一会话的两个 rollout 会复用行号却承载不同记录，因此这类文件把自身的首个 `session_meta` 身份加入标识元组：`[runtime, instance_id, session_id, first_session_id, line]`，并作为可选的 `source.series` 携带。只有单一身份的日志继续使用已发布的四元组，因此现有标识永不改变。该区分项在文件内部稳定，并随复制 / 移动的证据一起传播；相同位置的相同内容仍会去重。重算标识的消费方必须在 `source.series` 存在时包含它，并拒绝空或与会话相同的 series。

## 归一化类型与白名单 data

<a name="normalized-kinds-and-allowlisted-data"></a>

所有普通事件都包含可为空的 `turn_id`、`root_turn_id` 和 `model`。

| 事件类型（kind） | 附加 metadata 字段 | 内容正文 |
|---|---|---|
| `session.started` | `cwd`、`parent_session_id`、`forked_from_session_id`、`created_at`、`cli_version`、可选 `title`（单行，最多 80 字符，从来源旁读取） | null |
| `session.title` | `title`（单行，最多 80 字符） | null |
| `turn.context` | 无附加字段 | null |
| `turn.started` | 无附加字段 | null |
| `turn.completed` | 无附加字段 | 可选最终回答文本（Codex `task_complete.last_agent_message`；pi 以 `message.assistant` 暴露终止回答） |
| `turn.interrupted` | 无附加字段 | null |
| `message.user` | `title`（单行，最多 80 字符） | `text` |
| `message.assistant` | 无附加字段 | `text` |
| `reasoning.summary` | `available` 布尔值 | 可见时为 `text` |
| `tool.called` | `call_id`、`name`、`input_bytes` | `arguments`（原生结构化值或字符串） |
| `tool.returned` | `call_id`、`output_bytes`、`status: result_observed` | `output` |
| `usage.snapshot` | `cumulative`、`last_usage`、`rate_limit_only`、可选 `usage_basis`、`request_id`、`request_id_source`、`cost_usd`（非负数）和 `cost_source`（`provider` 或 `model_rates`） | null |
| `context.compacted` | 无附加字段 | 可选摘要 |
| `source.unknown` | 无附加字段 | null；原文在 `raw` 中 |
| `session.deleted` | 无附加字段 | null |

`session.started.title` 是首次观测快照。宿主可能在会话开始后修订显示名；每个可用的修订是一条独立的 `session.title` 事件（最新者生效）。展示会话名的消费方必须优先使用最新的非空 `session.title`，并把缺失 / 空修订视为未知，而不是抹掉已知名称。该 kind 从不携带正文，也不改变会话身份、父子关系或统计。该 kind 是对 v1 的扩展：严格消费方必须先升级；旧消费方会失败关闭，而不是追加证据。

content 模式的正文可以用 `content_ref` 对象代替超过 Trace 内联上限的字符串：

```json
{"content_ref": {"path": "/private/blobs/<event>-<sha256>.txt", "bytes": 4133,
                 "sha256": "<64-hex>", "media_type": "text/plain"}}
```

`content_ref` 是保留键。文件保存完整的脱敏字符串（不截断）；读取者验证绝对路径位于预期目录内、`bytes` 和 `sha256` 一致，然后按 UTF-8 读取文本。`body` 与 `raw` 应用相同的替换。metadata 标题会被脱敏，但限制在 80 字符内。

用量对象**只**允许非负整数 `input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`、`reasoning_output_tokens`、`total_tokens`。缺失字段表示未知，**不是**零。输入可能包含缓存输入；输出可能包含推理输出；绝不要把所有字段相加。`usage.snapshot` 通常携带累计计量，而不是一次可计费新请求的证明。`cost_usd` 是 `last_usage` 所描述同一请求的记录成本（不是累计快照的成本）。`cost_source=provider` 表示提供方报告了费用；`model_rates` 表示宿主按其自己的模型费率表计算。消费方不得把两者呈现为账户账单；缺失字段表示未知，**不是**零。消费方保留累计重置 / 缺失证据和 fork 继承警告。

pi 与 dsh 快照额外带 `usage_basis: "request"`，表示 `last_usage` 是一次观测到的逐调用事实，而不是原生累计读数。`request_id` 是非空字符串或 null；`request_id_source` 为 `pi_entry`、`dsh_record` 或 `source_record`。这三个字段必须同时存在或同时缺失；只有 pi / dsh 允许该扩展。ID 必须等于其 ECMAScript `String.trim()` 结果，排除 C0 / DEL 控制字符，且最多 4096 个 UTF-16 代码单元。特别地，U+0085 不是 trim 空白，但 U+FEFF 是；Python 消费方不得改用 Python 默认的 `strip()` 定义。`pi_entry` 用原生 entry id 标识 pi assistant entry；`source_record` 标识其他 pi 记录或没有可用 id 的 assistant（null）。只有 `source_record` 的身份可以为 null。`dsh_record` 通过 `seq-<seq>` 或 `line-<line>` 标识日志记录，它不是原生提供方请求 ID。这些是观测身份，不是所有请求都被记录的证明。两个运行时的总请求数与请求覆盖率都保持未知。每条已结算的 assistant 记录都会发出快照，即使用量与成本缺失；压缩 / 摘要记录只在存在用量时发出。显式零仍是零。包含缓存的输入需要同时提供输入和缓存读取；显式 total 优先，否则 total 需要完整的输入与输出。保留 `cumulative` 仅为兼容，不得用它填充缺失的请求字段。对完整观测记录求出的总计具有“观测记录”范围，不是完整请求覆盖或实际账户账单。

这些字段扩展了 v1，且**不**兼容旧的严格消费方：先升级消费方。旧消费方必须失败关闭且不推进游标。新版 Stats 接受旧归档，但对缺少该元数据、或每条已结算 assistant 记录没有匹配快照的旧 / 混合 pi / dsh 观测进行隔离：完整用量 / 成本与 API 估算保持未知，仅保留可用的观测小计。旧 Stats 投影在读取时同样受限，且不重写数据库。旧的 `last_usage`（可能已经补过零）与合成累计计数器都无法恢复丢失的“是否存在”信息。Trace 按 `record_hash` 跳过未变化的行，因此重新导入相同文件不会升级其归一化数据。因此归档记录产生其事件的投影，并拒绝混合写入；见[投影版本与归档升级](#projection-version-and-archive-upgrades)。该扩展不解决事件修订语义。

工具返回是观测到结果的证据，**不是**任务成功的证据。

原生 `event_msg` 消息和 `response_item.message` 可能描述同一条消息；内容消费方必须容忍镜像记录并引用它们各自不同的来源。统计消费方应优先使用适配器的有界标题和现有的来源感知归因规则，而不是把每种表示都当作新的用户轮次计数。流式分块与已结算消息不得重复计费。

## Pi 适配器映射

pi 会话是由 `id` / `parentId` 连接的 JSONL entry。适配器根据每个用户 entry 的 id 合成 turn id；assistant 终止 stop reason 关闭轮次。它发出 `message.user`、`turn.started`、`message.assistant`、`usage.snapshot`、`tool.called`、`tool.returned`、`turn.completed`、`turn.interrupted`、`context.compacted`、`session.started`，其余一律为 `source.unknown`。

用量映射遵循 v1 约定：输入包含缓存输入：

| Pi 字段 | v1 字段 |
|---|---|
| `usage.input` + `usage.cacheRead` | `input_tokens` |
| `usage.cacheRead` | `cached_input_tokens` |
| `usage.cacheWrite` | `cache_write_input_tokens` |
| `usage.output` | `output_tokens` |
| `usage.reasoning` | `reasoning_output_tokens`（已包含在 output 中，不再相加） |
| `usage.totalTokens` | `total_tokens` |
| `usage.cost.total` | `cost_usd` |
| `usage.cost.totalFromProvider` | `cost_source=provider`，否则 `model_rates` |

`cumulative` 是适配器对本文件中已知字段的运行求和；它无法恢复缺失的逐请求事实。pi `/fork` 与 `/clone` 原样复制 entry；header 保留原 entry 时间戳并在 `parentSession` 中命名来源。适配器把该 id 记录为 `forked_from_session_id`，消费方跳过早于新 header 时间戳的 entry，以免继承历史被重复计费。会话通过 `session_info` 由 `/name`（或 `--name`）命名；未命名会话回退到第一个可读用户提示，与 pi 自己的会话选择器一致。两者都作为 `session.started.data.title` 暴露（单行，最多 80 字符）。

## Dsh 适配器映射

dsh 保存会话 header 加追加式 `SessionEvent` 日志。当前版本在 `~/.dsh/sessions/--<cwd>--/<id>/` 下写入 `session.vN.jsonl.zstd`；该文件是独立 Zstandard 帧的拼接（一个 header 帧，随后每个持久批次一帧）。适配器按顺序解码完整帧，把撕裂的最后一帧标记为 pending，并保留逻辑行号与记录哈希。当前 v4 布局与仍可读取的 v0 日志共享下文使用的字段；流式增量行（`assistant/chunk`、`*-chunks`）、inbox 切片和内部 job 记录保持为 `source.unknown` 证据，且从不额外创建轮次。

| Dsh 事件 | v1 事件类型 |
|---|---|
| `session` header | `session.started`（`created_at` 来自 `createdAt`；`origin` 为 `subagent` 时 `parent_session_id` 来自 `parentSession`，否则 `forked_from_session_id` 来自 `parentSession`） |
| `session/title` | `session.title`（每个可用显示名修订一条事件） |
| `turn/start` / `turn/end` | `turn.started` / `turn.completed` 或 `turn.interrupted` |
| `source.kind=user` 的 `user/message` | `message.user` 加一个有界标题 |
| 其他 `user/message`、`system/message` | `source.unknown` |
| `assistant/message` | `message.assistant` + 可见推理的 `reasoning.summary` + `usage.snapshot` |
| `tool/call` / `tool/result` | `tool.called` / `tool.returned` |
| `compaction/summary` | `context.compacted`（+ 摘要器的 `usage.snapshot`） |
| 其他所有记录 | `source.unknown` |

dsh 会话 header 用可选字段自我分类：`origin` 只可能是 `subagent`；子代理的 `parentSession` 是其直接创建者（`parent_session_id`），不是 fork 来源；普通 fork 省略 `parentSession`，而历史普通 fork 可能在其中保留它（记录为 `forked_from_session_id`）。seeded 会话（`isSeeded: true`）以父日志前缀的逐字副本开始，由一条携带 `inherited: true` 的 `session/end-seed` 记录收尾；到最后一个 marker 为止的记录已存在于父会话下，不会在子会话下再次归一化，因此继承工作（包括标题修订）不会被计两次。

`session/title` 记录是显示名修订：dsh 先记录一个有界提示回退，随后替换为模型生成的名称。每个可用修订变成一条 `session.title` 事件，而 `session.started.title` 保留首次读取源文件时观测到的快照。该 kind 出现前创建的归档会保留旧快照，直到采集器重新读取文件，或 `reingest --config` 协调已导入来源（见[服务配置](SERVICE-CONFIG.md)）；reingest 因未变化行保持事件身份而保持幂等。

turn id 是原生数字 `data.turn` 渲染成的字符串。用量遵循与 pi 相同的 v1 输入约定：

| Dsh TokenUsage 字段 | v1 字段 |
|---|---|
| `inputTokens` + `cacheReadTokens` | `input_tokens` |
| `cacheReadTokens` | `cached_input_tokens` |
| `cacheWriteTokens` | `cache_write_input_tokens` |
| `outputTokens` | `output_tokens` |
| `reasoningTokens` | `reasoning_output_tokens`（已包含在 output 中，不再相加） |
| `totalTokens` | `total_tokens` |

dsh 不在会话日志中记录请求成本，因此 `cost_usd` 与 `cost_source` 缺失而不是零。事件身份是 `SHA256(JSON.stringify([runtime, instance_id, session_id, sequence, kind, identity]))`，其中 `sequence` 是原生行 `seq`（缺失时为 `line-<n>`），`identity` 对 `tool.called` / `tool.returned` 是工具调用 ID，其余为空。来自同一源行的多个归一化事件共享该行，并以 kind 区分。归档不单独保留原生行 `seq`，因此消费方必须校验 64 位十六进制形态并把该值视为不透明；不要试图从 `source.line` 重算它。`session/title` 记录提供显示名修订；没有可用标题记录时，适配器回退到第一个直接用户提示。

## 存储与删除

SQLite 是唯一的初始归档写入者，把正文与归一化事件放在同一事务中存储。只接受完整的 LF 结尾记录；不完整尾部报告为 pending 并在之后重试。dsh 压缩来源在最后一帧撕裂时仍接受完整的 Zstandard 帧。畸形的完整记录会使该文件导入原子失败。文件与解码后大小都有限制。当前重复扫描会重读选定文件；事件去重与消费方导出是增量的，字节偏移 tail 延后。全局 / 会话顺序得到保留；不声明跨独立运行时的全局墙钟顺序。

CLI 和本机 HTTP 都不按项目过滤；HTTP 要求回环 Host / Origin 和带明确视图的 bearer token。需要按项目隔离读取范围时使用独立归档，不要手工删除页内事件而保留全局游标。解析后的 `raw` 值无法复现源行的空白 / 编码，因此 `record_hash` 是归档的来源声明，而不是从批次独立验证的字节哈希。

`delete-session` 删除捕获事件（包括 body / raw）及其引用的任何 blob 文件，并在同一事务中追加 `session.deleted` 墓碑。已删除会话不能被静默重新导入。这是追加式历史中的显式擦除例外。其事件 ID 是 `SHA256(JSON.stringify([runtime, instance_id, session_id, "deleted"]))`，source / body / raw 为 null，data 为空。同一个 marker 不能出现在另一个序列位置；页面重试仍然有效。消费方必须事务性地删除对应证据 / 统计并推进游标。删除前生成的导出、消费方备份、外置 blob 副本和文件系统副本都是独立副本，需要各自清理；这不是安全擦除保证。在归档事务之前写入、随后事务回滚的 blob 是无引用孤儿，可通过目录审计删除。新消费方即使先前事件已被删除，也会看到墓碑。

## 投影版本与归档升级

<a name="projection-version-and-archive-upgrades"></a>

归一化负载依赖运行时适配器，而不只依赖源记录。每个归档在 `normalizer_version` 元数据键中记录产生其事件的投影；该值来自 `src/projection.ts` 中的 `PROJECTION_VERSION`，只要适配器改变归档事件的含义或形态就**必须**提升。`status` 同时报告归档的 `normalizer_version` 与本构建的 `expected_normalizer_version`，`serve.started` 记录归档的值。

两个值不一致时拒绝写入。`importFile`、`delete-session`、`ingest`、`reingest` 和 `serve` 以 `PROJECTION_MISMATCH` 失败；`serve` 会在采集或只读 API 暴露混合归档之前退出。由于未变化的源行按 `record_hash` 去重，该拒绝无法通过重导相同文件绕过；而静默把新版本事件加入旧事件会让消费方无法分辨哪些负载已过期。旧归档的 CLI 读取（`export`、`read`、`status`）仍可用于检视和一次性导出，但 `serve` 不会启动：通过 HTTP 轮询混合归档的消费方会静默把过期投影当成当前数据。

因此升级是一次显式重建：停止写入者，从配置来源创建新归档（新 `archive_id`，完整重新归一化，不对旧数据库去重），把服务指向它，并重建每个消费方数据库。消费方状态绑定 `archive_id` 和会话投影身份；拿旧消费方数据库对接重建后的归档会失败关闭，而不是静默混合版本。`reingest` 仍是同投影修复，只追加新可用的源记录（例如后续 `session.title` 修订）；它不能升级负载，遇到版本不一致会拒绝，而不是假装完成协调。

## 一致性要求

- 合成 Codex、pi 与 dsh 导入、重复导入和移动副本导入不产生重复事件。
- 不完整尾部可继续；畸形记录 / 冲突重写不会部分提交。
- metadata 导出与统计存储中没有正文。
- 两个消费方独立续读，并拒绝跳页 / 冲突 / 不支持的版本。
- 源文件被移除后，原始证据仍可读取。
- 删除被投递，并从两个消费方的投影中清除。
- 既有 Agent Stats 的 Codex 行为与 Agent Knowledge 的知识 / MCP 行为在协议升级后仍保持通过。
