import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_housekeeping', Path(__file__).with_name('release_housekeeping.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class ReleaseRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def release(self, name):
        p = self.root / name
        p.mkdir()
        (p / 'source.mjs').write_text('export const version = 1;')
        return p

    def test_plan_keeps_only_two_recent_and_referenced(self):
        releases = [self.release('0.1.' + str(i)) for i in range(6)]
        plan, kept = h.release_plan([self.root], {releases[0]}, time.time() + 7200)
        self.assertIn(releases[0], kept)
        self.assertIn(releases[-1], kept)
        self.assertIn(releases[-2], kept)
        self.assertEqual(len(plan), 3)

    def test_recent_uploads_are_never_candidates(self):
        for i in range(5):
            self.release('0.1.' + str(i))
        plan, _ = h.release_plan([self.root], set(), time.time())
        self.assertEqual(plan, [])

    def test_unregistered_names_and_symlink_roots_are_not_candidates(self):
        self.release('business-uploads')
        p = self.release('0.1.0')
        link = self.root / '0.1.1'
        try:
            link.symlink_to(p, target_is_directory=True)
        except OSError:
            self.skipTest('symlink permission unavailable')
        with self.assertRaisesRegex(h.PolicyError, 'symlink_rejected'):
            h.checked_release(self.root, link)
        with self.assertRaisesRegex(h.PolicyError, 'outside_registered_root'):
            h.checked_release(self.root, self.root / 'business-uploads')

    def test_checked_release_rejects_other_root(self):
        p = self.release('0.1.0')
        child = p / 'nested'
        child.mkdir()
        with self.assertRaisesRegex(h.PolicyError, 'outside_registered_root'):
            h.checked_release(self.root, child)

    def test_new_reference_after_quarantine_restores_source(self):
        p = self.release('0.1.0')
        entry = h.quarantine(self.root, p)
        self.assertFalse(p.exists())
        result = h.complete_quarantine(self.root, entry, {p})
        self.assertEqual(result['state'], 'restored-new-reference')
        self.assertTrue((p / 'source.mjs').exists())

    def test_open_descriptor_path_in_quarantine_protects_original(self):
        p = self.release('0.1.0')
        entry = h.quarantine(self.root, p)
        text = str(entry / 'payload/source.mjs')
        self.assertEqual(h.release_references(text, [self.root]), {p})

    def test_new_directory_cannot_be_overwritten_by_restore(self):
        p = self.release('0.1.0')
        entry = h.quarantine(self.root, p)
        self.release('0.1.0')
        result = h.complete_quarantine(self.root, entry, {p})
        self.assertEqual(result['state'], 'protected-quarantine-needs-review')
        self.assertTrue((entry / 'payload/source.mjs').exists())

    def test_partially_deleted_quarantine_cannot_be_restored_as_a_release(self):
        p = self.release('0.1.0')
        entry = h.quarantine(self.root, p)
        marker = entry / 'owner.json'
        value = json.loads(marker.read_text())
        value['state'] = 'deleting'
        marker.write_text(json.dumps(value))
        result = h.complete_quarantine(self.root, entry, {p})
        self.assertEqual(result['state'], 'protected-quarantine-needs-review')
        self.assertFalse(p.exists())

    def test_new_pending_release_keeps_running_predecessor(self):
        releases = [self.release('0.1.' + str(i)) for i in range(3)]
        # Active 0.1.1 and pending 0.1.2 must keep 0.1.0 until the switch.
        text = 'ActiveState=active\nWorkingDirectory=' + str(releases[1]) + '\n'
        # Set deterministic creation order instead of depending on the
        # filesystem timestamp resolution of three rapid mkdir operations.
        native_stat = Path.stat
        def ordered_stat(path, *args, **kwargs):
            info = native_stat(path, *args, **kwargs)
            if path in releases:
                values = list(info)
                values[9] = 1000 + releases.index(path)
                return os.stat_result(values)
            return info
        with patch.object(h, 'run', return_value=text), patch.object(Path, 'stat', ordered_stat):
            self.assertIn(releases[0], h.primary_release_predecessors([self.root]))

    @unittest.skipUnless(shutil.rmtree.avoids_symlink_attacks, 'requires production Linux fd-safe rmtree')
    def test_deletion_preserves_symlink_target_and_other_release(self):
        p = self.release('0.1.0')
        other = self.release('0.1.1')
        (p / 'external').symlink_to(other, target_is_directory=True)
        entry = h.quarantine(self.root, p)
        self.assertEqual(h.complete_quarantine(self.root, entry, set())['state'], 'deleted')
        self.assertTrue((other / 'source.mjs').exists())

    def test_quarantine_identity_tampering_stops_deletion(self):
        p = self.release('0.1.0')
        entry = h.quarantine(self.root, p)
        marker = entry / 'owner.json'
        value = json.loads(marker.read_text())
        value['inode'] += 1
        marker.write_text(json.dumps(value))
        with self.assertRaisesRegex(h.PolicyError, 'identity_changed'):
            h.complete_quarantine(self.root, entry, set())
        self.assertTrue((entry / 'payload/source.mjs').exists())

    def test_symlink_dependency_protects_an_older_release(self):
        current = self.release('0.1.2')
        old = self.release('0.1.0')
        try:
            (current / 'shared').symlink_to(old, target_is_directory=True)
        except OSError:
            self.skipTest('symlink permission unavailable')
        self.assertIn(old, h.symlink_dependencies({current}, [self.root]))


if __name__ == '__main__':
    unittest.main()
