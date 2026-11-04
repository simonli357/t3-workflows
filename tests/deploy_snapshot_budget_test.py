import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'deploy/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class SnapshotBudget(unittest.TestCase):
    def test_snapshot_allowance_preserves_activation_margins(self):
        for command in ('apply', 'resume', 'measure-backup'):
            req = {'command': command}
            self.assertEqual(host.runner_seconds(req) - 8 * 120, 840 - 8 * 30)
            req['target'] = {'verifySeconds': 180}
            self.assertEqual(host.runner_seconds(req), 1620)
        self.assertEqual(host.runner_seconds({'command': 'stage'}), 840)

if __name__ == '__main__':
    unittest.main()
