# Codex 接入能力与边界

接入核实日期：2026-11-02。适配器版本：1。只读 Codex 本机 rollout JSONL；它是版本相关的本地格式，不能当作稳定公开 API。

## 来源依据

官方[非交互运行说明](https://learn.chatgpt.com/docs/non-interactive-mode)确认 Codex 存在落盘 rollout，以及 `codex exec --json` 事件流。本项目首版读取已有 rollout，**未实现 exec 标准输出流采集**；二者格式不能混为一谈。字段支持依据本机样本的元数据结构及项目合成夹具验证，不由官方说明推断。

本机 `~/.codex/sessions`、`~/.codex/archived_sessions` 均存在。当前 shell 的 `codex --version` 包装器缺失其目标可执行文件，无法核实 CLI 二进制版本；这不影响只读解析日志。未修改安装或用户配置。后续遇到不同版本需重新核实，并补充合成回归。

实际核实范围：mtime 最新两份日志共 530 行，日志自报 `cli_version=0.166.0-alpha.5.1`，未见损坏行。只输出白名单字段结构，不复制正文或真实身份。观察到 `turn_context.turn_id/root_turn_id/model`，以及 `token_count.info.last_token_usage/total_token_usage`。另有 `token_usage_record`、`world_state` 等事件，本版不能仅因字段存在就声称已接入。两份样本未见完整 task_started/task_complete 生命周期，因此耗时与状态必须保留未知情况。

## 能力声明

| 领域 | 适配策略 | 降级与限制 |
| --- | --- | --- |
| 会话身份 | `session_meta.id`，加 source/instance 命名空间 | 无身份的文件报告采集问题；不同 instance 不合并 |
| 会话名称 | 来源所属 Codex 目录的 `state_*.sqlite` 中 `threads.name`，回退 `session_index.jsonl.thread_name` | 刷新采集同步重命名；无名称时显示未命名或子代理会话并单列原生 ID；不读取 `threads.title` 或 `first_user_message` 生成名称 |
| 轮次 | `turn_context.turn_id` 与任务生命周期 | 无可靠身份保留推断/未归属标记，不伪装成原生轮次 |
| 事件时间 | 源 timestamp 规范化为 UTC；另记采集时间 | 窗口按轮次开始时间，半开区间；页面说明时区 |
| 用量 | `event_msg` 内 `token_count.info.total_token_usage` 累计差分；分叉时扣除可确认的继承基线 | 不把每个累计值相加；不从快照数推算模型请求数；缺失、重置或分叉基线无法确认时保留未知并报告覆盖限制 |
| 分类 | 输入、缓存输入/写入、输出、推理输出分别保留 | 样本中总计等于输入+输出，缓存/推理数值不超过相应主类；这是观察结果而非公开契约。合计不再叠加分类；缓存写入不作计费解释 |
| 缓存统计 | `cached_input_tokens` 与 `input_tokens` 成对聚合，展示缓存读取、未缓存输入及占输入比例 | 只用两者均为非负整数且缓存不大于输入的轮次，附配对覆盖；零输入时比例未知。缓存写入按来源字段单独统计，不混入读取比例 |
| 模型 | 轮次上下文明确提供的模型 | 未知保留未知；会话跨模型时不能用最后模型给全部历史定价 |
| 工具 | `response_item` 调用及结果，以 call_id 关联 | 只存名称、身份、字节规模与来源定位；缺少显式成功/失败状态时保持未知；不解析命令输出猜测成功 |
| 子任务 | 有明确来源父身份时保留关系；依据本机样本按各会话新增用量合计 | 日志格式和计量行为依版本而异，样本观察不是公开契约；旧记录缺少计量标记时父子同现须刷新采集，否则展示未去重观测小计 |
| 费用 | API 标准价等价估算 | 按当前已核实模型的 Standard 短上下文美元单价计算，展示覆盖与部分小计；实际账单未知，未知单价不补零 |
| 请求数 | 不支持 | 消息数、Token 快照数、工具数均不等于模型请求数 |
| 上下文/节省量 | 不支持精确测量 | 不能把累计输入当作上下文长度，也不把工具字节换算 Token 或费用 |
| 隐私 | 默认元数据模式 | 保存最多 80 字符的 Prompt 轮次摘要；不保存完整 prompt、思考、命令、参数、结果正文；摘要、路径和身份仍可能敏感 |

## 数据可靠性

SQLite 保存规范化会话事实，按稳定来源身份替换/合并导入；重复采集不追加用量。活动/归档副本使用同一 instance 去重。损坏行、无法解析的尾行、来源读取失败必须返回采集警告；未知指标保持未知。日志迟到后再次刷新会重建受影响的事实，查询不缓存旧聚合。

2026-11-08 补充核实：本机出现 `event_msg/token_count` 的 `info: null` 与非空 `rate_limits` 并存事件。这类限额更新不提供用量，不计为缺失累计快照；非空但无有效累计值的 `info` 仍报告覆盖提醒。`observed_token_total` / `observed_token_known` 保留观测小计；仅在计量关系未确认时标注可能重复。

无法验证精确模型请求、逐请求费用、缓存写入及完整工具错误率；这些均为明确缺口。父子计量基于本机版本样本核实，并非适用于所有版本的公开契约。诊断仅作有数据支持的线索，不把高消耗判断为浪费。本版按用户要求不实现优化比对。

2026-11-08 会话名称补充：对照本机 Codex 列表与状态库的同身份记录，23/23 条应用显示名称与 `threads.name` 一致；`threads.title` 仅 1/23 一致，且部分值直接等于首条提示词，故不读取该列。名称只从 rollout 所属本地目录读取，SQLite 使用只读连接，保留 WAL 中已提交的重命名；状态库缺失或版本不兼容时回退 JSONL 名称索引。名称作为用户要求的显示元数据保存在本机统计库，不采集提示词正文。当前检查到的线程状态库只有 Token 用量，没有可核验的逐会话账单金额，实际费用继续保持未知。

2026-11-08 依用户要求启用估算：费率来自 [OpenAI 官方价格表](https://developers.openai.com/api/docs/pricing?latest-pricing-expanded=true)，以 `agent_stats/pricing.py` 中的核对日期与模型白名单为准，在查询时动态计算。公式为 `(输入−缓存输入)×输入价 + 缓存输入×缓存价 + 输出×输出价`，费率按美元/百万 Token 换算。推理已包含在输出，不重复计费。未记录缓存写入时假设无单独计费写入；写入为正但无 TTL 时不估算（[缓存计价说明](https://developers.openai.com/api/docs/guides/prompt-caching)）。当前估算未还原逐请求长上下文、服务等级、工具附加费或历史费率。`codex-auto-review` 无匹配公开单价，不套其他模型。`estimated_cost` 为覆盖完整时的估算合计，`estimated_cost_known` 为已知小计；计量关系未确认时只显示 `observed_estimated_cost_known` 未去重观测估算。实际账单字段 `cost` 仍为 null。

2026-11-08 轮次名称补充：按用户要求从该轮可读用户 prompt 或子代理 NEW_TASK 的明文 Payload 生成最多 80 字符的单行显示摘要，剔除 AGENTS、环境和开页注入上下文，仅保存短摘要。加密或不可读内容不尝试解密，以“第 N 轮 · 无可读 Prompt”回退。会话 ID 与轮次 ID 不变，在列表和详情分别标注；历史轮次在刷新采集后更新。

2026-11-08 缓存统计补充：Overview、会话、模型分组、每日趋势与详情中的 `cache_usage` 均按相同筛选后的轮次聚合。`cached_input_known`、`input_known`、`uncached_input_known` 取同一批有效输入/缓存配对样本；`hit_rate = sum(cached_input_tokens) / sum(input_tokens)` 是 Token 比例，非请求命中率，也不是各轮百分比的算术平均。`samples/turns` 表示配对覆盖，`complete` 表示当前范围是否全覆盖；无有效样本的小计为 null，有明确零值时保留 0，零分母比例为 null。缓存读取已属于输入，不加入总 Token；写入来源值通过 `cache_write_known/cache_write_samples` 单列。只有计量关系未确认时，`aggregation_blocked` 才为 true，缓存聚合作为未去重观测小计。

2026-11-08 父子与分叉补充核实：本机 18 个子代理的首个累计用量均等于该代理首次调用用量；9 个对应父会话的 553 次累计变化均等于父会话当次用量。另有 3 个分叉的首个累计值减去当次用量，与原会话历史快照完全一致。[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)说明分叉会复制历史；上述累计用量关系是本机样本观察，不代表所有版本的稳定契约。已核实版本为 `0.166.0-alpha.5.1`、`0.166.0-alpha.6`；其他版本需累计差分与 `last_token_usage` 一致的证据，存在矛盾时不确认独立计量。新解析记录按会话自身新增用量合计，分叉首个快照以有效 `last_token_usage` 扣除继承基线，排除创建时间前的复制事件；基线缺失、无效或时间无法区分历史时保留未知并提醒。累计快照重置后不跨计数周期猜测增量。历史导入缺少计量标记时须刷新采集（旧记录可能未保留分叉身份）；已标记但父子计量仍未确认时继续保守阻断。
