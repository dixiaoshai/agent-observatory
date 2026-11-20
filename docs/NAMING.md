# 命名规则

仓库 / 工具集名为 **Agent Observatory**（`agent-observatory`），表达对 Agent 执行、用量、回顾与知识的整体观察和沉淀。该名称用于源码仓库，不代表必须安装的统一程序。

| 功能 | 目录 / distribution | 展示名 | 主命令 |
| --- | --- | --- | --- |
| 采集与证据归档 | agent-trace | Agent Trace | agent-trace |
| 用量与费用统计 | agent-stats | Agent Stats | agent-stats |
| 日志与每日回顾 | agent-journal | Agent Journal | agent-journal |
| 来源支持的知识检索 | agent-knowledge | Agent Knowledge | agent-knowledge |

模块位于 packages 下，名称不因 monorepo 品牌改变。Python import 为 agent_stats；Node 包通过包主名导入。保留 agent-stat、knowrelay 等已存在命令别名，不再新增旧品牌作为主入口。

新环境变量使用 AGENT_模块名_用途；JSON 与数据库字段沿用 snake_case，TypeScript 使用 camelCase，Python 使用 snake_case。event_id、archive_id、session_key 等领域字段不是品牌，不机械更名。

用户数据路径与配置兼容逻辑沿用各模块既有行为。工具不会自动移动数据库、迁移 source binding、修改全局安装或 macOS 服务。公共包名尚未确认可用，发布时可能需要组织 scope，不应仅凭本地 manifest 假定公共 registry 已有本项目。
