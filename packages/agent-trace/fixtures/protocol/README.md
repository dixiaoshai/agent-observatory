# 协议 v1 一致性 fixtures

状态：草案，尚未接入任何消费方的 CI。维护者：Agent Trace。协议参考：[`docs/PROTOCOL.md`](../../docs/PROTOCOL.md)；传输与消费方行为见 [`docs/LOCAL-API.md`](../../docs/LOCAL-API.md) 与 [消费方接入与同步](../../../../docs/TRACE-CONSUMERS.md)。

这些 fixtures 描述所有归档消费方（Agent Stats、Agent Knowledge、Agent Journal）共享的**页面契约**。它们很小且完全合成：不含真实会话内容、路径或凭据。它们的存在是为了让每个消费方用**同一组**接受 / 拒绝语料测试**自己的**校验器，而无需导入另一个消费方的代码。

## 目录结构

```text
valid/
  content-page-1.json          # 一个很小的会话：started、user、tool、usage、final
  content-deletion-page.json   # 该会话的墓碑；在游标 6 之后应用
  content-ref-page.json        # 外置 content_ref 正文（不要读取其中的路径）
  metadata-empty-page.json     # 空的 metadata 尾部；只面向 metadata 消费方
invalid/                       # 16 个页面，每个恰好包含一处契约违规
manifest.json                  # 每个 fixture 的预期结果与理由
generate.mjs                   # 唯一事实来源；修改后重新运行
```

## 消费方应如何使用

1. 加载 `manifest.json`。
2. 对每个 `valid` fixture：用全新状态喂给你的页面校验器，预期接受。对 `content-page-1.json` 之后接 `content-deletion-page.json`，预期游标从 `6` 前进到 `7`，会话证据被移除，且重放的旧页不会让它复活。
3. 对每个 `invalid` fixture：预期**永久**拒绝，游标不推进且不发生部分写入。`expected_code` 把语义失败映射到 消费方接入与同步文档中的错误码；如果你的消费方使用不同名称，可自行翻译（Knowledge 的手动导入器对所有情况都报 `INVALID_ARCHIVE`）。
4. 不要把 fixtures 导入生产存储，也不要在保留 manifest 结果的前提下把它们复制进消费方自己的测试数据。

两种传输共享同一契约：CLI `export` 文件与 HTTP `/v1/events` 页具有相同的信封、事件身份和游标语义。

## 依赖状态而非独立 fixture 的情况

- `ARCHIVE_CHANGED`：在绑定不同 `archive_id` 后喂入页面。
- `VIEW_UNAVAILABLE`：`/v1/status` 报告 `archive.capture_mode = "metadata"`。
- `PAGE_TOO_LARGE`：服务端 413；减小 `limit` 并用同一游标重试。
- `FOLLOW_LOCKED` / 租约接管：属于消费方状态，不是页面内容。

## 此处编码的身份与字段规则

- 所有事件的 `session_key = JSON.stringify([runtime, instance_id, session_id])`。
- Codex `event_id = sha256(JSON.stringify([runtime, instance_id, session_id, source.line]))`；存在 `source.series` 时加入（这些 fixtures 未使用）。
- 删除事件 `event_id = sha256(JSON.stringify([runtime, instance_id, session_id, "deleted"]))`，`source`、`body`、`raw` 为 null，`data` 为空。
- 页面内 `archive_seq` 严格递增，绝不超过 `next_cursor`，且页面总从消费方已提交游标开始。
- 用量 token 数为非负整数；缺失字段表示未知，不是零。
- `content_ref` 为 `{path: 绝对路径, bytes, sha256, media_type: "text/plain"}`。
- metadata 视图页面的 `body = raw = null`。

## 重新生成

```sh
node generate.mjs
```

生成器自行计算所有身份，并在有效页违反上述身份规则时失败。
