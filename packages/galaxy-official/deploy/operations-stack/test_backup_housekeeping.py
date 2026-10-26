import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('housekeeping', Path(__file__).with_name('backup_housekeeping.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class HousekeepingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def stage(self, purpose='backup', age=3):
        p = self.root / str(uuid.uuid4())
        p.mkdir()
        (p / '.galaxy-capture').write_text(json.dumps({'id': p.name, 'purpose': purpose}))
        (p / 'payload').write_text('only test data')
        os.utime(p, (time.time() - age * 3600,) * 2)
        return p

    def test_only_old_owned_backup_directories_are_candidates(self):
        old = self.stage(age=50)
        self.stage(age=0)
        self.stage(purpose='restore', age=50)
        invalid = self.stage(age=50)
        (invalid / '.galaxy-capture').write_text('{}')
        (self.root / 'unrelated').mkdir()
        self.assertEqual(h.stage_candidates(self.root, time.time(), 48), [old])

    def test_pressure_still_keeps_one_hour_of_failed_capture(self):
        old = self.stage(age=2)
        self.stage(age=0.5)
        self.assertEqual(h.stage_candidates(self.root, time.time(), 1), [old])

    def test_active_local_job_prevents_cleanup(self):
        lock = self.root / '.operations-job.lock'
        lock.mkdir()
        (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid(), 'hostname': socket.gethostname()}))
        # The production host is Linux. A synthetic live-PID response keeps
        # this unit check safe on Windows, where os.kill(pid, 0) is not the
        # POSIX process-existence operation.
        with patch.object(h.os, 'kill', return_value=None) as exists:
            with self.assertRaisesRegex(h.PolicyError, 'job_busy'):
                with h.job_lock(self.root):
                    self.fail('entered active lock')
            exists.assert_called_once_with(os.getpid(), 0)

    def test_lock_is_released_on_failure(self):
        with self.assertRaisesRegex(RuntimeError, 'probe'):
            with h.job_lock(self.root):
                raise RuntimeError('probe')
        self.assertFalse((self.root / '.operations-job.lock').exists())

    def test_deletion_rechecks_marker_and_containment(self):
        p = self.stage(age=50)
        (p / '.galaxy-capture').write_text(json.dumps({'id': p.name, 'purpose': 'restore'}))
        with self.assertRaisesRegex(h.PolicyError, 'marker_mismatch'):
            h.remove_stage(self.root, p)
        with self.assertRaisesRegex(h.PolicyError, 'outside_root'):
            h.remove_stage(p, self.root)
        self.assertTrue((p / 'payload').exists())

    @unittest.skipUnless(h.shutil.rmtree.avoids_symlink_attacks, 'requires production Linux fd-safe rmtree')
    def test_symlink_payload_cannot_delete_external_data(self):
        p = self.stage(age=50)
        external = self.root / 'business-data'
        external.mkdir()
        (external / 'preserve').write_text('preserve')
        (p / 'linked').symlink_to(external, target_is_directory=True)
        h.remove_stage(self.root, p)
        self.assertEqual((external / 'preserve').read_text(), 'preserve')

    def test_snapshot_retention_protects_verified_and_foreign_points(self):
        points = [{'id': c * 64, 'hostname': 'galaxy-production', 'tags': ['galaxy-product']} for c in ['a', 'b', 'c', 'd']]
        foreign = {'id': 'e' * 64, 'hostname': 'other-project', 'tags': ['galaxy-product']}
        groups = [{'remove': [points[0], points[1], foreign]}]
        self.assertEqual(h.removable_snapshots(points + [foreign], groups, {'a' * 64}, 'galaxy-production'), ['b' * 64])

    def test_snapshot_retention_never_removes_last_two(self):
        points = [{'id': c * 64, 'hostname': 'galaxy-production', 'tags': ['galaxy-product']} for c in ['a', 'b', 'c']]
        with self.assertRaisesRegex(h.PolicyError, 'minimum_recovery_points'):
            h.removable_snapshots(points, [{'remove': points[:2]}], set(), 'galaxy-production')

    def test_read_only_retention_does_not_forget_or_prune(self):
        points = [{'id': c * 64, 'hostname': 'galaxy-production', 'tags': ['galaxy-product']} for c in ['a', 'b', 'c']]
        config = {'tools': {'restic': '/registered/restic'}, 'backup': {'resticHost': 'galaxy-production', 'retention': {'daily': 1, 'weekly': 4, 'monthly': 1}}, 'directories': {'status': str(self.root)}}
        with patch.object(h, 'restic_environment', return_value={}), patch.object(h, 'protected_points', return_value=set()), patch.object(h, 'command', side_effect=[json.dumps(points), json.dumps([{'remove': [points[0]]}])]) as run:
            self.assertEqual(h.repository_retention({}, config, False)['planned'], ['a' * 64])
            self.assertEqual(run.call_count, 2)
            self.assertTrue(all('--dry-run' in c.args[0] or 'snapshots' in c.args[0] for c in run.call_args_list))

    def test_interrupted_prune_is_resumed_next_run(self):
        points = [{'id': c * 64, 'hostname': 'galaxy-production', 'tags': ['galaxy-product']} for c in ['a', 'b']]
        pending = self.root / 'retention-prune.pending.json'
        pending.write_text('{}')
        config = {'tools': {'restic': '/registered/restic'}, 'backup': {'resticHost': 'galaxy-production', 'retention': {'daily': 1, 'weekly': 4, 'monthly': 1}}, 'directories': {'status': str(self.root)}}
        with patch.object(h, 'restic_environment', return_value={}), patch.object(h, 'protected_points', return_value=set()), patch.object(h, 'command', side_effect=[json.dumps(points), '[]', '', '']) as run:
            h.repository_retention({}, config, True)
            self.assertTrue(any('prune' in call.args[0] for call in run.call_args_list))
        self.assertFalse(pending.exists())

    def test_release_cache_plan_keeps_recent_and_active_releases(self):
        targets = []
        for i in range(7):
            release = self.root / ('0.1.' + str(i))
            p = release / 'apps/galaxy-admin/.next/cache/turbopack'
            p.mkdir(parents=True)
            os.utime(p, (time.time() - 60 * 3600,) * 2)
            os.utime(release, (time.time() - (60 - i) * 3600,) * 2)
            targets.append(p)
        with patch.object(h, 'active_working_directories', return_value=[targets[0].parents[2]]):
            self.assertEqual(h.next_build_cache_candidates(self.root, time.time(), 48), [targets[1]])

    def test_build_cache_removal_rejects_source_and_business_paths(self):
        source = self.root / '0.1.0/apps/galaxy-admin/src'
        source.mkdir(parents=True)
        with self.assertRaisesRegex(h.PolicyError, 'cache_outside_root'):
            h.remove_next_build_cache(self.root, source)
        self.assertTrue(source.exists())


if __name__ == '__main__':
    unittest.main()
