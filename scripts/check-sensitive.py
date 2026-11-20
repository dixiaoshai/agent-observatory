#!/usr/bin/env python3
"""Scan tracked files (or a pre-Git source tree), including archived text.

Credential findings fail. Personal home paths warn, or fail with --strict-privacy.
No matched content is printed. Exceptions are exact synthetic values and paths.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

RULES = [
    ("github token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b")),
    ("api key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b")),
    ("aws access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("google api key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("slack token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("private key", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("url credentials", re.compile(r"https?://[^\s/:@]+:[^\s/@]+@[A-Za-z0-9.-]+")),
]
HOME_PATH = re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+/")
SENSITIVE_NAME = re.compile(r"(^|/)(?:\.env(?:\..+)?|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|sqlite3?|db))$")
GENERATED = {'.git', 'node_modules', '.cache', 'dist', 'build', 'artifacts', '.venv', '__pycache__', 'coverage', '.agent-trace', '.agent-stats', '.agent-journal', '.knowrelay'}
MAX_BYTES = 2 * 1024 * 1024
BINARY_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.pdf', '.zip', '.gz', '.zstd'}
# Only exact documented synthetic values may be exempted, never a whole directory.
SYNTHETIC = {
    # Intentional rejected URL in config tests and documentation placeholder.
    ('packages/agent-journal/tests/config.test.ts', 'url credentials'): {'http://' + 'user:pass@127.0.0.1'},
    ('packages/agent-trace/docs/content-capture.md', 'url credentials'): {'https://' + 'user:password@host'},
    # Deliberately fake redaction-test token; no blanket fixture exemptions.
    ('packages/agent-trace/tests/content.test.ts', 'github token'): {'ghp_' + 'synthetic' + '0' * 24},
}
SYNTHETIC_HOME = {
    'packages/agent-journal/tests/projection.test.ts': {'/' + 'Users/example/'},
    'packages/agent-trace/tests/pi.test.ts': {'/' + 'home/user/'},
    'packages/agent-trace/tests/titles.test.ts': {'/' + 'home/u/'},
}


def files(root, all_files=False):
    if (root / '.git').exists() and not all_files:
        output = subprocess.check_output(['git', 'ls-files', '-z', '--cached'], cwd=root)
        return [root / os.fsdecode(item) for item in output.split(b'\0') if item]
    result = []
    for base, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in GENERATED and not d.endswith('.egg-info'))
        result.extend(Path(base) / name for name in sorted(names) if not name.endswith(('.pyc', '.pyo')) and name != '.DS_Store')
    return result


def scan(root, all_files=False):
    root = Path(root).resolve()
    errors, warnings = [], []
    paths = files(root, all_files)
    for path in paths:
        name = path.relative_to(root).as_posix()
        if path.is_symlink() and not path.resolve().is_relative_to(root):
            errors.append((name, 0, 'symlink escapes source root'))
            continue
        if SENSITIVE_NAME.search(name) and path.name != '.env.example':
            errors.append((name, 0, 'sensitive filename'))
        try:
            if path.stat().st_size > MAX_BYTES:
                errors.append((name, 0, 'file exceeds scan limit; review explicitly'))
                continue
            data = path.read_bytes()
        except OSError:
            errors.append((name, 0, 'unreadable tracked/source file'))
            continue
        if b'\0' in data:
            if path.suffix.lower() in BINARY_EXTENSIONS:
                continue
            errors.append((name, 0, 'NUL byte in text/source file'))
            # Still scan the contents: an embedded NUL must not hide a key.
        for number, line in enumerate(data.decode('utf-8', 'replace').splitlines(), 1):
            for label, pattern in RULES:
                for match in pattern.finditer(line):
                    if match.group() not in SYNTHETIC.get((name, label), set()):
                        errors.append((name, number, label))
            if any(match.group() not in SYNTHETIC_HOME.get(name, set()) for match in HOME_PATH.finditer(line)):
                warnings.append((name, number, 'personal home path; review before publication'))
    return len(paths), errors, warnings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--all-files', action='store_true', help='scan source files even before staging')
    parser.add_argument('--strict-privacy', action='store_true', help='also fail on personal home paths')
    args = parser.parse_args(argv)
    count, errors, warnings = scan(args.root, args.all_files)
    for severity, findings in (('ERROR', errors), ('PRIVACY', warnings)):
        for name, line, rule in findings:
            print('{} {}:{}: {}'.format(severity, name, line, rule))
    print('sensitive scan: {} files, {} blocking findings, {} privacy warnings'.format(count, len(errors), len(warnings)))
    return int(bool(errors or (args.strict_privacy and warnings)))


if __name__ == '__main__':
    sys.exit(main())
