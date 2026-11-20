# 独立来源与适配器

本地文档索引不依赖 Trace。按[运行指南](RUNNING.md)配置源目录并执行 `sync`、`search`、`read` 即可。默认 CLI 使用内置文件扫描器；配置中的路径以配置文件所在目录为基准，来源项目必须被允许。扫描器会检查根目录、避免符号链接，并应用敏感命名、忽略规则、扩展名和大小限制，细节见运行指南。

## 程序化扫描器

包入口导出 `openApplication(configPath, { scanner })`、`AgentKnowledge`、应用配置以及存储和扫描端口、`scanSource`、`SqliteStore`、核心类型和 `contentHash`。可选的 `scanner` 默认使用 `scanSource`，保持既有调用方可用。

### 已安装包（不在源码仓库）

把包安装到可写项目后，可直接运行随包提供的合成示例。它使用包内已构建的 JavaScript，并自行创建和删除临时数据库：

```sh
node node_modules/agent-knowledge/examples/memory-scanner.mjs
```

要使用随包的文件系统示例，请把配置**和**合成文档一并复制到自己的可写目录。数据库和源根目录都相对复制后的配置解析；绝不要把可写状态指向 `node_modules`：

```sh
mkdir -p ./knowledge-demo
cp node_modules/agent-knowledge/agent-knowledge.example.json ./knowledge-demo/config.json
cp -R node_modules/agent-knowledge/fixtures ./knowledge-demo/fixtures
./node_modules/.bin/agent-knowledge sync --source demo --config ./knowledge-demo/config.json
./node_modules/.bin/agent-knowledge search --query "刷新令牌" --project demo --config ./knowledge-demo/config.json
```

若要使用自己的文档，请修改复制后配置中的 `sources[].root`、`project_id` 和 `allowed_project_ids`；`root` 相对配置文件解析，且目录必须已存在。只复制配置而不复制 fixtures 目录时，需要先修改它的 `root`。

### 在源码仓库中

在本包源码目录中，先安装开发依赖并构建，再运行同一个示例：

```sh
npm ci
npm run build
node examples/memory-scanner.mjs
```

源码测试使用模块内的合成归档页；完整的 Trace 生产者到 Knowledge 的集成由 monorepo 的 `verify:consumers` / `verify:follow` 命令单独覆盖。

### 扫描器契约

扫描器不使用 Trace 服务或归档信封。`SourceScanner` 接收配置好的 `SourceDefinition` 并返回完整快照：`files` 中每项包含源相对 `path`、UTF-8 `content`、SHA-256 `content_hash` 和 `git_commit`（或 `null`），另有 `skipped` 条目。

- 使用稳定、唯一且与内容匹配的路径和哈希。
- 同步时缺失的文件按已删除处理；扫描失败应抛出错误，而不是返回不完整快照。
- 搜索和读取会重新扫描以校验新鲜度，因此扫描器必须一致地返回当前快照。
- 每次新的同步使用新的 request key；重放同一 key 返回原始结果。

自定义扫描器是**受信任的应用代码**，不是沙箱：它自己负责输入授权和文件系统安全。内置扫描器的根目录、符号链接、忽略和敏感文件检查不会自动应用到自定义扫描器。文件系统适配器必须自行执行配置的源根目录和等价安全规则；该 API 不授予读取任意路径的权限。应用层的来源/项目/owner 检查以及既有的来源绑定检查仍然生效。配置和本地数据库属于本机用户的信任边界，不是多用户认证。

`FollowSource` 只抽象既有 Trace v1 content follow 协议的传输层，不会把 follow 变成通用来源协议。独立扫描器接口与 follow 相互独立。
