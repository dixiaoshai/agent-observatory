# Agent Journal · TODO / Roadmap（交接给下一 session）

状态：**J1a + J1b 模型 + J1c 1.1/1.2 已实现（2026-11-15）；J1c 剩余 1.3 三天质量核对、1.4 map 缓存/重试与连续两天自然 06:30 观察；J2（Knowledge 索引）未完成。**
更新日期：2026-11-15（Asia/Shanghai）。

新 session 按顺序读：

1. [README.md](README.md)（设计与边界）
2. 本文件（交接状态、下一步、验收）
3. [journal-spike/REPORT.md](../journal-spike/REPORT.md)（真实数据规模与投影依据）
4. [agent-trace/docs/consumer-follow.md](../agent-trace/docs/consumer-follow.md)、[protocol.md](../agent-trace/docs/protocol.md)
5. [../TODO.md](../TODO.md) 的 Agent Journal 章节（工作区级状态）

---

## 0. 当前状态（2026-11-15）

### 代码与测试

- 项目：[agent-journal/](.)（TypeScript、Node 24.15+、零运行时依赖、SQLite/HTTP 内置）。
- `npm run check` 通过：typecheck + **61 项测试** + build。
- 模块：
  - `src/config.ts` 严格配置、token 只读 env
  - `src/trace/{client,page}.ts` Trace 双端点、v1 页校验、`projects` 消费范围过滤（名单外事件跳过）
  - `src/store.ts` cursor、单实例租约、页幂等、墓碑、days/runs
  - `src/projection.ts` 确定性投影（工具输出来不入）
  - `src/provider.ts` OpenAI 兼容 chat-completions
  - `src/model.ts` map/reduce、预算裁剪、输出校验
  - `src/render.ts` 确定性骨架 + 模型日报
  - `src/sync.ts`、`src/dream.ts`、`src/cli.ts`
  - `scripts/install-macos-service.ts` launchd 安装器（dry-run/uninstall/wrapper 注入 0600 token/key）
- 命令：`config-check` / `sync` / `dream` / `run` / `status` / `verify-model` / `help`；安装器 `npm run install-service -- ...`。

### 真实运行状态

- 配置：`agent-journal/journal.json`（本地文件，含相对路径；不要提交；key 走 env）。
  - `trace_url`: `http://127.0.0.1:18767`
  - `projects`: 8 个（agent-trace、agent-stats、agent-knowledge、plugins-workspace、analysis、browser-ai-sidebar、dsh-sub-agent、deepseek-harness）；这是**消费范围**，名单外 project_id 跳过、不报错
  - `model`: `deepseek-flash`，`https://api.deepseek.com/v1`，`max_output_tokens: 16000`，`timeout_seconds: 300`
  - `budget.max_output_tokens_per_day: 100000`
- Trace：archive_id `a3911c1b-bc08-4785-a473-5f4527e71688`，cursor **46,864**，本地 45,808 事件 / 129 会话（2026-11-15 11:25 状态）。
- **独立客户端（J1c 1.1）**：Trace `api.clients` 保留 `agent-knowledge` 并新增 `agent-journal`（`views:["content"]`）；Journal token 在 `~/.local/share/agent-journal/content.token`（0600），不读 Knowledge token；Trace 配置备份 `content.json.bak-journal-20261115111245`。
- 数据库：`.agent-journal/journal.sqlite`，约 **61 MB**；`days` 中 2026-11-14 为 `final` revision 1。
- 日报：`daily/2026-11-14.md`（30 KB，`generated: true`，`model: deepseek-flash`，`prompt_version: 1`；sha256 `d7404e9a…b1d014`，多次 kickstart 后未变）。
- 真实模型运行：17 次调用，input 95,694 / output 42,980 / total 138,674 tokens，约 **3m47s**；重跑 `skipped`（不重复计费）。`verify-model` 2026-11-15 通过（77 tokens）。
- launchd：`local.agent-journal` 已安装（06:30、`RunAtLoad` false），2026-11-15 11:17；多次 `launchctl kickstart` 均 `last exit code = 0`，日报 `skipped`，plist/wrapper/日志无 token/key 明文。
- 失败记录：`runs` 有 4 次 failed（早期 4k token/60s 截断、超时、reduce 数组超限各一次），已修；没有污染正式日报。`runs` 现为 1 written / 5 skipped / 4 failed（kickstart 验证产生 skipped）。

### 已知边界 / 坑

1. **Trace 客户端（已解决）**：2026-11-15 已加 `agent-journal` 独立客户端与 token（`~/.local/share/agent-journal/content.token`，0600），Knowledge 客户端与 token 保持不动；Journal 运行/launchd 从该文件注入 `AGENT_TRACE_JOURNAL_TOKEN`，不读 Knowledge token。
2. **DeepSeek 4.1 Flash 会输出 `reasoning_content`**：`max_output_tokens=4000` + 60s 会全部耗在 reasoning（`finish_reason=length`）或超时；现用 16k/300s。若调低需重新验证。
3. **模型输出数组会超限**：reduce 的 decisions 超过 12 条现在会截断（不失败）；`session_notes` 不截断。
4. **失败重跑会重复付费**：map 结果没有缓存，reduce 失败后整轮重跑所有 map（本 session 实测重复调用多次）。launchd wrapper 默认只对 transient 错误重试 1 次（30s），仍可能重复 map 计费；J1c 1.4 需加缓存。
5. **`run` 不调用 Knowledge**：`run` 只做 sync + D1 日报；Knowledge `sync` 要作为独立步骤由 launchd 串联（安装器 `--knowledge-source` 可选，当前未启用）。
6. **模型摘要不是事实**：highlights/decisions 没有逐条 `session_key` 证据，只有会话摘要带 `session_id`；引用前回查。
7. **没有事件保留/清理**：数据库会随事件增长（当前 61 MB）；J2 前加保留策略或 pruning。
8. **launchd 已安装（2026-11-15）**：`local.agent-journal`（06:30、`RunAtLoad` false）+ wrapper；kickstart 验证成功且幂等。`run` 在 skip 日约 20–30 秒，真实日报日约 4 分钟。连续两天自然 06:30 运行与休眠唤醒尚未实测。
9. `status`/`config-check` 的 `token_present`/`model_key_present` 只反映当前 shell env；launchd wrapper 从 0600 文件注入。手工运行需 `AGENT_TRACE_JOURNAL_TOKEN="$(cat ~/.local/share/agent-journal/content.token)"`，模型 key 从登录 shell 或 `~/.local/share/agent-journal/deepseek.key` 取。
10. **Trace 全量采集（即将上线）后 content 页会混入名单外 project_id**：Journal 从 2026-11-15 起把 `projects` 当**消费范围**处理——名单外事件（含 `unscoped` 兜底项目）跳过、不抛 `FORBIDDEN`，页信封与 cursor 照常前进；名单外 session 的删除标记同样不消费。名单外事件只保留信封级基础校验，不做深度内容校验（不落库）。

---

## 1. J1c（下一步，按顺序）

### 1.1 独立 Trace 客户端与 token（安全/归属）——已完成 2026-11-15

目标：Journal 不再借用 Knowledge 的 token。

- [x] 生成新 token：`openssl rand -hex 32`（只写 0600 文件，不打印、不提交）。
- [x] 计算 SHA-256 摘要，在 `~/.local/share/agent-trace/content.json` 的 `api.clients` 增加：
  ```json
  { "id": "agent-journal", "views": ["content"], "token_sha256": "<64-hex>" }
  ```
- [x] 重启 content 服务（`launchctl kickstart -k gui/$(id -u)/local.agent-trace-content`），确认 `/v1/status` 正常。
- [x] 保存 token 到 `~/.local/share/agent-journal/content.token`，权限 `0600`。
- [x] `journal.json` 的 `token_env` 保持不变，但运行/launchd 从该文件注入；短期可 `AGENT_TRACE_JOURNAL_TOKEN="$(cat ...)"`。
- 验收：用新 token `sync` 成功；旧 Knowledge token 不再被 Journal 使用；日志/配置无 token 明文。
- 注意：修改 Trace 正式配置前先备份，遵守工作区“不要静默改全局配置”的规则；如果用户不愿现在改，保留借用并在 TODO 标注。

验证（2026-11-15 11:12，用户已确认执行）：

- 备份：`~/.local/share/agent-trace/content.json.bak-journal-20261115111245`；Trace `config-check` 通过。
- 客户端：`agent-knowledge`（不变）+ `agent-journal`（`views:["content"]`），摘要互不相同；配置内无 token 明文。
- 重启后：新 token `/v1/status` 200、Knowledge 旧 token 仍 200、匿名 401。
- Journal：新 token `sync` 成功（cursor 45,503 → 46,100，+597 事件）；不注入 token 时 `sync` 报 `TOKEN_MISSING`；`journal.json`/日报无 token 明文。

### 1.2 launchd 06:30 安装器（J1c 核心）——已安装，待连续两天观察

目标：每天 06:30 自动 `sync + dream D-1`，失败可见、可重试、不泄露 token。

- [x] `scripts/install-macos-service.ts`（复用 Trace 安装器模式）：
  - label `local.agent-journal`，`StartCalendarInterval` 06:30，`RunAtLoad` false。
  - wrapper 脚本读两个文件/环境：Trace token 与 DeepSeek key（优先 wrapper + 0600 文件，plist 不含密钥）。
  - 命令：`node dist/cli.js run --config <abs journal.json>`，然后可选 `node .../agent-knowledge/dist/interfaces/cli.js sync --source <id> --config <knowledge config>` 作为独立步骤（`--knowledge-source`，当前未启用）。
  - 日志：`~/.local/share/agent-journal/run.log|err`，0600；单实例靠 SQLite 租约（`FOLLOW_LOCKED` 视为良性）。
  - 支持 `--dry-run`（只打印 plist/命令，不写 launchd）、`--uninstall`、`--state-dir`/`--plist-dir`/`--retries` 等；`npm run install-service -- ...`。
- [x] 安装前 `npm run build`；`npm run check`（58 项）、`config-check` 与 `verify-model` 通过。
- [x] 实测：`launchctl kickstart -k gui/$(id -u)/local.agent-journal`，检查 run.log、日报、runs 记录；再 kickstart 验证幂等 `skipped`。
- [x] 失败（断网/401）与租约冲突行为记录；wrapper 已内建 transient 重试（默认 1 次，30s/120s 退避）。
- [ ] 休眠/唤醒真机实测（当前仅按 launchd calendar 语义记录：唤醒后补跑一次，Journal 按 `max_days_per_run` 顺序补日）。
- 验收：连续两天自动产生日报（或 dry-run + 手动 kickstart 证据）；日志无 token/key；失败不覆盖已有日报。

验证（2026-11-15 11:17–11:22）：

- `--dry-run`（真实 `journal.json`）输出 plist/wrapper/命令，未创建任何文件、未调用 launchctl；`--uninstall --dry-run` 正确打印删除计划。
- 安装：`local.agent-journal` / 06:30 / `RunAtLoad` false；plist 0600、state 0700、`run.sh`/`run.log`/`run.err`/`content.token`/`deepseek.key` 均 0600；`deepseek.key` 由登录 shell 的 `DEEPSEEK_API_KEY` 生成（未打印值）。
- kickstart：多次 `last exit code = 0`；`run.log` 记录 `run` JSON（sync + `dream: skipped`）与时间戳；`daily/2026-11-14.md` sha256 始终 `d7404e9a…b1d014`；`run.err` 为空；重装后再次 kickstart 仍 `skipped`。
- 租约冲突：人为占租约后 kickstart 退出 0、`run.log` 记 “already running, skipped”、`run.err` 不写错误 JSON。
- 失败：错 token（401，permanent）退出 1；关闭端口（transient）退出 1，wrapper 重试 1/1（30s，共 33s）；两种情况已有日报均未被覆盖（sha 不变）。
- 卸载/重装：真实 `--uninstall` 移除 plist 并 bootout（保留 state/logs，日志显示 state 文件仍在），重装后再次 kickstart 成功（11:25，sync +285 事件、`skipped`、`last exit code = 0`、`run.err` 为空）。
- 明文检查：plist、wrapper、run.log、run.err 中无 token/key。

### 1.2a 待观察：连续两天自然 06:30 运行

- [ ] 2026-11-16、11-17 06:30 由 launchd 自然触发（非 kickstart），确认日报自动产生、日志无错误；若失败，修因并记录。

### 1.3 三天真实质量/成本核对

- [ ] 对 2026-11-15、11-16、11-17 生成真实日报（或历史上再选 2 天）。
- [ ] 核对：项目归属、会话数、决策是否真实、是否虚构、阻塞/下一步是否有用；对照 `daily/2026-11-14.md`。
- [ ] 记录每天：调用次数、input/output tokens、耗时、模型成本、dropped_sessions。
- [ ] 决定：是否需要更小模型、降低 reasoning、调整 `max_output_tokens`、改 prompt。
- 验收：3 天日报可读、无明显编造；成本可接受（目标待用户确认，例如 < $0.5/天）。

### 1.4 模型调用缓存 + 重试（强烈建议）

问题：现在 17 次 map 调用；reduce 失败一次，下次整轮重跑（本 session 早期失败 4 次，重复计费）。

- [ ] SQLite 增加 `map_cache(session_hash, model, prompt_version, summary_json, usage_json, created_at)`；`session_hash` 由该会话投影内容 + model + prompt_version 生成。
- [ ] `summarizeDay` 先查缓存，只对缺失/变化的会话调 map；reduce 始终跑。
- [ ] 对 `MODEL_TIMEOUT`/`MODEL_RATE_LIMITED`/`MODEL_UNAVAILABLE` 做指数退避重试（3 次），permanent 不重试；失败 run 记录 usage 已有，补 cost。
- [ ] 测试：假 provider 模拟第一次 reduce 失败、第二次成功，断言 map 只调用一次；缓存命中不调用 provider。
- 验收：reduce 失败重跑不再重复 map 计费；缓存可按 day/prune 清理。

### 1.5 性能/成本优化（可选，等 1.3 数据）

- 17 次调用偏多：map 批次约 6k tokens，但 reasoning 输出 43k；可评估：
  - 将 map 批大小调大/调小（当前 6k）；
  - map 用更便宜的模型、reduce 用强模型（需要 `model.map` / `model.reduce` 两套配置）；
  - 压缩 map 输入（路径数、用户消息条数）；
  - 限制 reasoning：如果 DeepSeek 提供 `reasoning_effort`/非 thinking 模式，评估后接入。
- 目标：单日 ≤2–3 分钟、成本下降 30%+，质量不降。

### 1.6 其他可靠性

- [x] `run` 增加整体失败退出码/日志约定，launchd 能感知（401/断网均退出 1，wrapper 追加时间戳日志）。
- [ ] `dream` 失败不覆盖旧日报（已验证：401/断网后日报 sha256 不变）；报告失败原因到 `runs.cost.error`。
- [ ] 增加 `status --json` 里的 `days`/最近 runs 摘要，便于看板。
- [ ] 事件保留：finalized day 超过 N 天（例如 14/30）后清理 `events`，否则 DB 持续增长；注意墓碑与重算需求。
- [x] 处理 `journal.json` 本地配置：`.gitignore` 已包含 `journal.json`、`daily/`、`.agent-journal/`（2026-11-15 复核）。

---

## 2. J2：Knowledge 索引与召回

目标：日报能被 `agent-knowledge` 的 `search_context` 召回，同时明确是模型生成物。

- [ ] agent-knowledge source 支持 `generated: true`（配置 + 记录字段 + 迁移/测试）；当前 `KnowledgeRecord.generated` 固定 false。
- [ ] 把 `agent-journal/daily/` 配成 Knowledge source（单独 project，例如 `journal`）。
- [ ] 更新 skill 文案：日报是二手摘要；引用前回查原始事件；不要把日报当事实。
- [ ] 验收：新会话 `search_context` 能搜到“昨天做了什么”，`read_record` 返回日报；`generated` 标记可见；删除/更新日报后 Knowledge 同步。
- [ ] 可选：把 `candidates.jsonl`（决策/lesson 候选）作为 J3 输入，但不要自动晋升。

---

## 3. J3：跨天整合（dreaming 语义，后期）

- [ ] 门控：24h + 至少 N 天日报/会话、单实例锁。
- [ ] 四阶段：Orient（已有日报/Knowledge 索引）→ Gather（近 N 天）→ Consolidate（去重/消矛盾/相对日期转绝对）→ Prune & Index。
- [ ] 产物：候选决策/偏好/lesson（带 session/event 引用），写入 Knowledge 的 candidate 状态；依赖 Knowledge 的 `record_memory`/`record_feedback`（未实现）。
- [ ] 验收：重复决策合并；矛盾保留替代关系；可撤回；有回滚点。

---

## 4. 新 session 起步命令

```sh
cd $HOME/workspace/agent_tools/plugins/agent-journal
npm ci
npm run check

# 真实环境（key 在 ~/.zshrc；token 从独立 0600 文件读，不借用 Knowledge）
zsh -ic 'cd '"$PWD"' && export AGENT_TRACE_JOURNAL_TOKEN="$(cat ~/.local/share/agent-journal/content.token)" && node src/cli.ts status --config journal.json'
zsh -ic 'cd '"$PWD"' && node src/cli.ts verify-model --config journal.json'
zsh -ic 'cd '"$PWD"' && export AGENT_TRACE_JOURNAL_TOKEN="$(cat ~/.local/share/agent-journal/content.token)" && node src/cli.ts run --config journal.json'

# launchd（已安装；重装/卸载/干跑）
npm run build
node --experimental-strip-types scripts/install-macos-service.ts --config journal.json --dry-run
node --experimental-strip-types scripts/install-macos-service.ts --config journal.json
node --experimental-strip-types scripts/install-macos-service.ts --uninstall
launchctl kickstart -k gui/$(id -u)/local.agent-journal
tail -n 20 ~/.local/share/agent-journal/run.log; cat ~/.local/share/agent-journal/run.err
```

- 不要打印或提交 token/key；不要修改 Trace/Knowledge 正式配置而不先备份并取得用户同意。
- 改动后跑 `npm run check`；真实日报改动先在临时副本或不覆盖已有 day 的方式验证。
- 没有真实 key 时用 `--no-model` 验证确定性链路。

---

## 5. 完成定义（J1c）

- [x] `agent-journal` 有独立 Trace content 客户端与 token，不再借用 Knowledge。
- [ ] launchd 06:30 稳定运行；连续两天自动日报（或等价 kickstart 证据）。**安装器已装并多次 kickstart 验证（2026-11-15）；自然 06:30 的 11-16/11-17 待观察。**
- [ ] 3 天真实 DeepSeek 质量/成本记录，用户确认可接受。
- [ ] map 缓存/重试落地，reduce 失败不重复计费（wrapper 仅做 transient 重试，缓存未做）。
- [x] README/TODO/验证记录更新；不把未实测项写成已完成。

---

## 6. 验证记录：J1c 1.1 / 1.2（2026-11-15）

环境：macOS、Node v24.15.0、Trace content 服务 `local.agent-trace-content` 运行中、`~/.local/share/agent-knowledge` follow worker 运行中。修改全局配置前已取得用户确认并备份。

### 交付物

- `src/**` 未改；新增 `scripts/install-macos-service.ts`、`tests/installer.test.ts`（8 项）；`package.json` 加 `install-service`；`tsconfig.json` include `scripts/**/*.ts`。
- `npm run check`：typecheck + **58/58 测试** + build 通过。

### J1c 1.1 证据

| 检查 | 结果 |
| --- | --- |
| Trace 配置（备份后）`config-check` | 通过 |
| `api.clients` | `agent-knowledge`（不变）+ `agent-journal`（`content`），摘要不同 |
| 新 token `/v1/status` | 200 |
| Knowledge 旧 token `/v1/status` | 200（未受影响） |
| 匿名 `/v1/status` | 401 |
| Journal `sync`（新 token） | 成功，cursor 45,503 → 46,100（+597），后续增量正常 |
| 不注入 token 的 `sync` | 退出 1，`TOKEN_MISSING` |
| token 明文 | Trace 配置只存 sha256；`journal.json`/日报/plist/wrapper/日志均无明文 |

### J1c 1.2 证据

| 检查 | 结果 |
| --- | --- |
| `--dry-run` | 输出 plist/wrapper/命令；未创建文件、未调用 launchctl/plutil |
| 安装 | `local.agent-journal`，06:30，`RunAtLoad` false；plist/日志/wrapper/token/key 均 0600，state 0700 |
| kickstart（多次） | `last exit code = 0`；`run.log` 有 sync JSON + `dream: skipped`；`run.err` 空 |
| 幂等 | 重跑 `skipped`；`daily/2026-11-14.md` sha256 `d7404e9a…b1d014` 始终不变 |
| 租约冲突 | 人为占租约 -> 退出 0、日志 “already running, skipped”、`run.err` 为空 |
| 401（permanent） | 退出 1，不重试，不改日报 |
| 断网（transient） | 退出 1；wrapper 重试 1/1（30s，共 33s）后失败，不改日报 |
| 密钥泄露 | plist/wrapper/run.log/run.err 均无 token/key |
| `verify-model` | 通过（77 tokens） |

### 仍未完成 / 待观察

- 2026-11-16、11-17 自然 06:30 触发（非 kickstart）与连续两天日报。
- 休眠/唤醒后补跑的真机实测。
- 真实 provider 三天质量/成本核对（1.3）；map 缓存与 reduce 失败不重复计费（1.4）；Knowledge `generated: true` 索引（J2）。
- 事件保留/DB 增长（当前 61 MB，7），`journal.json` 的 `.gitignore` 实际已包含（本条旧记录可忽略）。
