# Agent Stats · 本机 agent 用量看板

## 模块定位

Agent Stats 是 Agent Observatory 中的用量统计模块，作为独立 Python 包发行。它把 Codex、pi、dsh 的本地日志（或自定义标准化会话数据）解析为 SQLite 统计投影，并通过本机看板展示用量、费用估算与覆盖信息；任务详情可按需只读 Agent Trace 的正文归档。

- 独立运行：要求 Python 3.9+，后端只用标准库，前端构建产物随包分发，生产运行不需要 Node。
- 输入可选：原生 Codex 日志、自定义 JSON / Python provider、可选 Agent Trace metadata（`follow` / `import-archive`）。
- 只读本机，只保存统计元数据；缺失信息保持未知，不补零。
- 服务只监听 `127.0.0.1`，不提供远程访问。

## 特性

- **本地优先**：原生模式只读 `CODEX_HOME`（默认 `~/.codex`）下的 `sessions` / `archived_sessions`，不联网、不上传。
- **覆盖度诚实**：Token、费用、请求数等指标按来源实际可获得性展示；父子、分叉、缓存等口径无法确认时，只展示带标注的观测小计。
- **来源独立**：自定义 JSON / Python provider 不需要 Agent Trace；只有显式配置正文归档时才只读 Trace content 库。
- **零后端依赖**：后端仅用 Python 标准库，自带构建好的 React 前端，装完即可运行。
- **前端可开发**：React + TypeScript + Vite，按页面、组件与数据访问拆分，可独立构建。

## 快速开始

在 `packages/agent-stats/` 下运行：

```sh
python3 -m agent_stats serve
```

打开 <http://127.0.0.1:8765/>，`Ctrl+C` 停止。默认数据库为 `~/.local/share/agent-stats/stats.sqlite3`。来源、端口、实例命名空间与归档只读模式的完整选项见[运行说明](docs/RUNNING.md)。

纯合成演示（不读取真实日志）：

```sh
python3 -m agent_stats demo --output .agent-stats/demo
python3 -m agent_stats --db .agent-stats/demo.sqlite3 serve --source .agent-stats/demo
```

自定义来源（不依赖 Trace 与 Codex）：

```sh
mkdir -p .agent-stats
python3 -m agent_stats example --output .agent-stats/custom.json
python3 -m agent_stats --db .agent-stats/custom.sqlite3 import-json --input .agent-stats/custom.json
python3 -m agent_stats --db .agent-stats/custom.sqlite3 summary
python3 -m agent_stats --db .agent-stats/custom.sqlite3 serve --archive-only --no-content
```

输入格式见[数据源契约](docs/SOURCES.md)。

安装为命令：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/agent-stats serve
```

## Agent Journal 日报（可选）

在 Stats 目录运行，显式指定已授权的 Journal `output_directory`，只读查看已生成的日报：

```sh
python3 -m agent_stats serve --archive-only --no-content --journal-dir /path/to/journal-output
```

打开「Agent Journal 日报」标签，按日期选择已生成的总结，默认显示最新一份。Stats 不生成日报，也不需要安装 Journal。详见[运行说明](docs/RUNNING.md#查看-agent-journal-日报可选)。

## 任务详情正文下钻（可选）

打开会话或轮次详情，点击“查看执行正文”，按时间线查看用户请求、Agent 回复、最终回答、推理摘要和工具输入输出；工具记录和摘要默认折叠，通过“加载更多”续读，“来源证据”保留事件 ID、源文件及行号。大型外置正文需按需读取，服务端校验目录、文件类型、大小与 SHA-256。

正文直接来自 Agent Trace 的独立 content 归档，不依赖 Agent Knowledge，也不读取原始 Codex / pi 日志。默认发现 `~/.local/share/agent-trace/content.json`；可通过 `AGENT_STATS_CONTENT_CONFIG` 或 `serve --content-config PATH` 指定 Trace content 配置，使用 `serve --no-content` 关闭：

```sh
python3 -m agent_stats serve --archive-only --content-config /absolute/path/to/agent-trace/content.json
```

- 正文只作为 HTTP 响应返回，不写入统计库；未配置、未采集或归档不可用时显示明确提示，已有统计仍可使用。
- 正文范围由 Trace content 配置的项目集合决定，与 `follow` 的 `allowed_project_ids` 消费范围相互独立。
- 会话详情展示整个会话正文，不随统计日期 / 模型筛选裁剪；轮次详情只展示对应轮次。
- 推理摘要是源日志中的模型摘要，不等于完整内部思考；工具返回不代表执行成功；正文按普通文本展示，不执行其中的 HTML、脚本或命令。

## 可选：跟随 Trace 元数据归档

`follow` 可消费 Agent Trace 的本机 metadata 事件 API（仅回环地址），按自身已提交游标增量拉取，统计投影与游标在同一事务内提交；看板用 `serve --archive-only` 只读已接收数据。

```sh
export AGENT_TRACE_STATS_TOKEN=...      # 明文 token 只从环境变量读取
python3 -m agent_stats config-check --config agent-stats.follow.example.json   # 只校验配置：不建库、不联网
python3 -m agent_stats follow --config agent-stats.follow.example.json
python3 -m agent_stats --db .agent-stats/stats.sqlite3 serve --archive-only
```

示例配置见 [agent-stats.follow.example.json](agent-stats.follow.example.json)。配置字段、可选 `allowed_project_ids` 范围、重试与退出码、租约行为和离线 `import-archive` 用法见[运行说明](docs/RUNNING.md)。

## 项目结构

```text
agent_stats/          后端（来源解析、SQLite 投影、HTTP API、CLI、follow）
agent_stats/static/   前端构建产物（随包分发）
frontend/             React + TypeScript + Vite 源码与前端测试
tests/                Python 单元 / 集成测试（合成输入与临时库）
scripts/              macOS LaunchAgent 安装器、敏感信息扫描
docs/                 本模块文档
```

## 开发与测试

后端测试（无需第三方依赖）：

```sh
python3 -m unittest discover -s tests -v
```

前端（Node.js 22.12+，独立 npm 项目）：

```sh
npm --prefix frontend ci
npm test --prefix frontend
npm run check --prefix frontend
npm run build --prefix frontend
```

构建产物写入 `agent_stats/static/`，该目录是随仓库跟踪的生成结果；界面改动请在 `frontend/src/` 进行。开发细节见[前端开发](docs/FRONTEND.md)。提交前可运行敏感信息扫描：

```sh
python3 scripts/check_sensitive.py
```

仓库级安装、检查与发行流程见[根开发指南](../../docs/DEVELOPMENT.md)。

## 隐私与边界

- 原生模式只在本机解析指定 JSONL 并持久化统计元数据：会话显示名、最多 80 字符的 Prompt 轮次摘要、Token / 工具计数与来源定位；不保存完整 prompt、思考、命令、工具参数和输出正文。
- 数据库文件、摘要、项目路径与事件身份仍可能包含敏感信息，请按本机敏感数据管理。
- `follow` 的 bearer token 只从环境变量读取，不写入配置或日志。
- HTTP 服务只绑定 IPv4 回环地址，拒绝不匹配 Host 与跨来源请求；没有远程访问能力。
- 正文下钻是显式的只读能力：不写统计库、不依赖 Knowledge、不打开源日志，可用 `serve --no-content` 关闭。
- 本机日志格式与版本相关，不是稳定公开 API；未知指标保持未知，API 等价费用估算不等于实际账单。
- macOS 安装器是源码开发工具：预览用 `--dry-run`（只展示计划，不做文件或服务修改），真实安装 / 卸载必须显式 `--apply` 并另行授权，无参数时会拒绝变更。运行前请读[安装器安全说明](../../docs/SAFETY.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 本模块文档导航与合成预览 |
| [运行说明](docs/RUNNING.md) | 启动、命令、follow、安装、页面口径、HTTP 接口、隐私与当前限制 |
| [前端开发](docs/FRONTEND.md) | React 模块、开发命令与构建 |
| [Codex 接入能力](docs/CODEX-CAPABILITIES.md) | 字段依据、能力声明与降级 |
| [数据源契约](docs/SOURCES.md) | 自定义 JSON v1、观测用量 / 费用 / 覆盖、Python provider API |
| [架构与依赖边界](../../docs/ARCHITECTURE.md) | 仓库级模块边界 |
| [开发指南](../../docs/DEVELOPMENT.md) | 仓库级安装、检查与发行 |
| [安全说明](../../docs/SAFETY.md) | 安装器隔离与风险 |
| [当前执行待办](../../TODO.md) | 仓库当前工作项 |

许可证：暂未附带开源许可证（默认保留所有权利）；对外发布前需要确认原始代码与素材的授权。
