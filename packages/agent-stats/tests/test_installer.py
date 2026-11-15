import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stats_installer', ROOT / 'scripts/install-macos-service.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerSafetyTests(unittest.TestCase):
    def setUp(self):
        # Never inspect or invoke the real host's service executables.
        tools = patch.object(installer, 'check_platform_tools')
        tools.start()
        self.addCleanup(tools.stop)

    def test_no_apply_and_dry_run_have_no_side_effects(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(installer.Path, 'home', return_value=Path(directory)), \
             patch.object(installer.subprocess, 'run', side_effect=AssertionError('must not run subprocess')):
            with self.assertRaisesRegex(SystemExit, '--apply'):
                installer.main([])
            with self.assertRaisesRegex(SystemExit, '--apply'):
                installer.main(['--uninstall'])
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(installer.main(['--dry-run', '--with-trace']), 0)
            plan = json.loads(out.getvalue())
            self.assertEqual(plan['labels'], [installer.DASHBOARD, installer.TRACE, installer.FOLLOW])
            self.assertTrue(all(x.startswith('local.agent-observatory.') for x in plan['labels']))
            self.assertIn('.local/share/agent-observatory/', plan['database'])
            self.assertEqual(plan['port'], 18765)
            self.assertEqual(list(Path(directory).iterdir()), [])
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main(['--apply', '--uninstall', '--dry-run']), 0)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_managed_symlinks_fail_before_services_or_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            legacy = home / 'legacy'
            legacy.mkdir()
            sentinel = legacy / 'sentinel'
            sentinel.write_text('unchanged')
            state = home / '.local/share/agent-observatory'
            state.parent.mkdir(parents=True)
            state.symlink_to(legacy, target_is_directory=True)
            with patch.object(installer.Path, 'home', return_value=home), patch.object(installer.sys, 'platform', 'darwin'), \
                 patch.object(installer.subprocess, 'run', side_effect=AssertionError('unexpected subprocess')), \
                 patch.object(installer, 'stop') as stop, patch.object(installer, 'install') as install:
                for args in (['--apply'], ['--apply', '--uninstall'], ['--apply', '--with-trace']):
                    with self.assertRaisesRegex(SystemExit, 'symlink'):
                        installer.main(args)
                stop.assert_not_called()
                install.assert_not_called()
                self.assertEqual(sentinel.read_text(), 'unchanged')
            state.unlink()
            stats = state / 'agent-stats'
            stats.mkdir(parents=True)
            (stats / 'server.stderr.log').symlink_to(sentinel)
            plan = installer.make_plan(home, ROOT, installer.parser().parse_args(['--apply']))
            with self.assertRaisesRegex(ValueError, 'symlink'):
                installer.preflight_managed_paths(plan, False)
            (stats / 'server.stderr.log').unlink()
            plist = Path(plan['plists'][installer.DASHBOARD])
            plist.parent.mkdir(parents=True)
            plist.symlink_to(sentinel)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                installer.preflight_managed_paths(plan, False)
            self.assertEqual(sentinel.read_text(), 'unchanged')

    def test_missing_full_plan_assets_never_installs_dashboard(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(installer.Path, 'home', return_value=Path(directory)), \
             patch.object(installer.sys, 'platform', 'darwin'), patch.object(installer, 'install') as install, \
             patch.object(installer.subprocess, 'run', side_effect=AssertionError('unexpected subprocess')):
            with self.assertRaisesRegex(SystemExit, 'required'):
                installer.main(['--apply', '--with-trace'])
            install.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_wrong_plist_prevents_any_uninstall(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            args = installer.parser().parse_args(['--uninstall'])
            plan = installer.make_plan(home, ROOT, args)
            target = Path(plan['plists'][installer.FOLLOW])
            target.parent.mkdir(parents=True)
            target.write_bytes(plistlib.dumps({'Label': 'local.agent-stats-follow'}))
            with patch.object(installer.Path, 'home', return_value=home), patch.object(installer.sys, 'platform', 'darwin'), \
                 patch.object(installer, 'stop') as stop:
                with self.assertRaisesRegex(SystemExit, 'label mismatch'):
                    installer.main(['--apply', '--uninstall'])
                stop.assert_not_called()
                self.assertTrue(target.exists())

    def test_full_plan_is_prevalidated_and_uses_isolated_database(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            trace = home / '.local/share/agent-observatory/agent-trace'
            trace.mkdir(parents=True)
            token = 'test-token'
            (trace / 'stats.token').write_text(token)
            (trace / 'stats.token').chmod(0o600)
            (trace / 'stats.follow.json').write_text(json.dumps({'schema_version': 1, 'trace_url': 'http://127.0.0.1:18766', 'token_env': 'TEST_TOKEN', 'database': '../agent-stats/stats.sqlite3'}))
            (trace / 'service.json').write_text(json.dumps({'api': {'clients': [{'token_sha256': hashlib.sha256(token.encode()).hexdigest(), 'views': ['metadata']}]}}))
            response = unittest.mock.Mock(returncode=0, stdout=json.dumps({'capture_mode': 'metadata', 'api': {'enabled': True, 'host': '127.0.0.1', 'port': 18766}}))
            # The producer CLI is mocked below: use a local dummy asset rather
            # than accidentally depending on a sibling Trace source checkout.
            trace_cli = home / 'synthetic-trace-cli.ts'
            trace_cli.write_text('// synthetic preflight asset; never executed')
            original_plan = installer.make_plan
            def synthetic_plan(*args):
                return dict(original_plan(*args), trace_cli=str(trace_cli))
            with patch.object(installer, 'make_plan', side_effect=synthetic_plan), \
                 patch.object(installer.Path, 'home', return_value=home), patch.object(installer.sys, 'platform', 'darwin'), \
                 patch.object(installer.shutil, 'which', return_value='/fake/node'), \
                 patch.object(installer.subprocess, 'run', return_value=response) as validate, patch.object(installer, 'install') as install:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(installer.main(['--apply', '--with-trace']), 0)
                validate.assert_called_once()
                self.assertEqual([c.args[0] for c in install.call_args_list], [installer.TRACE, installer.FOLLOW, installer.DASHBOARD])
                trace_args = install.call_args_list[0].args[1]['ProgramArguments']
                self.assertIn(str(trace / 'trace.sqlite'), trace_args)
                self.assertIn('TEST_TOKEN', install.call_args_list[1].args[1]['EnvironmentVariables'])

    def test_dashboard_only_config_is_isolated_and_never_reads_trace_content(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(installer.Path, 'home', return_value=Path(directory)), \
             patch.object(installer.sys, 'platform', 'darwin'), patch.object(installer, 'install') as install:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main(['--apply']), 0)
            label, job, target = install.call_args.args
            self.assertEqual(label, installer.DASHBOARD)
            self.assertEqual(job['Label'], installer.DASHBOARD)
            self.assertIn('--no-content', job['ProgramArguments'])
            self.assertIn('--archive-only', job['ProgramArguments'])
            self.assertIn('18765', job['ProgramArguments'])
            self.assertIn('agent-observatory', str(target))
            self.assertIn('agent-observatory', job['ProgramArguments'][5])
            install.assert_called_once()


if __name__ == '__main__':
    unittest.main()
