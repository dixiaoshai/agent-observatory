import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

from agent_stats import cli
from agent_stats.server import JOURNAL_MAX_BYTES, make_server


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def serve(self, directory=None, store=None):
        server = make_server(store, [], 0, journal_dir=directory)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:%d' % server.server_port

    def get(self, base, path):
        try:
            with urlopen(base + path, timeout=2) as response:
                return response.status, json.load(response)
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_disabled_and_date_validation(self):
        base = self.serve()
        self.assertEqual(self.get(base, '/api/journal/days'), (200, {'enabled': False, 'days': []}))
        self.assertEqual(self.get(base, '/api/journal/day?date=2024-02-29')[0], 404)
        for day in ('', '2023-02-29', '2024-2-01', '0000-01-01', '../secret'):
            self.assertEqual(self.get(base, '/api/journal/day?date=' + day)[0], 400)

    def test_reports_only_and_verbatim(self):
        (self.root / '2024-02-29.md').write_text('---\ntitle: 合成\n---\n正文\n', encoding='utf-8')
        (self.root / '2024-03-01.md').write_text('second', encoding='utf-8')
        (self.root / '2023-02-29.md').write_text('invalid')
        (self.root / '2024-03-02.md').mkdir()
        (self.root / '2024-03-03.md').symlink_to(self.root / '2024-03-01.md')
        (self.root / 'preview').mkdir()
        (self.root / 'preview' / '2024-03-04.md').write_text('preview')
        os.mkfifo(self.root / '2024-03-05.md')
        base = self.serve(self.root)
        self.assertEqual(self.get(base, '/api/journal/days'), (200, {'enabled': True, 'days': ['2024-03-01', '2024-02-29']}))
        self.assertEqual(self.get(base, '/api/journal/day?date=2024-02-29'), (200, {'date': '2024-02-29', 'markdown': '---\ntitle: 合成\n---\n正文\n'}))
        for day in ('2024-03-02', '2024-03-03', '2024-03-04', '2024-03-05'):
            self.assertEqual(self.get(base, '/api/journal/day?date=' + day)[0], 404)

    def test_errors_and_limit(self):
        base = self.serve(self.root / 'missing-secret')
        for path in ('/api/journal/days', '/api/journal/day?date=2024-01-01'):
            status, body = self.get(base, path)
            self.assertEqual(status, 500)
            self.assertNotIn(str(self.root), json.dumps(body))
        (self.root / '2024-01-01.md').write_bytes(b'x' * JOURNAL_MAX_BYTES)
        (self.root / '2024-01-02.md').write_bytes(b'x' * (JOURNAL_MAX_BYTES + 1))
        (self.root / '2024-01-03.md').write_bytes(b'\xff')
        base = self.serve(self.root)
        self.assertEqual(self.get(base, '/api/journal/day?date=2024-01-01')[0], 200)
        self.assertEqual(self.get(base, '/api/journal/day?date=2024-01-02')[0], 413)
        self.assertEqual(self.get(base, '/api/journal/day?date=2024-01-03')[0], 500)

    def test_directory_replacement_does_not_rescope(self):
        configured = self.root / 'journal'
        configured.mkdir()
        (configured / '2024-01-01.md').write_text('original')
        base = self.serve(configured)
        configured.rename(self.root / 'original')
        replacement = self.root / 'replacement'
        replacement.mkdir()
        (replacement / '2024-01-01.md').write_text('replacement')
        (replacement / '2024-01-02.md').write_text('secret')
        configured.symlink_to(replacement, target_is_directory=True)
        for _ in range(3):
            self.assertEqual(self.get(base, '/api/journal/days'),
                             (200, {'enabled': True, 'days': ['2024-01-01']}))
            self.assertEqual(self.get(base, '/api/journal/day?date=2024-01-01'),
                             (200, {'date': '2024-01-01', 'markdown': 'original'}))
            self.assertEqual(self.get(base, '/api/journal/day?date=2024-01-02')[0], 404)

    def test_configured_symlink_is_pinned_at_start(self):
        target = self.root / 'target'
        target.mkdir()
        (target / '2024-01-01.md').write_text('original')
        link = self.root / 'link'
        link.symlink_to(target, target_is_directory=True)
        base = self.serve(link)
        link.unlink()
        other = self.root / 'other'
        other.mkdir()
        (other / '2024-01-01.md').write_text('replacement')
        link.symlink_to(other, target_is_directory=True)
        self.assertEqual(self.get(base, '/api/journal/day?date=2024-01-01'),
                         (200, {'date': '2024-01-01', 'markdown': 'original'}))

    def test_missing_at_start_stays_unavailable(self):
        directory = self.root / 'missing'
        base = self.serve(directory)
        directory.mkdir()
        self.assertEqual(self.get(base, '/api/journal/days')[0], 500)

    def test_bind_failure_closes_pinned_directory(self):
        first = make_server(None, [], 0)
        self.addCleanup(first.server_close)
        real_open = os.open
        opened = []
        def record_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            opened.append(fd)
            return fd
        with patch('agent_stats.server.os.open', side_effect=record_open):
            with self.assertRaises(OSError):
                make_server(None, [], first.server_port, journal_dir=self.root)
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

    def test_independent_of_store_lock(self):
        class BlockingStore:
            def query(self, params):
                entered.set()
                release.wait(3)
                return {}
        entered, release = threading.Event(), threading.Event()
        base = self.serve(self.root, BlockingStore())
        def query():
            self.get(base, '/api/overview')
        thread = threading.Thread(target=query)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.get(base, '/api/journal/days')[0], 200)
        finally:
            release.set()
            thread.join()

    def test_cli_passes_explicit_directory(self):
        server = unittest.mock.Mock(server_port=1234)
        server.serve_forever.side_effect = KeyboardInterrupt
        with patch.object(cli, 'Store'), patch.object(cli, 'make_server', return_value=server) as make:
            self.assertEqual(cli.main(['--db', str(self.root / 'db'), 'serve', '--archive-only', '--no-content', '--journal-dir', str(self.root)]), 0)
            self.assertEqual(make.call_args.kwargs['journal_dir'], str(self.root))


if __name__ == '__main__':
    unittest.main()
