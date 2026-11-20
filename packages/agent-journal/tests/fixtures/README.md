# 合成 Trace 协议 fixtures

`protocol/` 保存 monorepo 中 `agent-trace/fixtures/protocol/` 的合成 JSON 协议样例与 manifest 的逐字节副本，不包含任何真实用户会话。保留该副本后，无需 Trace 包也能运行完整的 Journal 测试套件。缺少 fixtures 视为测试失败，不能当作跳过后的成功。

Trace 协议 fixtures 变更时，应有意识地比较并更新这份副本，然后运行 Journal 套件和跨模块协议测试。原始生成器属于 Trace，运行 Journal 测试不需要它。
