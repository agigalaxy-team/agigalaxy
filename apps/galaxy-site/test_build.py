"""Archive containment regressions for Windows filesystem namespace paths."""
from pathlib import PureWindowsPath
import unittest

from build import windows_filesystem_path


class ArchivePathTests(unittest.TestCase):
    def contained(self, target, directory):
        return PureWindowsPath(windows_filesystem_path(target)).is_relative_to(
            PureWindowsPath(windows_filesystem_path(directory)))

    def test_resolved_drive_and_unc_namespaces_remain_inside_output(self):
        self.assertTrue(self.contained(r'\\?\C:\release\public\docs\guide.md', r'C:\release\public'))
        self.assertTrue(self.contained(r'\\?\UNC\server\share\public\docs\guide.md', r'\\server\share\public'))

    def test_unrelated_directories_and_device_namespaces_still_fail(self):
        self.assertFalse(self.contained(r'\\?\C:\release\public-old\docs\guide.md', r'C:\release\public'))
        self.assertFalse(self.contained(r'\\?\D:\release\public\docs\guide.md', r'C:\release\public'))
        self.assertFalse(self.contained(r'\\?\UNC\other\share\public\guide.md', r'\\server\share\public'))
        self.assertFalse(self.contained(r'\\?\GLOBALROOT\Device\HarddiskVolume1\release\public\guide.md', r'C:\release\public'))


if __name__ == '__main__':
    unittest.main()
