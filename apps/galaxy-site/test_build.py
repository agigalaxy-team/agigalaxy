"""Public page contracts and archive containment regressions."""
from html.parser import HTMLParser
import json
from pathlib import Path, PureWindowsPath
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from build import copy_example_images, windows_filesystem_path
from guide_pages import render_markdown
from product_pages import render_homepage


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


class HomepageParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.elements = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))


class HomepageTests(unittest.TestCase):
    def test_content_and_real_destinations_are_available_without_javascript(self):
        html = render_homepage()
        parsed = HomepageParser(html)
        links = {attrs['href'] for tag, attrs in parsed.elements if tag == 'a'}
        self.assertTrue({'/app/', '/downloads/', '/app/community', '/app/find', '/docs/', '/network/'} <= links)
        self.assertIn('开放的身份</span><span>与能力网络', html)
        self.assertIn('交互示例 · 资料、身份与回答均为预设内容', html)
        data = next(attrs['data-home-example'] for _, attrs in parsed.elements if 'data-home-example' in attrs)
        example = json.loads(data)
        self.assertIn(example['questions']['overview']['answer'], html)
        self.assertEqual(example['questions']['overview']['sources'], ['protocol', 'contribution'])
        self.assertNotIn('<script', html)
        self.assertFalse(any(name.startswith('on') or name == 'style'
                             for _, attrs in parsed.elements for name in attrs))

    def test_keyboard_tabs_and_local_disclosures_have_unique_targets(self):
        elements = HomepageParser(render_homepage()).elements
        ids = [attrs['id'] for _, attrs in elements if 'id' in attrs]
        self.assertEqual(len(ids), len(set(ids)))
        by_id = {attrs['id']: attrs for _, attrs in elements if 'id' in attrs}
        tabs = [attrs for _, attrs in elements if attrs.get('role') == 'tab']
        self.assertEqual(len(tabs), 4)
        for tab in tabs:
            panel = by_id[tab['aria-controls']]
            selected = tab['aria-selected'] == 'true'
            self.assertEqual(panel['aria-labelledby'], tab['id'])
            self.assertEqual('hidden' not in panel, selected)
            self.assertEqual(tab.get('tabindex', '0'), '0' if selected else '-1')
        for _, attrs in elements:
            if 'aria-controls' in attrs:
                self.assertIn(attrs['aria-controls'], by_id)
        self.assertEqual(len([attrs for _, attrs in elements if 'data-gh-open' in attrs]), 3)


class ExampleImageTests(unittest.TestCase):
    def test_only_named_covers_and_attribution_are_published(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            site_root = root / 'repo' / 'apps' / 'galaxy-site'
            source = root / 'repo' / 'public' / 'images' / 'examples'
            source.mkdir(parents=True)
            expected = ('reading-lamp.png', 'travel-journal.png', 'reading-room.png', 'credits.json')
            for name in (*expected, 'private-draft.png'):
                (source / name).write_bytes(name.encode())
            output = root / 'output'
            with patch('build.ROOT', site_root):
                copy_example_images(output)
            self.assertEqual({file.name for file in output.rglob('*') if file.is_file()}, set(expected))
            for name in expected:
                self.assertEqual((output / 'images' / 'examples' / name).read_bytes(), name.encode())


if __name__ == '__main__':
    unittest.main()
