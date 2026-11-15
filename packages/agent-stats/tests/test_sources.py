import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from agent_stats.cli import main
from agent_stats.core import Store
from agent_stats.sources import import_document, import_sessions, import_source


class SourceTests(unittest.TestCase):
    def test_bundled_example_exports_without_database_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'example.json'
            db = Path(tmp) / 'not-created.sqlite'
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['--db', str(db), 'example', '--output', str(target)]), 0)
            self.assertFalse(db.exists())
            self.assertEqual(target.read_bytes(), (Path(__file__).parents[1] / 'docs/custom-source.example.json').read_bytes())
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(['example', '--output', str(target)]), 1)
            self.assertEqual(json.loads(target.read_text())['sessions'][0]['turns'][0]['token_total'], 150)

    def test_cli_provider_and_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'db.sqlite'
            example = Path(__file__).parents[1] / 'docs/custom-source.example.json'
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(main(['--db', str(db), 'import-json', '--input', str(example)]), 0)
            self.assertEqual(json.loads(out.getvalue())['imported'], 1)
            store = Store(db)
            class Provider:
                source = 'my-agent'
                instance = 'laptop'
                def sessions(self):
                    return json.loads(example.read_text())['sessions']
            self.assertEqual(import_source(store, Provider())['skipped'], 1)
            summary = store.query()['summary']
            self.assertEqual((summary['sessions'], summary['turns'], summary['token_total'], summary['tool_calls']), (1, 1, 150, 1))
            detail = store.detail(store.query()['sessions'][0]['id'])
            # The shipped UI directly maps evidence/tools: preserve its shape
            # even when the provider has no source-line evidence or tool result.
            turn = detail['turns'][0]
            self.assertEqual(turn['evidence'], [])
            self.assertEqual(turn['status'], 'unknown')
            self.assertIsNone(turn['ended_at'])
            tool = turn['tools'][0]
            self.assertTrue(tool['call_id'])
            self.assertIsNone(tool['line'])
            self.assertIsNone(tool['input_bytes'])
            self.assertEqual(store.query()['turns'][0]['evidence'], [])
            rows = json.loads(example.read_text())['sessions']
            rows[0]['turns'][0]['token_total'] = 151
            rows[0]['turns'][0]['output_tokens'] = 51
            self.assertEqual(import_sessions(store, 'my-agent', 'laptop', rows)['imported'], 1)
            self.assertEqual(store.query()['summary']['token_total'], 151)
            import_sessions(store, 'my-agent', 'other', rows)
            self.assertEqual(store.query()['summary']['sessions'], 2)

    def test_invalid_batch_and_provider_failure_are_atomic(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / 'db')
            good = {'id': 's', 'turns': [{'id': 't', 'token_total': 2}]}
            for bad in ({'id': 'bad', 'turns': [{'id': 't', 'token_total': True}]},
                        {'id': 'bad', 'turns': [{'id': 't', 'started_at': '2020-01-01'}]},
                        {'id': 'bad', 'turns': [{'id': 't'}, {'id': 't'}]}, good):
                with self.assertRaises(ValueError):
                    import_sessions(store, 'x', 'y', [good, bad])
                self.assertEqual(store.query()['summary']['sessions'], 0)
            def broken():
                yield good
                raise RuntimeError('provider failed')
            with self.assertRaises(RuntimeError):
                import_sessions(store, 'x', 'y', broken())
            self.assertEqual(store.query()['summary']['sessions'], 0)
            with self.assertRaises(ValueError):
                import_document(store, {'version': True, 'source': 'x', 'instance': 'y', 'sessions': []})

    def test_database_failure_rolls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / 'db')
            store.db.execute("CREATE TRIGGER reject_second BEFORE INSERT ON sessions WHEN NEW.body LIKE '%second%' BEGIN SELECT RAISE(ABORT, 'reject'); END")
            with self.assertRaises(Exception):
                import_sessions(store, 'x', 'y', [{'id': 'first', 'turns': []}, {'id': 'second', 'turns': []}])
            self.assertEqual(store.query()['summary']['sessions'], 0)
