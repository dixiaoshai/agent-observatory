import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

from .core import Store
from .server import make_server
from .content import ContentReader, default_content_config
from .knowledge import KnowledgeReader


def default_sources():
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    return [str(home / "sessions"), str(home / "archived_sessions")]


def default_db():
    return os.environ.get("AGENT_STATS_DB", str(Path.home() / ".local/share/agent-stats/stats.sqlite3"))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agent-stats", description="Agent Stats · 本机 agent 用量看板（Codex / pi / dsh）")
    parser.add_argument("--db", default=None, help="SQLite 路径（也可放在 follow 子命令之后）")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("import", "serve"):
        sub = commands.add_parser(command)
        sub.add_argument("--source", action="append", help="JSONL 文件或目录，可重复；默认 CODEX_HOME 下的 sessions 与 archived_sessions")
        sub.add_argument("--instance", default="local", help="来源实例命名空间；不同设备使用不同值")
        if command == "serve":
            sub.add_argument("--port", type=int, default=8765)
            sub.add_argument("--journal-dir", help="显式指定只读 Journal 正式日报目录；默认禁用")
            sub.add_argument('--knowledge-config', help='显式启用 Knowledge 页面，指定 Agent Knowledge 配置')
            sub.add_argument('--knowledge-bin', help='指定受信任的 Agent Knowledge CLI 可执行文件路径；默认从 PATH 查找')
            sub.add_argument("--archive-only", "--no-import", dest="archive_only", action="store_true",
                             help="只消费已接收的归档数据：启动和页面刷新都不读取 Codex 源日志")
            content = sub.add_mutually_exclusive_group()
            content.add_argument('--content-config', help='任务详情只读的 Agent Trace content 配置；默认发现本机 content.json')
            content.add_argument('--no-content', action='store_true', help='关闭任务详情的正文读取')
    summary = commands.add_parser("summary")
    for key in ("start", "end", "project", "model", "source"):
        summary.add_argument("--" + key)
    for name in ("serve", "summary"):
        commands.choices[name].add_argument("--native-workspaces", action="store_true",
                                            help="仅对受信任本机归档，读取本机 Agent 元数据以显示原生工作区名")
    archive = commands.add_parser("import-archive", help="消费共享归档的 metadata JSON 批次，不读取原始日志")
    archive.add_argument("--input", required=True, help="agent-trace export --view metadata 的输出文件")
    custom = commands.add_parser("import-json", help="导入自定义规范化会话 JSON")
    custom.add_argument("--input", required=True, help="自定义来源 JSON 文件")
    follow = commands.add_parser("follow", help="跟随 agent-trace 本机 API 自动拉取 metadata")
    follow.add_argument("--config", required=True, help="agent-stats.follow.json 路径")
    follow.add_argument("--db", dest="follow_db", default=None, help="显式覆盖配置中的目标数据库")
    check = commands.add_parser("config-check", help="只校验 follow 配置：不建库、不联网、不回显 token")
    check.add_argument("--config", required=True, help="agent-stats.follow.json 路径")
    check.add_argument("--db", dest="follow_db", default=None, help="显式覆盖配置中的目标数据库")
    example = commands.add_parser("example", help="导出随包提供的合成自定义来源 JSON（不建库）")
    example.add_argument("--output", required=True, help="新的输出文件路径，拒绝覆盖")
    demo = commands.add_parser("demo", help="向指定目录生成纯合成 Codex 事件")
    demo.add_argument("--output", default=".agent-stats/demo")
    args = parser.parse_args(argv)
    if args.command == 'serve' and args.knowledge_bin and not args.knowledge_config:
        parser.error('--knowledge-bin 需要同时指定 --knowledge-config')
    if args.command == "example":
        from importlib import resources
        try:
            data = resources.files("agent_stats").joinpath("examples", "custom-source.json").read_bytes()
            with open(args.output, "xb") as stream:
                stream.write(data)
        except OSError as exc:
            print("Agent Stats: %s" % exc, file=sys.stderr)
            return 1
        print(json.dumps({"output": args.output}, ensure_ascii=False))
        return 0
    if args.command == "demo":
        from .demo import generate
        print(json.dumps(generate(Path(args.output)), ensure_ascii=False))
        return 0
    if args.command == "config-check":
        from .follow import FollowError, describe_config
        try:
            projection = describe_config(args.config, db_override=args.follow_db or args.db)
        except FollowError as exc:
            print(json.dumps({"error": {"code": exc.code, "class": exc.klass, "message": exc.message}},
                             ensure_ascii=False), file=sys.stderr)
            return 1
        print(json.dumps(projection, ensure_ascii=False, indent=2))
        return 0
    if args.command == "follow":
        from .follow import run_follow
        return run_follow(args.config, db_override=args.follow_db or args.db)
    try:
        db = Path(args.db or default_db()).expanduser()
        db.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        store = Store(db, native_workspaces=getattr(args, 'native_workspaces', False))
        if args.command == "summary":
            print(json.dumps(store.query({k: getattr(args, k) for k in ("start", "end", "project", "model", "source") if getattr(args, k)}), ensure_ascii=False, indent=2))
        elif args.command == "import-json":
            from .sources import import_document
            with open(args.input, encoding="utf-8") as stream:
                document = json.load(stream)
            print(json.dumps(import_document(store, document), ensure_ascii=False))
        elif args.command == "import-archive":
            from .archive import import_batch
            with open(args.input, encoding="utf-8") as stream:
                batch = json.load(stream)
            print(json.dumps(import_batch(store, batch), ensure_ascii=False))
        elif args.command == "import":
            print(json.dumps(store.import_paths(args.source or default_sources(), instance=args.instance), ensure_ascii=False, indent=2))
        else:
            paths = args.source or default_sources()
            # Archive-only mode never opens Codex logs: no startup import and no
            # source refresh. The dashboard only reads already-received data.
            if not args.archive_only:
                print(json.dumps(store.import_paths(paths, instance=args.instance), ensure_ascii=False))
            content_path = None if args.no_content else args.content_config or default_content_config()
            server = make_server(store, paths, args.port, args.instance, archive_only=args.archive_only,
                                 content_reader=ContentReader(content_path), journal_dir=args.journal_dir,
                                 knowledge_reader=KnowledgeReader(args.knowledge_config, args.knowledge_bin))
            print("Agent Stats: http://127.0.0.1:%s · Ctrl+C 停止" % server.server_port, flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        print("Agent Stats: %s" % exc, file=sys.stderr)
        return 1
