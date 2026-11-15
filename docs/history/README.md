# 历史 TODO / Review 归档

归档日期：2026-11-15。以下为原文快照，除 **1 处个人主目录路径**（`agent-journal-TODO.md` 的“新 session 起步命令”中一处绝对路径已替换为 `$HOME`）外逐字节保留，未重写勾选状态、测试数字或历史部署结论。原始文件仍在原位置且未被修改。

| 历史原文 | 原位置（相对原工作区） | 用途 |
| --- | --- | --- |
| [工作区 TODO](2026-11-15/workspace-TODO.md) | `TODO.md` | 常驻采集、消费方、跨模块交接及原环境进度 |
| [工作区 Review](2026-11-15/workspace-REVIEW.md) | `REVIEW-2026-11-15.md` | 历史问题证据、可信度风险与产品建议 |
| [Journal TODO](2026-11-15/agent-journal-TODO.md) | `agent-journal/TODO.md` | Journal 模型、定时任务和知识集成交接 |

[完整性清单](2026-11-15/manifest.json)记录源路径、归档路径、字节数与 SHA-256；对脱敏文档另记脱敏前的 `source_sha256` 与 `source_bytes`。新仓库的**当前执行入口**是[根 TODO](../../TODO.md)，战略方向见[ROADMAP](../ROADMAP.md)，当前验证见[VALIDATION](../VALIDATION.md)。归档清单中的完成状态不自动继承为新项目已完成。

## 阅读原文中的链接与状态

为保持内容哈希，原文中的相对链接没有重写，有些链接会因目录变化失效。可按以下映射查找：

- 原 `agent-trace/` → [当前 Trace](../../packages/agent-trace/README.md)
- 原 `agent-stats/` → [当前 Stats](../../packages/agent-stats/README.md)
- 原 `agent-journal/` → [当前 Journal](../../packages/agent-journal/README.md)
- 原 `agent-knowledge/` → [当前 Knowledge](../../packages/agent-knowledge/README.md)
- 原命名说明 → [当前命名规则](../NAMING.md)
- 原工作区顶层 TODO → 上表中的工作区 TODO 快照
- `journal-spike`、个人配置、真实库与日报等不在本次归档范围；不能把缺失文件或旧源码行号当作当前证据。

历史内容包含原机器的路径、来源身份、运行规模、模型调用和部署记录，可能有过时或相互矛盾的说法。**本仓库公开前已完成隐私复核**：凭证、个人主目录路径与个人邮箱已移除；其余运行与部署记录作为历史背景保留。本次没有复制凭证文件、生产数据库或真实会话，也没有依据旧文档安装、接管或重启任何服务。

若需修正历史结论，应更新当前 TODO 或新增日期明确的复核记录，不覆盖这些原文快照。可在迁移现场执行 `npm run verify:originals`，同时核对原模块与这三份原文（脱敏文档分别核对原文与归档哈希）。
