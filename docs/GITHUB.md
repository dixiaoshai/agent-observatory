# GitHub 配置与迁移状态

## 当前生效入口

只有**仓库根目录**的 GitHub 配置会生效；模块内原配置保留作历史参考，不会作为独立仓库运行。

| 根配置 | 当前用途 |
| --- | --- |
| [统一 CI](../.github/workflows/ci.yml) | Node / Python 检查与构建、前端格式 / 类型 / 测试、消费者 / follow、无兄弟目录源码测试、仅发行包资源安装测试、artifact 上传 |
| [Dependabot](../.github/dependabot.yml) | 每周一检查根工作流、根 npm workspaces 与独立 Stats 前端 |

CI 使用只读 contents 权限；同一 ref 的新运行取消旧运行；`CI success` 为汇总检查，模块任务失败、取消或跳过均不会通过。上传的是本地构建发行物，不会执行 npm / PyPI 发布。没有使用 `pull_request_target`，不会将密钥注入外部 PR 代码。

## Dependabot 的目录边界

- `github-actions`：`/`，检查根工作流。
- `npm`：`/`，以根 package-lock 管理三个 Node workspaces；不再分别为模块发重复依赖更新。
- `npm`：`/packages/agent-stats/frontend`，对应独立的前端 manifest / lock。

保留原配置的每周一调度与 minor / patch 分组；major 更新不并入该组，仍需人工评估。所有更新需要人工审查，不启用自动合并。

Stats 后端没有第三方运行时依赖，目前没有 Python 运行时 lock，因此暂不添加空的 pip 更新任务；setuptools / wheel 构建约束仍需维护者审查。模块内保留的独立锁文件不由根 npm 更新自动保证同步，依赖升级合并前需核对它们，或将来明确取消独立源码安装支持；详见[开发指南](DEVELOPMENT.md)。

## 保留但不生效的原配置

- [Trace 原 CI](../packages/agent-trace/.github/workflows/ci.yml)
- [Stats 原 CI](../packages/agent-stats/.github/workflows/ci.yml)
- [Stats 原 Dependabot](../packages/agent-stats/.github/dependabot.yml)
- [Knowledge 原 CI](../packages/agent-knowledge/.github/workflows/ci.yml)

这些文件仍使用原单仓库目录和命令，不能当作 monorepo 的活动配置。本次不删除历史副本，也不改动原项目。

## 不等于已迁移的项目

- 原仓库远端、PR / Issue、Releases、Secrets、Environments、分支保护、rulesets 与维护权限，不会随文件复制而迁移。
- 本次未创建 GitHub 仓库、绑定远端、提交、推送或公开任何历史文档。
- 根 CI 已配置，但尚未在远端 Actions 实际运行；新仓库需要启用 Actions / Dependabot。分支保护应在首次成功运行后由维护者显式设置为要求 `CI success`。
- 已恢复原 CI 的凭证 / 敏感文件扫描、Python 3.9 / 3.13 测试矩阵和前端 format:check，全部纳入 `CI success` 的必过依赖。源码隔离测试拒绝 Node / Python 的 skipped 或零测试，发行包测试在暂存完成后不再读取仓库示例。
- [根扫描器](../scripts/check-sensitive.py)同时检查历史归档，凭证、敏感文件名、异常文本 NUL 等发现会阻断；仅对具体测试路径中的完全相等合成值设例外。个人路径单独报告隐私警告，公开前必须运行 `npm run check:privacy` 使其成为失败。当前原文归档仍保留一处原机器路径，因此严格隐私检查预期失败，不能宣称已可无审核公开。
- 扫描为启发式检查，不保证发现所有秘密或解析二进制内容。无 Git 初始化时扫描排除依赖 / 构建目录的源码树；CI 中默认扫描 Git 跟踪文件，暂存前可用 `python3 scripts/check-sensitive.py --all-files`。没有为通过检查而豁免整个历史目录，也没有更改原文快照。

当前执行项见[根 TODO](../TODO.md)，历史依据见[归档索引](history/README.md)。
