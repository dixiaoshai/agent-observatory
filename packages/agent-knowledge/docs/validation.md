# 第一阶段验证记录

日期：2026-11-08，Asia/Shanghai。验证仅使用项目内或临时目录中的合成数据。

## 环境与依赖

- Node.js：v24.15.0，内置 SQLite 3.51.3。
- TypeScript：7.0.2；MCP SDK：1.32.2；Zod：4.6.7；ignore：7.0.14。
- 版本以 `package-lock.json` 为准；SDK API 已核对安装包与上游 v1.x 文档。无外部模型或向量服务。

## 自动化验收

运行 `npm run check`，严格类型检查、31 项 Node 测试与编译全部通过。另以编译后的 `dist/interfaces/cli.js` 导入 10 个样例，通过 SDK Client 实际连接 STDIO，搜索和读取均成功；本地回执保存在 `.knowrelay/acceptance/stdio.json`（可重新生成的演示数据，不入版本控制）。测试覆盖：

| 验收 | 证据 |
| --- | --- |
| 中文与代码检索 | `tests/application.test.ts` 将 10 个样例导入 SQLite 后逐题搜索、读取并核对原文行号；10/10 正确来源在前 5 条。标注答案 JSON 不参与索引 |
| 无词法答案 | 合成无匹配问题返回空结果；不生成来源或模型摘要 |
| 版本与增量 | 未变化文件保持原版本，更新后旧记录不可读取，删除后退出检索；未同步时也停止返回失效内容 |
| 范围控制 | 不同项目、owner 和未配置来源均不能通过搜索或已知 ID 读取；参数不能扩大范围 |
| 目录边界 | 嵌套忽略规则、凭据、依赖产物、UTF-8、文件大小、符号链接和扫描失败；受控目录替换为根外链接时整次扫描中止 |
| 可靠性 | 幂等重放、键冲突、事务回滚、条件版本、并发删除后旧扫描不能恢复数据 |
| 清理与恢复 | 删除原文快照、记录、派生索引和回执；保留元数据删除标记；索引重建、重新打开数据库后可用 |
| MCP | SDK Client 通过真实 STDIO 子进程连接 CLI；验证两个只读工具、搜索/读取、越界参数和源更新 |
| CLI/配置 | 参数校验、相对路径定位、未知配置项、重复来源 ID |
| 客户端验收脚本 | 随机知识/技能探针隔离、伪造技能声明与来源拒绝、相关删除查询、结构化无工具拒答、宿主版本门槛、输出上限、超时及中断进程组清理 |

存储契约测试入口为 `tests/storage-contract.ts`，可用于新增后端。此阶段尚无事件、任务领取和租约，因此没有声称完整存储契约已通过。

独立只读审查发现了扫描期间单次目录替换可能越界的问题；已增加祖先目录身份、规范路径和文件打开前后身份复核，并通过受控替换回归测试。修复经独立复核通过，未发现其他实质问题；完整恶意竞态隔离仍受运行指南中的本机边界限制。

## Codex 新会话合成验收

PATH 中的 `codex --version` 返回 `spawn …/codex-darwin-x64/…/codex ENOENT`。进一步找到 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`，版本 `0.166.0-alpha.6`，可以启动。

首轮使用内置 CLI 遇到 `workspace routing discovery timed out`。第二轮补全临时进程代理变量并关闭无关 Apps/插件连接后，真实新会话恢复。未修改宿主配置、用户技能目录或认证信息。

客户端版本为 `codex-cli 0.166.0-alpha.6`。新脚本 `scripts/verify-codex.mjs` 在每轮生成随机知识和独立数据库，答案不进入问题；skill 仅安装在隔离工作目录。其副本正文追加独立随机探针，描述不变，用于识别是否加载正文，而非只听信助手声明。会话均使用 `exec --ephemeral --ignore-user-config --sandbox read-only`。

| 场景 | 实际结果 | 本地证据 |
| --- | --- | --- |
| 显式 `$knowrelay` | 通过；检索前输出技能正文探针，随后真实搜索/读取，答案、行号、版本和完整哈希相符 | `.knowrelay/acceptance/host-20261108-2/summary.json` 及 `explicit.stdout.jsonl` |
| 自动选择 | 未观察到技能探针，状态 `inconclusive`；MCP 搜索/读取和引用均成功，不能据此宣称启用了技能 | 同目录 `automatic.stdout.jsonl` |
| 更新前新会话 | 通过，引用原始内容和源版本 | `.knowrelay/acceptance/lifecycle-20261108-1/summary.json` |
| 更新后新会话 | 通过，引用新随机内容、新哈希和不同源版本 | 同目录 `lifecycle-updated.stdout.jsonl` |
| 删除后新会话 | 通过，对原问题搜索为空，明确无法确认，不返回旧来源 | 同目录 `lifecycle-deleted.stdout.jsonl` |
| 未连接知识工具 | 通过，观察到技能探针，未调用 KnowRelay，并按要求返回无答案/无来源的结构化拒答 | `.knowrelay/acceptance/unavailable-20261108-2/summary.json` 及 `unavailable.stdout.jsonl` |

`host-20261108-2` 的整体状态仍为 `inconclusive`，没有将自动选择未触发改写为成功；文件生命周期和无工具用例分别独立通过。原始调用、错误输出、最终回答和摘要均以本地私有文件保存，未进入版本控制。复测入口见 [运行指南](running.md)。

对验收脚本的独立审查发现并修复了空读技能误判、无关空查询掩盖旧来源、缺少宿主版本仍可通过，以及无工具时其他格式假来源可绕过检查的问题；修复经过定向回归和独立复核。未用模拟 trace 充当真实客户端验收。

## 尚待验证的范围

统一命名后另执行 `npm run check`，40 项测试、类型检查和构建通过，含配置新名优先/旧名回退、旧类导出别名、真实 stdio MCP 及验收脚本模拟回归。两个 skill 格式校验通过，跨项目消费也已在新目录下通过。该回归不等于重新运行真实 Codex 宿主验收；历史宿主记录继续使用原名称描述。

2026-11-14 新增共享归档证据验证：`npm run check` 的 38 项测试、类型检查和构建通过；包含真实归档 CLI → KnowRelay CLI → stdio MCP 的合成端到端、原来源删除后读取、项目范围拒绝和墓碑删除。三项目独立分页/重复消费/统计隔离另由 agent-trace 的 `npm run verify:consumers` 验证通过。独立审查发现的删除事件身份校验缺口已修复并经定向复核。详情见 [共享归档验证记录](../../agent-trace/docs/validation.md)。没有把合成结果表述为真实历史日志兼容性验收。

2026-11-14 正文归档兼容：`npm run check` 42 项测试、类型检查和构建通过。新增覆盖 content 模式下大字符串外置的 `content_ref`：导入时校验绝对路径、字节数、SHA-256 与媒体类型，要求 `body` 与 `raw` 引用一致，拒绝相对路径、错误哈希与正文/原始记录不一致；检索仍按项目范围，`archive-read`/MCP 原样返回引用而不读取任意路径。另用合成 70 KB 工具输出跑通 Trace `ingest`/`export` → Knowledge `archive-import`/`archive-search`/`archive-read`：`content_ref` 可检索并按项目读取，引用元数据（字节数、SHA-256）原样保留。未接入真实 Trace content 归档或外置 blob 的实际读取。

用户本轮选择暂不导入真实资料。尚未全局安装服务/skill、导入真实试点目录、读取历史聊天或连接提取模型。自动选择仍需更多代表性任务观察；合成结果不能代表真实语料准确率。

## 自动拉取 worker（follow，2026-11-14）

实际执行（临时数据库、回环地址、合成 Trace API；未读取真实日志、未连接真实 Trace 或启用常驻同步）：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Agent Knowledge | `npm run check` | 类型检查、**57 项测试**、构建通过 |
| follow 示例配置 | `loadFollowConfig('agent-knowledge.follow.example.json')` | 通过；指向示例知识配置，`content` 视图固定，默认 200/15/20/300 |

新增 `tests/follow.test.ts` 覆盖：

- 严格配置：回环 `http` + 显式端口、拒绝路径/查询/凭据/非回环、`token_env` 命名、未知字段（含 `view`/`database`）、相对路径解析、数值边界与默认值；token 只从环境变量读取，缺失/空白报 `TOKEN_MISSING`。
- 正常链路：`/v1/status` 探针绑定 `archive_id`，按 `page_size` 分页取 content 页，`follow.page` 只在本地提交后输出，证据可检索；重启 worker 从已提交游标继续，重复页幂等。
- 非法页不推进游标且为永久错误：错误视图、错误起始游标、不前进、回退游标、事件过多、乱序/越界事件、未知信封字段、`archive_id` 变化；metadata 归档报 `VIEW_UNAVAILABLE`，`page_size` 超服务端上限报 `PAGE_TOO_LARGE`。
- 故障分类：503 + `Retry-After`、超时、连接拒绝为 transient；401/403 为 permanent；重试成功后游标才前进。
- 租约与身份：第二个 worker 报 `FOLLOW_LOCKED`，释放后可接管；同机死亡进程的租约可立即接管；`trace_url` 变化报 `TRACE_CHANGED`。
- 授权与回滚（2026-11-14 行为；2026-11-15 起改为消费过滤，见下节）：未授权项目的整页以 `FORBIDDEN` 永久拒绝，重复/冲突事件身份导致本地事务回滚，游标均停在原值。
- 退避重试：`run()` 遇到 500 时输出 transient `follow.error` 和 `retry_in_seconds`，退避后自动追平；追平后由信号停止，退出码 0。
- 删除与序列：墓碑清除证据，已提交旧页重试为幂等重放且不复活；同一会话的后续事件被拒绝；序列空洞合法。
- 并发：worker 连续提交页时，另一连接持续检索证据库不报锁错误。
- `run()` 退出码：永久错误输出 `follow.error`/`follow.stopped` 并返回 2；信号停止返回 0 且释放租约；CLI `follow` 收到 SIGTERM 后正常停止，缺失 token 退出 1。
- `validatePage` 直接回归信封与事件顺序规则。

明确未验证：

- 未与真实 `agent-trace serve`、真实 Codex/pi content 归档联调；未测试 Stats/Knowledge 同时运行、Trace 重启或网络中断后的端到端补取。
- 未实现目标库重建的交互式流程；当前要求显式删除/移动目标库并重新从 0 回放。
- 未做长时间运行、blob GC/保留期、MCP 客户端压力测试或 reviewer 独立审查。

## 项目范围改为消费过滤（2026-11-15）

背景：Trace 即将支持全量采集，content 页面会出现 Knowledge 未配置的新 `project_id`（例如兜底的 `unscoped`）。`allowed_project_ids` 从“整页授权门槛”改为“消费范围过滤”：名单外事件在导入时跳过，游标照常提交，不能因项目不匹配而停摆；显式查询名单外项目的 `FORBIDDEN` 语义保持不变。

实际执行（内存/临时文件证据库、合成页面；未连接真实 Trace，未读取真实日志）：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Agent Knowledge | `npm run check` | 类型检查、**58 项测试**、构建通过（`dist` 重建） |

新增/更新覆盖：

- `tests/archive.test.ts` 混合项目页：同一页含名单内事件、名单外事件和名单外 `session.deleted` → 不抛 `FORBIDDEN`，只落库名单内事件（直接查询证据表确认），墓碑表为空，游标提交前进；整页重放为 `replayed` 且不重复导入；只含名单外事件的页同样提交并推进游标；被跳过事件的 `event_id` 之后在名单内复用时不会被判为重复；显式 `search`/`read` 名单外项目仍抛 `FORBIDDEN`。
- `tests/follow.test.ts`：worker 拉取名单外项目页成功提交并前进游标且不产生 `follow.error`；随后重复事件身份仍以 `INVALID_PAGE` 永久错误回滚、游标保持。
- 未改读取侧拒绝语义：`scope()`、CLI `--project`、MCP `project_id` 对显式查询名单外项目仍为 `FORBIDDEN`（新增断言覆盖）。

明确未验证：

- 未与真实 Trace 全量采集（含 `unscoped` 项目）联调；未测试范围变更后的现场数据迁移、超长 backlog 或跨版本页面。
- 扩缩消费范围按“不迁移既有数据”约定执行：缩小时不清理已导入证据，扩大时不回填已跳过的历史；未提供回填或重建工具。
