import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sensitive', Path(__file__).resolve().parents[1] / 'check-sensitive.py')
sensitive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sensitive)


class SensitiveTests(unittest.TestCase):
    def test_secret_in_history_fails_without_printing_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'docs/history/raw.md'
            archive.parent.mkdir(parents=True)
            token = 'ghp_' + 'A' * 36
            archive.write_text(token)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = sensitive.main(['--root', str(root), '--all-files'])
            self.assertEqual(result, 1)
            self.assertIn('docs/history/raw.md', output.getvalue())
            self.assertNotIn(token, output.getvalue())

    def test_nul_in_historical_text_cannot_hide_a_secret(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'docs/history/raw.md'
            archive.parent.mkdir(parents=True)
            archive.write_bytes(b'prefix\x00' + ('ghp_' + 'E' * 36).encode())
            _, errors, _ = sensitive.scan(root)
            self.assertIn(('docs/history/raw.md', 0, 'NUL byte in text/source file'), errors)
            self.assertTrue(any(rule == 'github token' for _, _, rule in errors))

    def test_only_exact_synthetic_value_at_exact_path_is_exempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            token = 'ghp_' + 'B' * 36
            (root / 'fixture.txt').write_text(token)
            old = sensitive.SYNTHETIC
            try:
                sensitive.SYNTHETIC = {('fixture.txt', 'github token'): {token}}
                self.assertFalse(sensitive.scan(root)[1])
                (root / 'other.txt').write_text(token)
                self.assertEqual(len(sensitive.scan(root)[1]), 1)
                (root / 'fixture.txt').write_text('ghp_' + 'C' * 36)
                self.assertEqual(len(sensitive.scan(root)[1]), 2)
            finally:
                sensitive.SYNTHETIC = old

    def test_privacy_is_visible_and_strict_mode_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'history.md').write_text('/' + 'Users/' + 'example/private')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(sensitive.main(['--root', str(root)]), 0)
                self.assertEqual(sensitive.main(['--root', str(root), '--strict-privacy']), 1)
            self.assertIn('PRIVACY', output.getvalue())

    def test_sensitive_names_and_external_symlink_are_blocked(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            (root / '.env').write_text('KEY=placeholder')
            target = Path(outside) / 'outside.txt'
            target.write_text('private')
            (root / 'external').symlink_to(target)
            _, errors, _ = sensitive.scan(root)
            self.assertIn(('.env', 0, 'sensitive filename'), errors)
            self.assertIn(('external', 0, 'symlink escapes source root'), errors)

    def test_generated_dependencies_are_not_walked_before_git_init(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'node_modules').mkdir()
            (root / 'node_modules/fixture').write_text('ghp_' + 'D' * 36)
            self.assertEqual(sensitive.scan(root), (0, [], []))


if __name__ == '__main__':
    unittest.main()
