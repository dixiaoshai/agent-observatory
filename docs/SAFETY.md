# 安装器安全与服务隔离

源码安装器必须显式传入 `--apply` 才允许变更服务。没有该参数时，安装和卸载均在任何服务操作或写入前拒绝；`--dry-run` 只展示计划，不运行 launchctl。Trace 不允许同时传 `--apply` 和 `--dry-run`；Stats / Journal 同时传入时 dry-run 优先，仍不执行。

## 隔离默认值

| 安装器 | 固定服务名 | 默认状态 / 配置目录 |
| --- | --- | --- |
| Trace content | local.agent-observatory.trace-content | `~/.local/share/agent-observatory/agent-trace/` |
| 可选 Knowledge follow | local.agent-observatory.knowledge-follow | `~/.local/share/agent-observatory/agent-knowledge/` |
| Stats 看板 | local.agent-observatory.agent-stats | `~/.local/share/agent-observatory/agent-stats/` |
| Stats 可选 metadata Trace | local.agent-observatory.agent-trace | `~/.local/share/agent-observatory/agent-trace/` |
| Stats 可选 follow | local.agent-observatory.agent-stats-follow | 同 Stats 状态目录 |
| Journal 日报 | local.agent-observatory.agent-journal | `~/.local/share/agent-observatory/agent-journal/` |

这些名称与常见的 local.agent-stats、local.agent-trace-content、local.agent-knowledge-follow、local.agent-journal 等标签不同。默认 plist 使用隔离服务名，不停止、卸载或覆盖已有标签。Stats 默认仅安装隔离看板（18765，archive-only + no-content），不会自动安装 Trace；显式选择 `--with-trace` 时先核对所有所需配置、token 与服务资源，再执行。

## 先看计划，不做部署

从源码仓库根目录可运行以下预览（并非实际安装）：

```sh
node packages/agent-trace/scripts/install-content-service.ts --dry-run
python3 packages/agent-stats/scripts/install-macos-service.py --dry-run
node packages/agent-journal/scripts/install-macos-service.ts --dry-run --config packages/agent-journal/agent-journal.example.json
```

这些是**源码开发工具，不是 npm 发行包 API**。Node tarball 不含安装脚本，不能在安装包目录使用开发者的 npm install-service / install:content 脚本。Journal 预览会读取并校验指定配置，但不读凭证、不联网或调用服务；Trace / Stats 预览为纯计划。

## Trace content 与可选 Knowledge worker 的 macOS 源码部署

这是源码仓库提供的 macOS 用户级 launchd 安装器，不属于发行包 API。它默认同时选择 Trace content 和可选的 Knowledge follow；只需 Trace 时必须传 `--no-knowledge`。在仓库根目录预览：

```sh
node packages/agent-trace/scripts/install-content-service.ts --dry-run
node packages/agent-trace/scripts/install-content-service.ts --dry-run --no-knowledge
node packages/agent-trace/scripts/install-content-service.ts --dry-run --uninstall
```

预览不读取配置或 token、不运行子进程或 launchctl，也不验证配置或端口。安装和卸载都需要单独授权并显式使用 `--apply`，且不能与 `--dry-run` 同时使用；卸载默认选择两个任务，使用 `--no-knowledge` 则只移除 Trace 任务。卸载不会删除数据库和日志。

默认 Trace 配置和令牌分别为 `~/.local/share/agent-observatory/agent-trace/content.json`、`content.token`；Knowledge 配置为 `~/.local/share/agent-observatory/agent-knowledge/content.follow.json`，源码目录默认是 Trace 的同级 `../agent-knowledge`。可分别用 `--config`、`--token-file`、`--knowledge-follow`、`--knowledge-dir` 覆盖；两个任务的日志位于各自状态目录。更换路径不会更换服务标签。

正式部署前，除下节审查外还需确认：

- Trace 配置已经是 `capture_mode: "content"` 且 `collection.enabled: true`；安装器不会开启采集。回补是显式动作，完成后将 `collection.backfill` 改回 `"none"`，避免每次启动重扫历史。
- 如选择 Knowledge，须事先构建其源码，准备 follow 配置（包含 `token_env`）和非空 token 文件，并核对上游端点、项目授权与独立数据库。明文 token 写入 Knowledge plist 的环境变量（plist 权限 `0600`），不写入日志；Trace 配置保存 token 哈希。
- 安装器先校验 Trace 配置和所需 Knowledge 文件及凭证，再创建状态目录和日志，停止选中的隔离任务，对配置指向的 Trace blob 目录执行 GC，然后写入并启动 Trace plist，再写入并启动 Knowledge plist。GC 失败会中止；多服务步骤不具备全局事务性。
- 两个任务使用 `RunAtLoad`、`KeepAlive` 和 30 秒节流。重启后的消费进度和来源身份仍各自独立；跨模块授权、游标和删除传播见 [Trace 消费方部署](TRACE-CONSUMERS.md)。

核对预览及真实数据范围、获得授权后，实际安装或卸载可使用同一脚本并以 `--apply` 替代 `--dry-run`。不要将以上预览误认为已验证实际部署。

## 显式配置仍须人工审查

`--apply` 是对真实变更的授权，不是沙箱。用户显式指定的数据库、blob、输出目录、source、token、上游端点仍可能指向旧生产数据。Trace content 安装流程包含对所选库的 blob GC，不能仅凭隔离的 launchd 标签就认为数据一定隔离。

正式执行前必须：

1. 查看 dry-run 中全部标签、目录、可执行入口及端口，核对新配置没有引用原生产库、原输出目录和原凭证。
2. 使用新数据库、新 blob / 日报目录与独立凭证，备份需共享的数据；不要为了试用复用原配置。
3. 对真实日志范围、模型费用、服务启动和任何共用数据取得明确授权。
4. 多服务安装不是全局事务。运行时 bootstrap 失败可能留下已安装的**新隔离服务**，需按错误逐项处理，不能顺手卸载原服务。

## 当前验证边界

安装器安全只通过纯计划函数、临时目录、子进程 / 文件写入 / 网络 mock 验证拒绝路径和 dry-run，不实际调用 launchctl、不安装或卸载服务。实际 macOS 部署仍需单独授权与验证。执行前还会逐级检查受管状态、日志、wrapper、plist 与默认配置 / secret 路径，拒绝符号链接或异常文件类型重定向；这属于尽力预检，检查后本地并发替换路径仍存在竞态，不能当作对抗恶意本地进程的完整沙箱。
