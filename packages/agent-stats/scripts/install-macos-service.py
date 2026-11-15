#!/usr/bin/env python3
"""Plan isolated Agent Observatory launch agents; --apply is required to mutate.

Default installs only the archive-only dashboard, with no Trace content access.
--with-trace additionally requires isolated Trace and follow configuration.
Nothing is installed or removed without an explicit --apply. --dry-run only
prints a redacted plan; it never checks credentials or contacts launchd.
"""
import argparse
import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

PREFIX = 'local.agent-observatory.'
DASHBOARD = PREFIX + 'agent-stats'
TRACE = PREFIX + 'agent-trace'
FOLLOW = PREFIX + 'agent-stats-follow'


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--apply', action='store_true', help='explicitly permit installing or uninstalling isolated jobs')
    result.add_argument('--dry-run', action='store_true', help='print a redacted plan without any side effects')
    result.add_argument('--uninstall', action='store_true', help='remove only the three Observatory-labelled jobs')
    result.add_argument('--with-trace', action='store_true', help='also install isolated Trace and follow (requires configs and token)')
    result.add_argument('--port', type=int, default=18765, help='isolated dashboard port (default 18765)')
    return result


def make_plan(home, root, args):
    state = home / '.local/share/agent-observatory'
    agents = home / 'Library/LaunchAgents'
    stats = state / 'agent-stats'
    trace = state / 'agent-trace'
    labels = [DASHBOARD, TRACE, FOLLOW] if args.uninstall or args.with_trace else [DASHBOARD]
    return {'operation': 'uninstall' if args.uninstall else 'install', 'labels': labels,
            'plists': {label: str(agents / (label + '.plist')) for label in labels},
            'state': str(state), 'stats_state': str(stats), 'trace_state': str(trace),
            'database': str(stats / 'stats.sqlite3'), 'port': args.port,
            'trace_config': str(trace / 'service.json'), 'follow_config': str(trace / 'stats.follow.json'),
            'token_file': str(trace / 'stats.token'),
            'trace_cli': str(root.parent / 'agent-trace/src/cli.ts')}


def check_platform_tools():
    for binary in ('/bin/launchctl', '/usr/bin/plutil'):
        if not os.path.isfile(binary) or not os.access(binary, os.X_OK):
            raise ValueError('Required macOS executable is unavailable: ' + binary)


def safe_managed_path(target, directory=False):
    """Inspect existing components without following user-controlled symlinks."""
    target = Path(os.path.abspath(target))
    current = Path(target.anchor)
    parts = target.parts[1:]
    for index, part in enumerate(parts):
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            return
        if stat.S_ISLNK(mode):
            # macOS system aliases; do not whitelist arbitrary intermediate links.
            if index == 0 and part in ('var', 'tmp', 'etc') and os.path.realpath(current) == '/private/' + part:
                continue
            raise ValueError('Refusing symlink in managed path: ' + str(current))
        expect_directory = index < len(parts) - 1 or directory
        if not (stat.S_ISDIR(mode) if expect_directory else stat.S_ISREG(mode)):
            raise ValueError('Unexpected type in managed path: ' + str(current))


def preflight_managed_paths(plan, with_trace):
    safe_managed_path(plan['state'], directory=True)
    safe_managed_path(plan['stats_state'], directory=True)
    safe_managed_path(plan['trace_state'], directory=True)
    for filename in plan['plists'].values():
        target = Path(filename)
        safe_managed_path(target, directory=False)
        pending = target.with_suffix('.plist.pending')
        safe_managed_path(pending, directory=False)
        if pending.exists():
            raise ValueError('Pending plist already exists: ' + str(pending))
    if plan['operation'] == 'install':
        stats = Path(plan['stats_state'])
        for name in ('stats.sqlite3', 'server.stderr.log', 'follow.log', 'follow.stderr.log'):
            safe_managed_path(stats / name)
        if with_trace:
            trace = Path(plan['trace_state'])
            for name in ('service.json', 'stats.follow.json', 'stats.token', 'trace.sqlite', 'trace.log', 'trace.err'):
                safe_managed_path(trace / name)


def validate_plan(plan, root, with_trace):
    """Read-only preflight of *all* selected jobs before any state mutation."""
    if not (root / 'agent_stats/__init__.py').is_file():
        raise ValueError('Stats source package is missing')
    for label, filename in plan['plists'].items():
        target = Path(filename)
        if target.with_suffix('.plist.pending').exists() or target.with_suffix('.plist.pending').is_symlink():
            raise ValueError('Pending plist already exists: ' + filename)
        if target.is_symlink():
            raise ValueError('Refusing symlink plist: ' + filename)
        if target.exists():
            try:
                with target.open('rb') as stream:
                    existing = plistlib.load(stream)
            except (OSError, ValueError, plistlib.InvalidFileException) as exc:
                raise ValueError('Invalid existing plist: ' + filename) from exc
            if not isinstance(existing, dict) or existing.get('Label') != label:
                raise ValueError('Existing plist label mismatch: ' + filename)
    if not with_trace:
        return None
    node = shutil.which('node')
    cli = Path(plan['trace_cli'])
    service = Path(plan['trace_config'])
    follow = Path(plan['follow_config'])
    token_file = Path(plan['token_file'])
    if not node or not cli.is_file() or not service.is_file() or not follow.is_file() or not token_file.is_file():
        raise ValueError('Isolated Trace CLI, node, service.json, stats.follow.json and stats.token are required')
    if token_file.is_symlink() or token_file.stat().st_mode & 0o077:
        raise ValueError('Token file must be a non-symlink with mode 0600 or stricter')
    token = token_file.read_text(encoding='utf-8')
    if not token or token != token.strip():
        raise ValueError('Token must be nonempty and have no surrounding whitespace')
    # Existing parsers validate the same configs used by the jobs; never log token.
    sys.path.insert(0, str(root))
    from agent_stats.follow import FollowError, load_config
    try:
        config = load_config(follow)
    except FollowError as exc:
        raise ValueError('Invalid follow config: ' + exc.message) from exc
    if config.database.resolve() != Path(plan['database']).resolve():
        raise ValueError('Follow database must equal the isolated dashboard database')
    trace_db = str(Path(plan['trace_state']) / 'trace.sqlite')
    result = subprocess.run([node, '--experimental-strip-types', str(cli), 'config-check', '--config', str(service), '--db', trace_db],
                            capture_output=True, text=True)
    if result.returncode:
        raise ValueError('Trace config-check failed; verify isolated service config')
    try:
        summary = json.loads(result.stdout)
        api = summary['api']
        if (summary['capture_mode'] != 'metadata' or not api['enabled']
                or config.trace_url != 'http://%s:%s' % (api['host'], api['port'])):
            raise ValueError('Trace metadata API must be enabled and match the follow URL')
        import hashlib
        raw = json.loads(service.read_text(encoding='utf-8'))
        digest = hashlib.sha256(token.encode()).hexdigest()
        if not any(client.get('token_sha256') == digest and 'metadata' in client.get('views', [])
                   for client in raw.get('api', {}).get('clients', [])):
            raise ValueError('Trace API must authorize the supplied token for metadata')
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError('Invalid Trace config-check output') from exc
    return {'node': node, 'token': token, 'token_env': config.token_env, 'trace_db': trace_db}


def loaded(domain, label):
    return subprocess.run(['/bin/launchctl', 'print', domain + '/' + label],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def stop(domain, label):
    if loaded(domain, label):
        subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], check=True)
        for _ in range(50):
            if not loaded(domain, label):
                return
            time.sleep(0.1)
        raise RuntimeError('launchctl did not stop ' + label)


def install(label, config, target):
    domain = 'gui/%d' % os.getuid()
    pending = target.with_suffix('.plist.pending')
    # Refuse symlink/pending collisions rather than clobber unrelated files.
    with pending.open('xb') as stream:
        plistlib.dump(config, stream)
    try:
        pending.chmod(0o600)
        subprocess.run(['/usr/bin/plutil', '-lint', str(pending)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stop(domain, label)
        pending.replace(target)
        subprocess.run(['/bin/launchctl', 'enable', domain + '/' + label], check=True)
        for _ in range(20):
            result = subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(target)], capture_output=True, text=True)
            if result.returncode == 0 or loaded(domain, label):
                return
            time.sleep(0.25)
        raise RuntimeError('launchctl bootstrap failed for ' + label)
    finally:
        if pending.exists():
            pending.unlink()


def job(label, args, cwd, environment, stdout, stderr):
    return {'Label': label, 'ProgramArguments': args, 'WorkingDirectory': str(cwd),
            'EnvironmentVariables': environment, 'RunAtLoad': True, 'KeepAlive': True,
            'ThrottleInterval': 30, 'ProcessType': 'Background',
            'StandardOutPath': str(stdout), 'StandardErrorPath': str(stderr)}


def main(argv=None):
    args = parser().parse_args(argv)
    if not 1 <= args.port <= 65535:
        raise SystemExit('port must be between 1 and 65535')
    if args.uninstall and args.with_trace:
        raise SystemExit('--uninstall already targets all isolated jobs; do not combine with --with-trace')
    root = Path(__file__).resolve().parents[1]
    plan = make_plan(Path.home(), root, args)
    if args.dry_run:
        print(json.dumps(plan, indent=2))
        return 0
    if not args.apply:
        raise SystemExit('Refusing to change services: supply --apply (or use --dry-run)')
    if sys.platform != 'darwin':
        raise SystemExit('This installer requires macOS')
    try:
        preflight_managed_paths(plan, args.with_trace and not args.uninstall)
        check_platform_tools()
        dependencies = validate_plan(plan, root, args.with_trace and not args.uninstall)
        domain = 'gui/%d' % os.getuid()
        if args.uninstall:
            for label in plan['labels']:
                stop(domain, label)
                target = Path(plan['plists'][label])
                if target.exists():
                    target.unlink()
            print('Removed isolated Observatory jobs; databases and logs are untouched.')
            return 0
        stats = Path(plan['stats_state'])
        trace_state = Path(plan['trace_state'])
        stats.mkdir(parents=True, exist_ok=True, mode=0o700)
        Path(plan['plists'][DASHBOARD]).parent.mkdir(parents=True, exist_ok=True)
        for name in ('server.stderr.log', 'follow.log', 'follow.stderr.log'):
            (stats / name).touch(mode=0o600, exist_ok=True)
        dashboard = job(DASHBOARD, [sys.executable, '-u', '-m', 'agent_stats', '--db', plan['database'],
                                    'serve', '--archive-only', '--no-content', '--port', str(args.port)],
                        root, {'PYTHONDONTWRITEBYTECODE': '1'}, '/dev/null', stats / 'server.stderr.log')
        jobs = [(DASHBOARD, dashboard)]
        if dependencies:
            trace = job(TRACE, [dependencies['node'], '--experimental-strip-types', plan['trace_cli'], 'serve',
                                '--config', plan['trace_config'], '--db', dependencies['trace_db']], trace_state, {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'},
                        trace_state / 'trace.log', trace_state / 'trace.err')
            follow = job(FOLLOW, [sys.executable, '-u', '-m', 'agent_stats', 'follow', '--config', plan['follow_config']],
                         root, {'PYTHONDONTWRITEBYTECODE': '1', dependencies['token_env']: dependencies['token']},
                         stats / 'follow.log', stats / 'follow.stderr.log')
            jobs = [(TRACE, trace), (FOLLOW, follow), (DASHBOARD, dashboard)]
        for label, config in jobs:
            install(label, config, Path(plan['plists'][label]))
        print('Installed isolated Observatory dashboard: http://127.0.0.1:%d/' % args.port)
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        raise SystemExit(str(exc))


if __name__ == '__main__':
    sys.exit(main())
