"""Public page contracts and archive containment regressions."""
from html.parser import HTMLParser
import json
from pathlib import Path, PureWindowsPath
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from build import copy_example_images, windows_filesystem_path
from guide_pages import render_markdown
import chrome
from product_pages import render_homepage, render_product_pages
from public_reading import reading_tree, web_entry_assets


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


class PublicReadingTreeTests(unittest.TestCase):
    def test_text_and_links_are_data_and_original_code_is_preserved(self):
        tree = reading_tree('<section><h1>说明</h1><a href="/app/account?section=access">账户</a><pre><code>&lt;script&gt;value&lt;/script&gt;</code></pre></section>')
        self.assertEqual(tree[0]['children'][2]['children'][0]['children'], ['<script>value</script>'])
        self.assertEqual(tree[0]['children'][1]['attrs']['href'], '/app/account?section=access')

    def test_executable_tags_attributes_and_unsafe_urls_are_rejected(self):
        for markup in ['<script>alert(1)</script>', '<style>body{}</style>', '<iframe></iframe>',
                       '<a href="javascript:alert(1)">x</a>', '<a href="//other.test">x</a>',
                       '<a href="/app/" onclick="alert(1)">x</a>', '<p style="color:red">x</p>',
                       '<a href="/app/" href="https://other.test">x</a>', '<div><p>x</div>']:
            with self.subTest(markup=markup), self.assertRaises(ValueError):
                reading_tree(markup)

    def test_deep_or_unclosed_content_is_rejected(self):
        for markup in ['<div>' * 43 + 'x' + '</div>' * 43, '<section>unclosed']:
            with self.subTest(markup=markup), self.assertRaises(ValueError):
                reading_tree(markup)

    def test_bootstrap_names_the_exact_existing_build_files(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'assets').mkdir()
            (directory / 'assets/main-actual.js').write_text('export {}', encoding='utf-8')
            (directory / 'assets/main-actual.css').write_text('body{}', encoding='utf-8')
            (directory / 'index.html').write_text('<script type="module" src="/app/assets/main-actual.js"></script><link rel="stylesheet" href="/app/assets/main-actual.css">', encoding='utf-8')
            assets = web_entry_assets(directory)
            self.assertEqual(assets['entry'], '/app/assets/main-actual.js')
            self.assertEqual(set(assets['sha256']), {'/app/assets/main-actual.js', '/app/assets/main-actual.css'})
            (directory / 'assets/main-actual.js').unlink()
            with self.assertRaises(ValueError):
                web_entry_assets(directory)


class HomepageParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.elements = []
        self.text = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def handle_data(self, text):
        self.text.append(text)


class HomepageTests(unittest.TestCase):
    def test_selected_long_home_has_content_and_real_entries_without_javascript(self):
        html = render_homepage()
        parsed = HomepageParser(html)
        links = {attrs['href'] for tag, attrs in parsed.elements if tag == 'a'}
        self.assertTrue({'/app/', '/downloads/'} <= links)
        for title in ('开放的身份与能力网络', '星河研究', '出处始终清楚',
                      '同一身份，积累继续发挥作用', '从你熟悉的地方接入', '开始探索银河'):
            self.assertIn(title, ''.join(parsed.text))
        self.assertIn('资料、身份与回答均为预设内容', html)
        self.assertIn('非正式协议条款', html)
        self.assertNotIn('3.1', html)
        self.assertNotIn('2024', html)
        self.assertIn('本机接入', html)
        data = next(attrs['data-home-example'] for _, attrs in parsed.elements if 'data-home-example' in attrs)
        example = json.loads(data)
        self.assertTrue(example['preset'])
        self.assertEqual(example['entries']['native']['href'], '/downloads/')
        self.assertNotIn('<script', html)
        self.assertFalse(any(tag == 'img' for tag, _ in parsed.elements))
        self.assertFalse(any(name.startswith('on') or name == 'style'
                             for _, attrs in parsed.elements for name in attrs))

    def test_tabs_and_source_references_have_unique_valid_local_targets(self):
        elements = HomepageParser(render_homepage()).elements
        ids = [attrs['id'] for _, attrs in elements if 'id' in attrs]
        self.assertEqual(len(ids), len(set(ids)))
        by_id = {attrs['id']: attrs for _, attrs in elements if 'id' in attrs}
        tabs = [attrs for _, attrs in elements if attrs.get('role') == 'tab']
        self.assertTrue(tabs)
        for tab in tabs:
            panel = by_id[tab['aria-controls']]
            selected = tab['aria-selected'] == 'true'
            self.assertEqual(panel['aria-labelledby'], tab['id'])
            self.assertEqual('hidden' not in panel, selected)
            self.assertEqual(tab['tabindex'], '0' if selected else '-1')
        for _, attrs in elements:
            for target in ('aria-controls', 'data-gh-reference', 'data-gh-locate'):
                if target in attrs:
                    self.assertIn(attrs[target], by_id)
        self.assertFalse(any(tag in ('details', 'summary') or 'aria-expanded' in attrs
                             for tag, attrs in elements))

    def test_official_brand_geometry_is_reused(self):
        markup = chrome.brand_mark()
        elements = HomepageParser(markup).elements
        ellipses = [attrs for tag, attrs in elements if tag == 'ellipse']
        circles = [attrs for tag, attrs in elements if tag == 'circle']
        self.assertEqual([(item['rx'], item['ry'], item['transform']) for item in ellipses],
                         [('13', '6', 'rotate(-36 16 16)'), ('6', '13', 'rotate(-36 16 16)')])
        self.assertEqual(circles[-1]['fill'], '#d8a9be')
        self.assertEqual((circles[-1]['cx'], circles[-1]['cy']), ('26', '7'))


class PublicNavigationTests(unittest.TestCase):
    def test_all_current_pages_keep_entries_without_direction_icons_or_disclosures(self):
        with TemporaryDirectory() as temporary:
            output = Path(temporary)
            metadata = {
                'backendRelease': '0.0.1', 'publicApiObservedAt': 'test fixture',
                'nativeClientDownload': {
                    'downloadBase': '/downloads/native-client/0.0.1/',
                    'package': {'version': '0.0.1', 'filename': 'fixture.zip',
                                'bytes': 128, 'sha256': 'a' * 64}
                }
            }
            (output / 'release.json').write_text(json.dumps(metadata), encoding='utf-8')
            with patch.object(chrome, 'OUT', output), patch.object(chrome, 'PREVIEW', True):
                render_product_pages({'page': chrome.page, 'write': chrome.write,
                                      'OUT': output, 'PREVIEW': True})
            for page in output.rglob('*.html'):
                html = page.read_text(encoding='utf-8')
                elements = HomepageParser(html).elements
                with self.subTest(page=page.relative_to(output)):
                    self.assertFalse(any(tag in ('details', 'summary') for tag, _ in elements))
                    self.assertFalse(any('aria-expanded' in attrs for _, attrs in elements))
                    self.assertNotRegex(html, '[←→↔↑↓↗↘‹›»«]')
                    links = {attrs.get('href') for tag, attrs in elements if tag == 'a'}
                    self.assertTrue({'/app/', '/app/community', '/app/account', '/app/work',
                                     '/app/rooms', '/app/publish', '/app/search'} <= links)
            download = (output / 'downloads/index.html').read_text(encoding='utf-8')
            verification = (output / 'downloads/verification/index.html').read_text(encoding='utf-8')
            self.assertIn('href="/downloads/verification/"', download)
            self.assertIn('SHA-256', verification)
            self.assertIn('a' * 64, verification)
            self.assertIn('/downloads/native-client/0.0.1/release.jws', verification)
            self.assertIn('/docs/v0.3/installation.md', verification)

    def test_guide_prose_uses_words_while_technical_code_keeps_original_bytes(self):
        _, html, _ = render_markdown(
            '# 安装\n\n设置 → MCP → 本地配置。\n\n' + chr(96) + 'input → output' + chr(96) + '\n',
            '/docs/native-client/test/hosts.md', {}
        )
        self.assertIn('设置、MCP、本地配置。', html)
        self.assertIn('<code>input → output</code>', html)


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
