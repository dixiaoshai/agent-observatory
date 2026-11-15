# 新项目整理与原代码保护

日期：2026-11-15。采用新增副本，**不是原目录重构、移动或覆盖**。

## 来源与复制范围

四个原模块复制到新仓库 packages 下，保留现有源代码、测试、fixtures、静态看板、示例与模块文档。以原项目 Git 跟踪文件为主，并保留补充的 docs；没有复制原项目 .git、node_modules、dist、真实数据库、个人 .config 运行凭证、真实日报、Journal 本地配置或历史源会话。

原模块内被 Git 跟踪的 .config 工作树开发配置及 CI 模板仍可能保留作历史参考，它们不是用户服务配置。嵌套 .github 工作流不作为 monorepo CI 执行，生效入口是根 .github。

[迁移基线](migration-baseline.json)记录每个原模块的 HEAD 与复制输入的 SHA-256，不记录私人文件正文。原有工作区顶层文档也没有被覆盖。

## 补充归档与 GitHub 配置（2026-11-15）

原工作区 TODO、Review 和 Journal TODO 已以逐字节一致的快照纳入[历史归档](history/README.md)，另有 SHA-256 / 字节数清单；原文不改写相对链接和历史部署状态。新项目的[当前 TODO](../TODO.md)单独提炼执行项、优先级与验收，不将旧问题当作已在新副本复核。

根 Dependabot 已整合为 GitHub Actions、根 npm workspaces、独立 Stats 前端三组更新。统一 CI 补充并发取消及 `CI success` 汇总检查；嵌套原配置只作历史参考。远端、Secrets、分支保护等未迁移，原 CI 尚未整合的检查见[GitHub 说明](GITHUB.md)。

## 本次新变化

- 建立根 npm workspace、统一检查命令、独立打包与安装冒烟脚本、根 CI。
- 三个 Node 模块增加公共 API / .d.ts / 独立发行物文件白名单，运行时无兄弟包依赖。
- Stats 增加标准化 session JSON / Python provider 接入，旧 Codex 与 Trace 路径保留。
- Journal 增加离线 activity 快照导入；注入 Trace client 不再强制读取 token，默认 Trace 行为保留。
- Knowledge 暴露 scanner 注入与公共 API，保留现有本地文件能力与 Trace 证据路径。
- 新增架构、数据源、开发、验证与限制文档；模块 README 增加新仓库导航。旧文档中的历史验收描述不作为本次重新验证的结论。

## 不做的操作

- 不修改、删除或重命名原四个目录，不合并它们的 Git 历史。
- 不升级或迁移现有服务，不安装 launchd，不改 MCP / 宿主配置。
- 不复制或打开个人生产数据库、凭证或真实日报。
- 不发布公共包、不创建远端、不替用户提交代码。
- 不把已有统计可信度或日报预算问题冒充本次已修复；见[后续规划](ROADMAP.md)。

## 使用已有数据时

最安全的试用方式是新库 + 合成输入。确需接入已有库时先备份，核对绝对路径、来源身份、source root、archive_id 和独立消费游标，禁止通过修改 ID 伪装迁移。Knowledge 的来源绑定与 Journal 单来源绑定都有防混用检查；移动源码不等于可以直接移动数据库中的来源路径。

## 验证原目录

在迁移现场根目录执行 `npm run verify:originals`。脚本读取相邻原目录，校验基线文件哈希、HEAD 与工作树状态，不写入原目录。可用 `python3 scripts/verify-originals.py --source-root /absolute/original/plugins` 指定位置。独立 clone 没有原目录时不执行此项，CI 也不要求它。
