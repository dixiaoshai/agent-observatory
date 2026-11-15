# 安装器安全与服务隔离

**不要直接照抄历史文档中的安装 / 卸载命令。** 本副本没有接管原项目服务；新的源码安装器必须显式传入 `--apply` 才允许变更服务。没有该参数时，安装和卸载均在任何服务操作或写入前拒绝；`--dry-run` 只展示计划，不运行 launchctl。Trace 不允许同时传 `--apply` 和 `--dry-run`；Stats / Journal 同时传入时 dry-run 优先，仍不执行。

## 隔离默认值

| 安装器 | 固定服务名 | 默认状态 / 配置目录 |
| --- | --- | --- |
| Trace content | local.agent-observatory.trace-content | `~/.local/share/agent-observatory/agent-trace/` |
| 可选 Knowledge follow | local.agent-observatory.knowledge-follow | `~/.local/share/agent-observatory/agent-knowledge/` |
| Stats 看板 | local.agent-observatory.agent-stats | `~/.local/share/agent-observatory/agent-stats/` |
| Stats 可选 metadata Trace | local.agent-observatory.agent-trace | `~/.local/share/agent-observatory/agent-trace/` |
| Stats 可选 follow | local.agent-observatory.agent-stats-follow | 同 Stats 状态目录 |
| Journal 日报 | local.agent-observatory.agent-journal | `~/.local/share/agent-observatory/agent-journal/` |

这些名称不同于原项目的 local.agent-stats、local.agent-trace-content、local.agent-knowledge-follow、local.agent-journal 等。默认 plist 使用新服务名，不停止、卸载或覆盖原标签。Stats 默认仅安装隔离看板（18765，archive-only + no-content），不会自动安装 Trace；显式选择 `--with-trace` 时先核对所有所需配置、token 与服务资源，再执行。

## 先看计划，不做部署

从源码仓库根目录可运行以下预览（并非实际安装）：

```sh
node packages/agent-trace/scripts/install-content-service.ts --dry-run
python3 packages/agent-stats/scripts/install-macos-service.py --dry-run
node packages/agent-journal/scripts/install-macos-service.ts --dry-run --config packages/agent-journal/agent-journal.example.json
```

这些是**源码开发工具，不是 npm 发行包 API**。Node tarball 不含安装脚本，不能在安装包目录使用开发者的 npm install-service / install:content 脚本。Journal 预览会读取并校验指定配置，但不读凭证、不联网或调用服务；Trace / Stats 预览为纯计划。

## 显式配置仍须人工审查

`--apply` 是对真实变更的授权，不是沙箱。用户显式指定的数据库、blob、输出目录、source、token、上游端点仍可能指向旧生产数据。Trace content 安装流程包含对所选库的 blob GC，不能仅凭隔离的 launchd 标签就认为数据一定隔离。

正式执行前必须：

1. 查看 dry-run 中全部标签、目录、可执行入口及端口，核对新配置没有引用原生产库、原输出目录和原凭证。
2. 使用新数据库、新 blob / 日报目录与独立凭证，备份需共享的数据；不要为了试用复用原配置。
3. 对真实日志范围、模型费用、服务启动和任何共用数据取得明确授权。
4. 多服务安装不是全局事务。运行时 bootstrap 失败可能留下已安装的**新隔离服务**，需按错误逐项处理，不能顺手卸载原服务。

## 本次验证边界

测试使用纯计划函数、临时目录、子进程 / 文件写入 / 网络 mock 验证拒绝路径和 dry-run，未实际调用 launchctl、未安装或卸载服务。实际 macOS 部署仍需单独授权与验证。执行前还会逐级检查受管状态、日志、wrapper、plist 与默认配置 / secret 路径，拒绝符号链接或异常文件类型重定向；这属于尽力预检，检查后本地并发替换路径仍存在竞态，不能当作对抗恶意本地进程的完整沙箱。本次原项目与历史文件完整性核对见[验证记录](VALIDATION.md)。
