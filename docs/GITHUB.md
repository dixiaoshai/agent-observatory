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
- 本仓库已创建为公开仓库 [dixiaoshai/agent-observatory](https://github.com/dixiaoshai/agent-observatory)，本地 `origin` 指向它，`main` 为首要分支；原仓库的 PR / Issue / Releases / Secrets / Environments / 分支保护 / rulesets 不会随文件复制而迁移。
- 根 CI 已随首次推送在远端 Actions 实际运行，并据此修正了三处只在全新克隆 / 冷缓存环境暴露的问题：根 `check` 改为先 `build` 再 `test`（Knowledge 验收测试会调用 `dist/`），Python 3.9 任务改用 `ubuntu-22.04`（`ubuntu-latest` 已迁移到 26.04，不再提供 3.9），发行包安装测试改用 `--prefer-offline`（`npm ci` 只缓存 tarball，不缓存解析依赖所需的 packument）。分支保护仍需维护者在成功运行后显式设置为要求 `CI success`。
- 已恢复原 CI 的凭证 / 敏感文件扫描、Python 3.9 / 3.13 测试矩阵和前端 format:check，全部纳入 `CI success` 的必过依赖。源码隔离测试拒绝 Node / Python 的 skipped 或零测试，发行包测试在暂存完成后不再读取仓库示例。
- [根扫描器](../scripts/check-sensitive.py)同时检查历史归档，凭证、敏感文件名、异常文本 NUL 等发现会阻断；仅对具体测试路径中的完全相等合成值设例外。个人路径单独报告隐私警告，公开前必须运行 `npm run check:privacy` 使其成为失败。原文归档中原有的唯一一处个人主目录路径已脱敏（脱敏前哈希保留在清单的 `source_sha256`），`npm run check:privacy` 现通过；远端 CI 的敏感扫描任务也已通过。
- 扫描为启发式检查，不保证发现所有秘密或解析二进制内容。无 Git 初始化时扫描排除依赖 / 构建目录的源码树；CI 中默认扫描 Git 跟踪文件，暂存前可用 `python3 scripts/check-sensitive.py --all-files`。没有为通过检查而豁免整个历史目录；仅对 `agent-journal-TODO.md` 的一处个人主目录路径做了脱敏，其余原文快照字节未改。
- 已知扫描盲区：不检测邮箱、GitHub 用户名、私有仓库链接、图片内容，以及 `~/`、`/private/var`、`/root` 等路径，也不覆盖提交身份。首次公开前已用独立审查补充人工核对（提交图片为合成演示数据、引用的兄弟仓库均为公开仓库、提交使用 GitHub noreply 身份）；后续公开变更仍建议人工复核。

当前执行项见[根 TODO](../TODO.md)，历史依据见[归档索引](history/README.md)。
