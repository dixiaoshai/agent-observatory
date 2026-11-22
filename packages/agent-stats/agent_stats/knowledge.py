"""Opt-in bridge to the installed Agent Knowledge CLI, not its storage."""
import json
import os
import re
import selectors
import subprocess
import threading
import time
from pathlib import Path, PurePosixPath, PureWindowsPath


_RESULT_LIMIT = 10
_TIMEOUT = 20
_MAX_OUTPUT_BYTES = 2 * 1024 * 1024


class KnowledgeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _input_text(value, maximum):
    if not isinstance(value, str):
        raise ValueError
    value = value.strip()
    if not value or '\x00' in value or len(value.encode('utf-16-le')) > maximum * 2:
        raise ValueError
    return value


def _project_record(record, *, provenance=False):
    if record['kind'] != 'knowledge' or record['schema_version'] != 1:
        raise ValueError
    ref, = record['source_refs']
    item = {key: record[key] for key in ('id', 'project_id', 'content')}
    item.update({key: ref[key] for key in ('source_id', 'path', 'start_line', 'end_line')})
    if provenance:
        item.update({key: ref[key] for key in ('source_version_id', 'content_hash', 'git_commit')})
        if not re.fullmatch(r'[0-9a-f]{64}', item['content_hash']):
            raise ValueError
        commit = item['git_commit']
        if commit is not None and not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', commit):
            raise ValueError
    text_keys = ('id', 'project_id', 'content', 'source_id', 'path')
    if provenance:
        text_keys += ('source_version_id',)
    for key in text_keys:
        if not isinstance(item[key], str) or not item[key].encode('utf-8'):
            raise ValueError
    path = PurePosixPath(item['path'])
    windows_path = PureWindowsPath(item['path'])
    if path.is_absolute() or windows_path.anchor or '..' in path.parts or '..' in windows_path.parts:
        raise ValueError
    start, end = item['start_line'], item['end_line']
    if type(start) is not int or type(end) is not int or not 1 <= start <= end:
        raise ValueError
    return item


def _project_results(data):
    results = data['results']
    if not isinstance(results, list) or len(results) > _RESULT_LIMIT:
        raise ValueError
    return {'results': [_project_record(hit['record']) for hit in results]}


def _run_cli(argv):
    """Drain both CLI pipes under a shared byte limit and wall-clock deadline."""
    deadline = time.monotonic() + _TIMEOUT
    output = [bytearray(), bytearray()]
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, 0)
                selector.register(process.stderr, selectors.EVENT_READ, 1)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    events = selector.select(remaining) if remaining > 0 else []
                    if not events:
                        raise subprocess.TimeoutExpired(argv, _TIMEOUT)
                    for key, _ in events:
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        if len(output[0]) + len(output[1]) + len(chunk) > _MAX_OUTPUT_BYTES:
                            raise KnowledgeError(502, 'Knowledge 返回内容过大，请缩小搜索范围')
                        output[key.data].extend(chunk)
            returncode = process.wait(timeout=max(0, deadline - time.monotonic()))
            return subprocess.CompletedProcess(argv, returncode, *output)
        finally:
            if process.poll() is None:
                process.kill()


class KnowledgeReader:
    def __init__(self, config=None, executable=None):
        self.config = str(Path(config).expanduser().absolute()) if config else None
        self.executable = str(Path(executable).expanduser().absolute()) if executable else 'agent-knowledge'
        self._busy = threading.Lock()

    @property
    def enabled(self):
        return self.config is not None

    def search(self, payload):
        if not self.enabled:
            raise KnowledgeError(503, '未配置 Agent Knowledge')
        try:
            if not isinstance(payload, dict) or payload.keys() - {'query', 'project'}:
                raise ValueError
            query = _input_text(payload.get('query'), 256)
            project = _input_text(payload['project'], 200) if 'project' in payload else None
        except ValueError:
            raise KnowledgeError(400, '请输入有效的搜索词（最多 256 字符）和可选项目 ID') from None

        options = ['--query=' + query, '--limit=' + str(_RESULT_LIMIT)]
        if project is not None:
            options.append('--project=' + project)
        return self._invoke('search', options, _project_results)

    def read(self, payload):
        if not self.enabled:
            raise KnowledgeError(503, '未配置 Agent Knowledge')
        try:
            if not isinstance(payload, dict) or payload.keys() != {'id', 'project'}:
                raise ValueError
            identity = _input_text(payload['id'], 200)
            project = _input_text(payload['project'], 200)
        except ValueError:
            raise KnowledgeError(400, '需要有效的 Knowledge 记录 ID 和项目 ID') from None

        def project_detail(data):
            record = _project_record(data['record'], provenance=True)
            if (record['id'], record['project_id']) != (identity, project):
                raise ValueError
            return {'record': record}

        return self._invoke('read', ['--id=' + identity, '--project=' + project], project_detail)

    def _invoke(self, command, options, project_response):
        # Only fixed operations and flags reach the CLI. Equals-form keeps even
        # option-like values a single argument, never a new flag or command.
        argv = [self.executable, command, '--config=' + self.config, *options]
        if not self._busy.acquire(blocking=False):
            raise KnowledgeError(429, 'Knowledge 正在处理请求，请稍后重试')
        try:
            process = _run_cli(argv)
            if process.returncode != 0:
                try:
                    code = json.loads(process.stderr)['error']['code']
                except (ValueError, KeyError, TypeError):
                    code = None
                if code == 'FORBIDDEN':
                    raise KnowledgeError(403, '项目不在 Knowledge 配置允许的范围内')
                if code == 'NOT_FOUND' and command == 'read':
                    raise KnowledgeError(404, '原文已变更、不可访问或记录已删除；请同步来源后重新搜索')
                if code == 'INVALID_INPUT':
                    raise KnowledgeError(400, '无效的 Knowledge 请求参数')
                raise KnowledgeError(502, 'Knowledge 查询失败，请检查 CLI、配置和来源权限')
            return project_response(json.loads(process.stdout))
        except subprocess.TimeoutExpired:
            raise KnowledgeError(504, 'Knowledge 查询超时，请稍后重试') from None
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            raise KnowledgeError(502, '无法读取 Knowledge 搜索结果，请检查 CLI 和配置') from None
        finally:
            self._busy.release()
