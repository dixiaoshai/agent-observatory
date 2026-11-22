import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_stats.knowledge import KnowledgeError, KnowledgeReader, _run_cli
from agent_stats.server import make_server


def completed(results=None, error=None, record=None):
    payload = {'results': results} if record is None else {'record': record}
    return subprocess.CompletedProcess([], int(error is not None), json.dumps(payload).encode(),
                                       json.dumps({'error': error}).encode())


def hit(path='docs/note.md'):
    return {'score': 1, 'record': {
        'schema_version': 1, 'kind': 'knowledge', 'id': 'record-a', 'owner_id': 'uid:1',
        'project_id': 'demo', 'content': '<script>synthetic</script>\n',
        'source_refs': [{'source_id': 'docs', 'path': path, 'content_hash': 'a' * 64,
                         'source_version_id': 'version-a', 'git_commit': None,
                         'start_line': 2, 'end_line': 2}],
    }}


class ReaderTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = str(Path(directory.name) / 'config.json')
        self.reader = KnowledgeReader(self.config)

    @patch('agent_stats.knowledge._run_cli')
    def test_fixed_argv_and_minimal_response(self, run):
        run.return_value = completed([hit()])
        self.assertEqual(self.reader.search({'query': ' --help ', 'project': '--config=other'}), {'results': [{
            'id': 'record-a', 'project_id': 'demo', 'content': '<script>synthetic</script>\n',
            'source_id': 'docs', 'path': 'docs/note.md', 'start_line': 2, 'end_line': 2,
        }]})
        run.assert_called_once_with(['agent-knowledge', 'search', '--config=' + self.config,
                                     '--query=--help', '--limit=10', '--project=--config=other'])

    @patch('agent_stats.knowledge._run_cli')
    def test_fails_without_accepting_cli_options_from_request(self, run):
        for payload in ([], {'query': ' '}, {'query': 'test\x00'}, {'query': '😀' * 129},
                        {'query': 'test', 'project': None}, {'query': 'test', 'config': 'other'}):
            with self.subTest(payload=payload), self.assertRaises(KnowledgeError) as raised:
                self.reader.search(payload)
            self.assertEqual(raised.exception.status, 400)
        run.assert_not_called()

    @patch('agent_stats.knowledge._run_cli')
    def test_maps_errors_without_forwarding_details(self, run):
        for error, status in (('FORBIDDEN', 403), ('INVALID_INPUT', 400), ('ERROR', 502)):
            run.return_value = completed(error={'code': error, 'message': 'private details'})
            with self.assertRaises(KnowledgeError) as raised:
                self.reader.search({'query': 'test'})
            self.assertEqual(raised.exception.status, status)
            self.assertNotIn('private details', str(raised.exception))
        run.return_value = completed([hit('../not-a-source-relative-path')])
        with self.assertRaises(KnowledgeError) as raised:
            self.reader.search({'query': 'test'})
        self.assertEqual(raised.exception.status, 502)
        run.side_effect = subprocess.TimeoutExpired('synthetic', 10)
        with self.assertRaises(KnowledgeError) as raised:
            self.reader.search({'query': 'test'})
        self.assertEqual(raised.exception.status, 504)
        run.side_effect = None
        run.return_value = completed([])
        self.assertEqual(self.reader.search({'query': 'test'}), {'results': []})


    @patch('agent_stats.knowledge._run_cli')
    def test_read_forwards_only_record_and_project_and_checks_identity(self, run):
        source = hit()['record']
        run.return_value = completed(record=source)
        result = self.reader.read({'id': 'record-a', 'project': 'demo'})['record']
        self.assertEqual(result, {
            'id': 'record-a', 'project_id': 'demo', 'content': source['content'],
            'source_id': 'docs', 'path': 'docs/note.md', 'start_line': 2, 'end_line': 2,
            'source_version_id': 'version-a', 'content_hash': 'a' * 64, 'git_commit': None,
        })
        run.assert_called_once_with(['agent-knowledge', 'read', '--config=' + self.config,
                                     '--id=record-a', '--project=demo'])
        with self.assertRaises(KnowledgeError) as raised:
            self.reader.read({'id': 'different-id', 'project': 'demo'})
        self.assertEqual(raised.exception.status, 502)

    @patch('agent_stats.knowledge._run_cli')
    def test_read_rejects_paths_and_missing_project(self, run):
        for payload in ({'id': 'record-a'}, {'id': 'record-a', 'project': 'demo', 'path': 'docs/note.md'}):
            with self.subTest(payload=payload), self.assertRaises(KnowledgeError) as raised:
                self.reader.read(payload)
            self.assertEqual(raised.exception.status, 400)
        run.assert_not_called()


class ProcessTests(unittest.TestCase):
    def test_drains_stdout_and_stderr_and_stops_on_overflow(self):
        result = _run_cli([sys.executable, '-c', 'import sys; print("ok"); print("error", file=sys.stderr)'])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'ok\n', b'error\n'))
        for descriptor in (1, 2):
            with self.subTest(descriptor=descriptor), patch('agent_stats.knowledge._MAX_OUTPUT_BYTES', 32):
                with self.assertRaises(KnowledgeError) as raised:
                    _run_cli([sys.executable, '-c', 'import os; os.write(%s, b"x" * 128)' % descriptor])
                self.assertEqual(raised.exception.status, 502)


class KnowledgeHTTPTests(unittest.TestCase):
    def serve(self, reader=None):
        server = make_server(None, [], 0, archive_only=True, knowledge_reader=reader)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:%s' % server.server_port

    def request(self, base, path, body=None, headers=None):
        try:
            response = urlopen(Request(base + path, data=body, headers=headers or {}), timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            return response.code, json.load(response)

    def test_integration_is_disabled_by_default(self):
        base = self.serve()
        self.assertEqual(self.request(base, '/api/knowledge/status'), (200, {'enabled': False}))
        self.assertEqual(self.request(base, '/api/knowledge/search', b'{"query":"test"}',
                                      {'Content-Type': 'application/json'})[0], 503)

    @patch('agent_stats.knowledge._run_cli', return_value=completed([hit()]))
    def test_loopback_search_validation_and_results(self, run):
        with tempfile.TemporaryDirectory() as directory:
            base = self.serve(KnowledgeReader(Path(directory) / 'config.json'))
            search = '/api/knowledge/search'
            headers = {'Content-Type': 'application/json'}
            self.assertEqual(self.request(base, '/api/knowledge/status'), (200, {'enabled': True}))
            self.assertEqual(self.request(base, search)[0], 404)
            self.assertEqual(self.request(base, search, b'{}')[0], 415)
            self.assertEqual(self.request(base, search, b' ' * 4097, headers)[0], 413)
            self.assertEqual(self.request(base, search, b'not json', headers)[0], 400)
            self.assertEqual(self.request(base, search, b'{}', dict(headers, Origin='https://untrusted.invalid'))[0], 403)
            run.assert_not_called()
            status, data = self.request(base, search, b'{"query":"synthetic"}', headers)
            self.assertEqual(status, 200)
            self.assertEqual(data['results'][0]['path'], 'docs/note.md')
            run.assert_called_once()

    @patch('agent_stats.knowledge._run_cli')
    def test_loopback_read_returns_fresh_record_or_generic_stale_error(self, run):
        with tempfile.TemporaryDirectory() as directory:
            base = self.serve(KnowledgeReader(Path(directory) / 'config.json'))
            route = '/api/knowledge/read'
            headers = {'Content-Type': 'application/json'}
            body = b'{"id":"record-a","project":"demo"}'
            self.assertEqual(self.request(base, route, body, dict(headers, Origin='https://untrusted.invalid'))[0], 403)
            run.assert_not_called()
            run.return_value = completed(record=hit()['record'])
            status, data = self.request(base, route, body, headers)
            self.assertEqual(status, 200)
            self.assertEqual(data['record']['source_version_id'], 'version-a')
            run.return_value = completed(error={'code': 'NOT_FOUND', 'message': 'private details'})
            status, data = self.request(base, route, body, headers)
            self.assertEqual(status, 404)
            self.assertIn('重新搜索', data['error'])
            self.assertNotIn('private details', data['error'])
            self.assertNotIn('record', data)
