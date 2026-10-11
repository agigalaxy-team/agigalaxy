"""Archive containment regressions for Windows filesystem namespace paths."""
from pathlib import PureWindowsPath
import unittest

from build import windows_filesystem_path
from guide_pages import render_markdown


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


class PublicGuideReadingTests(unittest.TestCase):
    def test_readable_links_commands_and_escaped_content(self):
        source = '/docs/native-client/0.1.10/installation.md'
        pages = {'/docs/native-client/0.1.10/hosts.md': '/docs/native-client/0.1.10/hosts/'}
        markdown = '# 安装\n\n## 选择宿主\n\n[宿主](hosts.md)\n\n- [下载](https://agigalaxy.org/downloads/native-client/0.1.10/package-metadata.json)\n\n```text\nnode setup.mjs <所选官网>\n```\n\n<script>alert(1)</script>\n'
        title, html, headings = render_markdown(markdown, source, pages)
        self.assertEqual(title, '安装')
        self.assertIn('href="/docs/native-client/0.1.10/hosts/"', html)
        self.assertIn('href="/downloads/native-client/0.1.10/package-metadata.json" download', html)
        self.assertIn('node setup.mjs &lt;所选官网&gt;', html)
        self.assertNotIn('<script>', html)
        self.assertEqual(headings[0][2], '选择宿主')

    def test_active_urls_and_incomplete_commands_are_rejected(self):
        for markdown in ['# 安装\n\n[链接](javascript:alert)\n', '# 安装\n\n```text\nnode setup.mjs']:
            with self.subTest(markdown=markdown), self.assertRaises(ValueError):
                render_markdown(markdown, '/docs/native-client/0.1.10/installation.md', {})


if __name__ == '__main__':
    unittest.main()
