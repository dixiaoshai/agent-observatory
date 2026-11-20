# 验证记录

日期：2026-11-15（请求覆盖）与 2026-11-16（Trace 投影版本守卫）。环境：macOS、Node.js 24.15.0、npm 11.12.1、Python 3.9.6。最新两项工作见下节；随后保留此前迁移与安装器验证记录，不将历史数量视为本轮结果。远端 GitHub Actions 尚未执行。

## 请求级用量与费用覆盖（2026-11-15）

对应[TODO 第一项](../TODO.md#1-请求级用量与费用覆盖stats--trace)。只使用合成源记录、fake 输入和临时数据库；没有读取真实会话、迁移生产库、启动生产服务或调用付费模型。

### 复现与修复

- 用 Git 基线的 `summarize_events` / `estimate_turn` 对比新实现：同轮两个 pi 观测，仅第一个有 $0.02 成本，第二个缺缓存字段。基线输出完整费用 $0.02、完整缓存输入 20；修复后两者完整值均为 null，已知成本小计 $0.02、已知缓存输入 20。
- Trace 为 pi/dsh 保留稀疏 `last_usage`、可验证来源记录身份和 `usage_basis=request`；没有 usage 的 settled assistant 仍产生空观测，cost-only 与明确零值不丢失。含缓存输入仅在 input 与 cacheRead 都存在时生成；不从合成累计值补零。
- Stats 按来源观测而非累计值是否变化处理事实；保留逐字段已知小计和完整性。记录费用缺失不以当前单价补齐；API 等价估算单列。实际请求总数与覆盖始终未知，不用消息数或有费用轮数代替。
- Codex 原生累计差分、回退、fork 基线和自定义输入口径保留。合法 Codex 快照若附部分费用，也只能作为记录费用小计。fork 时间不确定时不输出完整费用，聚合阻断并标注可能重叠的观测小计。
- Journal / Knowledge 同步扩展严格白名单，非法字段组合整页失败且游标不前进。来源 ID 的空白、控制字符、UTF-16 长度边界一致校验；pi 不可用原生 ID 降级为来源记录，不伪造 provider 请求身份。
- 旧或混合 pi/dsh 归档缺少新语义时隔离完整总量及 API 估算；读取旧 Stats 投影只做内存限制，不重写数据库。Trace 不会因重导相同 `record_hash` 自动重算旧事件，历史恢复需显式使用新归档和新消费者库。没有解决或勾选事件修订待办。

### 本轮验证与限制

- `npm run typecheck`、`npm run build`、`npm run test:node` 最终复跑通过：Trace **78**、Journal **70**、Knowledge **61**，均无 skip；`npm run test:tooling` 为 Python **6** + Node **2** 通过。
- `npm run verify:consumers` 通过：真实 normalizer → metadata export → Python 投影覆盖 pi 部分成本/缓存缺失、非法原生 ID 降级、dsh 全缺 usage、独立游标、重放及删除；Knowledge 接受同页扩展字段。
- `npm run verify:follow` 合成临时回环服务、独立停止/恢复及游标追赶通过；`npm run verify:packages` 三个 tgz 和一个 wheel 在临时目录各自独立安装，包内 API/CLI/示例及新静态资源通过。没有真实部署或发布。
- Stats Python 全量 **150** 项通过；新增请求覆盖回归 **14** 项覆盖部分成本、缺失/零/恢复、相同累计不同观测、重放、独立来源、fork 不确定、旧投影只读隔离、旧/混合归档、Codex 合法部分费用及非法元数据回滚。
- Stats 前端 **34** 项通过；format:check、TypeScript、生产构建通过。新增覆盖测试已纳入常规 `npm test`，随 Python 包分发的静态资源由前端 build 更新。
- `python3 scripts/check-sensitive.py --all-files` 通过，0 阻断、0 隐私警告，包含新增未暂存测试与静态资源。
- `npm run check` 的类型检查、构建、Node/Python/工具测试均曾通过，但整体最后在默认扫描失败：Git 索引仍列出前端 build 已删除的旧哈希 JS，扫描报 unreadable tracked/source file。没有暂存用户文件、恢复旧产物或放宽扫描规则来制造通过；以全文件扫描另行验证当前工作树。不能将该次 `npm run check` 报为全绿。
- 合计 **401** 项模块、前端及工具测试通过，另有上述消费者/follow/独立发行物验证。中途新增 ID 边界测试曾发现 Knowledge 校验库按 Unicode 字符而非 UTF-16 长度计算的差异，已显式补长度校验并定向、全量复跑通过。最终独立复核另发现 Python `strip()` 与 JS `trim()` 空白集合不同：已按 ECMAScript 明确 25 个空白字符，穷举 BMP 全部 65,536 个码点验证集合一致；补 U+0085 接受 / U+FEFF 拒绝及真实 Trace→Stats→Knowledge 回归，Python 全量、两 TS 消费者定向、类型检查和发行物验证再次通过。
- 未做浏览器视觉验收、真实宿主长期运行、真实账单核对、生产重建或远端 CI；本轮未重跑 `verify:sources`；`verify:originals` 不适用于本轮，未运行。

## Trace 归档投影版本与升级守卫（2026-11-16）

对应 Stats 提醒面板中“旧或混合 pi/dsh 归档”提醒的根因排查。只使用合成 fixture、临时目录和实时归档的只读副本；没有读取真实会话正文、没有重启服务或迁移任何真实数据库。

### 根因与修复

- 根因：Trace 归档按源记录 `record_hash` 去重，只为新增源记录重新规范化；适配器语义变化（本轮 pi/dsh 请求级用量）不会重算已归档事件负载，归档自身也不记录“由哪个投影产生”，于是旧投影与新投影在同一归档中无声混合。消费者只能按会话猜测并提示（Stats 隔离为观测小计）；升级完成后表现为大量同义提醒，且真实采集问题被淹没。
- 修复：新增 `PROJECTION_VERSION`（`packages/agent-trace/src/projection.ts`），新归档创建时把它写入 `normalizer_version` 元数据；旧库不回填、不重贴标签。`Archive.assertProjectionCurrent()` 在 `importFile`、`deleteSession`、CLI `ingest`/`reingest` 与 `TraceService.start()` 中校验，跨版本写入或启动以 `PROJECTION_MISMATCH` 失败；`serve` 不再通过 API 下发混合投影。`status` 与 `serve.started` 暴露归档版本与当前构建期望版本；`export`/`read`/`status` 仍可只读检视旧库。`reingest` 的帮助/文档改为只补录新源记录，不能升级负载。
- 升级路径保持显式重建：用配置来源建立新归档（新的 `archive_id`，从零重新规范化），切换服务数据库并重建消费方库；不支持原地迁移，事件修订/撤回语义仍归 TODO 第 2 项。

### 本轮验证与限制

- 新增 Trace 回归 **6** 项（`tests/projection.test.ts`）：新库记录版本；旧投影库可读但写入被拒；未版本化旧库同样被拒；CLI `status` 报告两版本、`ingest` 退出 1 且 `export` 仍可读；`serve` 在错误版本库上启动前失败且不产生 `serve.started`；`reingest` 以 `PROJECTION_MISMATCH` 拒绝而不是假装对账。Trace 全量 **84** 项通过（原 78 + 6），typecheck、build 通过。
- `npm run verify:consumers`、`npm run verify:follow` 通过（合成数据）；Journal **70**、Knowledge **61** 项通过；Stats Python 此前本轮 150 项未受本次改动影响。
- 用实时归档的只读副本验证：`status` 报 `normalizer_version=codex-v1`、`expected_normalizer_version=normalizer-v2`，`ingest` 以 `PROJECTION_MISMATCH` 退出 1；源库 mtime 未变化，副本已删除。
- 未在本节执行：真实归档重建、消费方库重建、服务停止/重启、远端 CI（随后获得授权，结果见下节）。

### 迁移执行与结果（2026-11-16，获授权）

按授权执行旧归档与消费库的显式重建。旧数据库整库移动保留（不删除）在 `~/.local/share/agent-observatory-migration-backup-20261116T100643`（1.6G），可整体回滚。

- 顺序：先停 Stats follow、Stats 看板、Knowledge follow、Journal 定时任务，再停两个 Trace 服务；重建后按 metadata Trace → content Trace → Stats follow → Stats 看板 → Knowledge follow 启动，Journal 按原 06:30 计划重载（未触发模型调用）。所有服务当前 running，Trace/content 端口 18766/18767、Stats 看板 8765 恢复。
- 新归档由配置来源全量重建（528 个源文件、0 错误）：metadata `archive_id=42dcbfe8-3101-4dca-9c9a-ebb421e3c900`、`normalizer_version=normalizer-v2`、110,731 事件 / 393 会话；content `archive_id=585e41df-d5be-4e63-bfa0-a62b6aba3620`、`normalizer_version=normalizer-v2`、109,701 事件 / 389 会话。旧归档 390 个源文件中 13 个原始 `.jsonl` 已被 Codex 清理，但其归档 `.jsonl.zst` 仍在且事件计数一致，重建未丢失会话。
- Stats 从 0 回放：会话数与旧库一致（393，含重建后仍在运行的会话），游标已追到新 metadata 归档高水位；`request_coverage` 开始输出。页面/API 的 **86 条“旧或混合 pi/dsh 归档”提醒降为 0**，会话库内存储提醒为 0；只剩 1 条查询期“部分会话计量口径尚未核实”（7 个 codex 会话 `usage_accounting=unknown`，旧库同样存在，属真实口径限制而非投影陈旧）。
- Journal 状态库重建：`sync` 回放 219 页 / 67,603 事件，绑定新 content `archive_id`，cursor=110,762；未调用模型，未改动历史日报文件。
- Knowledge 证据库重建：旧证据库已备份，后台 `follow` 从 0 回放新 content 归档（截至记录时 cursor 已到 100,029 / content 高水位 110,983，仍在后台补齐；回放期间只能检索已回放证据）。旧索引库 `content.sqlite` 未改动。
- content blobs：`gc` 检查 349 个文件、344 个仍被引用，实际删除 5 个未被新归档引用的旧 blob。
- 回放后期主机出现无关的高负载（Virtualization 虚拟机与其它应用占满 CPU/内存，load average 一度 64），Knowledge 回放被 I/O 调度拖慢并出现超时重试；该过程可恢复且游标持久化，已恢复该 job 原 plist（`ProcessType=Background`、`page_size=200`）并保持服务运行，待主机负载回落后自动追平。
- 未执行：付费模型调用、发布、远端 CI、独立 reviewer 审查。

## 迁移与安装器基线（此前验证）

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 三个 Node 包类型 / 单测 / JS 与 .d.ts 构建、Python、工具测试与凭证扫描通过 |
| Trace | 72 通过，0 skip；含纯计划及真实 CLI 的副作用拦截测试 |
| Journal | 67 通过，0 skip；含 --apply 授权、dry-run、符号链接重定向及离线日报 |
| Knowledge | 59 通过，0 skip；合成协议测试不需要兄弟 Trace |
| Stats Python | 134 通过；含安装器 mock 安全测试与随包 example 导出 |
| Stats 前端 | 31 通过；format:check、TypeScript 与生产构建通过 |
| 根校验工具 | Python 6 + Node 2 通过；含归档 NUL + token、精确合成例外、Python / Node skipped 拒绝 |
| `npm run verify:sources` | 四模块各自在无兄弟模块的独立源码目录完成全套检查；Node 与 Python 显式验证无 skip / 非零测试 |
| `npm run verify:consumers` | 合成 Trace → Stats / Knowledge，独立游标、重放、删除传播通过 |
| `npm run verify:follow` | 合成临时回环服务及两个 worker，独立停止恢复与增量同步通过 |
| `npm run verify:packages` | 三个 tgz、一个 wheel 独立安装；暂存后无源码示例输入；API、CLI、静态资源及包内原始示例通过 |
| `npm run verify:originals` | 原模块 254 个文件与三个历史文档完整性通过，HEAD 未变、工作树干净 |

合计 **371 项本地模块、前端及工具测试通过**，另有无兄弟目录复跑、消费者 / follow 和发行物验证。源码隔离验证第一次发现 Stats 安装器测试仍间接需要兄弟 CLI，已改为受 mock 控制的本地合成 CLI 资源并重新完整通过；没有以跳过测试掩盖它。独立锁的部分传递版本不在根缓存中，源码校验现使用 prefer-offline，必要时下载，不再错误地假设根缓存包含全部独立锁版本。

## 安装器安全

三个源码安装器默认采用 local.agent-observatory.* 标签和独立状态路径，实际安装 / 卸载必须 --apply。默认拒绝路径先于写文件、联网或服务操作；dry-run 不执行 launchctl。Trace 对 dry-run + apply 的组合拒绝，Stats / Journal 以 dry-run 为准；Journal 计划仍会读取 / 校验指定配置。

新增逐级受管路径预检，防止默认状态目录、日志 / wrapper / plist 等符号链接将写入重定向到旧环境；用合成旧目录和 sentinel 验证拒绝后未变。Trace / Journal CLI 用预加载 mock 禁止子进程、网络与写入；Stats 使用 mock 校验所有操作。**没有真实调用 launchctl、没有安装 / 卸载服务。**实际部署及本地并发恶意路径替换不在本次证明范围；预检仍有 TOCTOU 竞态，不是完整沙箱。见[安全说明](SAFETY.md)。

## 发行物自包含

Trace 包内提供合成 Codex demo；Knowledge 包内提供示例文档并直接运行原始 memory-scanner，不重写 import；Journal 只从安装包读取示例并复制到用户可写位置；Stats 从已安装 wheel 的 console entry 导出 JSON，不需源码 docs。看板检查 HTML 实际引用的 JS / CSS 文件，不只判断目录里存在任意资源。

验证仍由开发环境构建，但每个包单独安装、无业务兄弟依赖。Node 安装使用根缓存；源码独立锁安装可下载缺少的传递依赖。没有修改依赖路由或发布公共包。

## 敏感信息与文档

- 扫描器检查历史归档，不豁免整个目录；凭证、敏感文件名、文本 NUL 等阻断。合成值仅限精确路径和完全相等的测试值，不是“含 synthetic 就放行”。
- 当前阻断发现为 0，但不可变 Journal 历史 TODO 保留一处原机器路径，明确报告 **1 项隐私警告**。`npm run check:privacy` 将其视为失败；公开前需另做隐私审核，不能声称本仓库已可直接公开。
- Stats 的五处失效历史引用已修正，历史原文保持逐字节不变；原文内旧链接不改写，映射见[归档说明](history/README.md)。
- CI 已配置凭证扫描、Python 3.9 / 3.13 矩阵、前端格式及汇总必过检查。只在本机验证了 Python 3.9；其他版本 / Linux 与实际 Actions 运行尚待远端执行。

## 历史与未覆盖范围

此前 monorepo 初次整理的 348 项基线、TODO / Review 原文归档及 YAML 本地解析均已记录并通过；本页以本轮最新复跑数为准。独立审查还曾修正自定义 Stats turn 缺少 evidence 导致详情渲染失败的问题，当前回归继续覆盖。

没有浏览器视觉验收、真实宿主长期运行、云模型调用或生产数据库接入；没有修改用户宿主 / MCP 配置、发布包或绑定远端。业务可信度待办仍见[当前 TODO](../TODO.md)与[后续规划](ROADMAP.md)。模块内历史文档提到的真实试点、真实模型费用与已安装 launchd 仅为历史参考，不计为新副本部署结果。
