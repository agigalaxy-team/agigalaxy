"""Focused behavior tests for controlled content publication (no services)."""
import base64
import json
from pathlib import Path
import tempfile
import unittest

import chrome
from cms_content import ContentError, apply_snapshot, slot_content
from product_pages import render_product_pages


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2kAAAAASUVORK5CYII=')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


def baseline(directory):
    """Use the real static page renderer with an already rendered chrome cache."""
    directory.mkdir()
    chrome.OUT, chrome.PREVIEW, chrome.WEB_ASSETS = directory, False, {'entry': '/app/assets/existing.js'}
    chrome.PUBLIC_PAGES.clear()
    locations = [item['location'] for item in chrome.NAVIGATION['publicPages']] + ['页面']
    chrome._SHARED_SHELL = {
        'marks': {key: '<span class="brand-mark">银河</span>' for key in ['', 'navigation-orbit', 'gh-hero-mark']},
        'headers': {location: '<header class="site-header"><a href="/">银河</a><span>' + location + '</span></header>' for location in locations},
        'rails': {'public': '<nav class="global-rail" aria-label="银河"><a href="/app/">发现</a></nav>',
                  'account': '<nav class="global-rail" aria-label="银河"><a href="/app/account">账户</a></nav>'},
    }
    metadata = {
        'releaseId': 'fixture-site', 'backendRelease': 'fixture-api',
        'nativeClientDownload': {
            'downloadBase': '/downloads/native-client/0.1.16/',
            'package': {'version': '0.1.16', 'filename': 'galaxy-client.zip', 'bytes': 21, 'sha256': 'fixture-release-value'},
            'installBundle': {'filename': 'galaxy-install.zip'},
            'guides': {key: '/docs/native-client/0.1.16/' + key + '/' for key in ['installation', 'hosts', 'runtime']},
        },
    }
    write_json(directory / 'release.json', metadata)
    render_product_pages(vars(chrome))
    guide = '/docs/native-client/0.1.16/installation/'
    chrome.page(guide, '当前安装说明', '真实版本资料', '<article><h1>安装说明</h1><p>保留版本化说明。</p></article>')
    write_json(directory / 'assets/public-pages/index.json', {'version': 1, 'routes': list(chrome.PUBLIC_PAGES)})
    (directory / 'sitemap.xml').write_text(
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        '<url><loc>https://agigalaxy.org/</loc></url></urlset>', encoding='utf-8')
    artifact = directory / 'downloads/native-client/0.1.16'
    artifact.mkdir(parents=True)
    for filename, data in [('galaxy-client.zip', b'original client artifact'),
                           ('galaxy-install.zip', b'original install artifact'),
                           ('release.jws', b'original release signature')]:
        (artifact / filename).write_bytes(data)
    return metadata


def snapshot(pages=None, media=None):
    return {
        'version': 1,
        'settings': {'siteTitle': '银河', 'description': '银河公开说明',
                     'footerLinks': [{'label': '帮助', 'href': '/help/welcome/'},
                                     {'label': '隐私与数据', 'href': '/privacy/'}]},
        'pages': pages or [], 'media': media or [],
    }


def page(path='/help/welcome/', blocks=None, title='使用帮助'):
    return {'id': 'page-1', 'path': path, 'title': title, 'description': '从这里继续。',
            'blocks': blocks or [], 'updatedAt': '2026-10-20T12:00:00.000Z'}


def tree_nodes(nodes):
    for node in nodes:
        if isinstance(node, dict):
            yield node
            yield from tree_nodes(node['children'])


class PublishedContentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.site = self.root / 'candidate'
        baseline(self.site)

    def test_home_shared_pages_images_and_real_downloads_remain_one_site(self):
        media = self.root / 'cms-media'
        media.mkdir()
        (media / '帮助.png').write_bytes(PNG)
        (media / 'unreferenced-private.txt').write_text('not a publication source', encoding='utf-8')
        release_before = (self.site / 'release.json').read_bytes()
        signature = self.site / 'downloads/native-client/0.1.16/release.jws'
        signature_before = signature.read_bytes()
        original_home = (self.site / 'index.html').read_text(encoding='utf-8')
        home = page('/', [
            {'blockType': 'hero', 'heading': '继续自己的事情', 'text': '先看看，再按需要参与。',
             'links': [{'label': '进入社区', 'href': '/app/community'}]},
            {'blockType': 'notice', 'tone': 'information', 'title': '新说明', 'text': '<script>只是文字</script>'},
        ])
        help_page = page(blocks=[
            {'blockType': 'prose', 'heading': '开始', 'body': '第一段。\n继续阅读。\n\n第二段。'},
            {'blockType': 'image', 'mediaId': 'image-1', 'caption': '帮助配图'},
            {'blockType': 'releaseLinks', 'heading': '下载', 'channel': 'stable', 'label': '下载客户端'},
        ])
        download = page('/downloads/', [{'blockType': 'notice', 'tone': 'service-impact',
                                        'title': '安装提示', 'text': '请按当前安装说明操作。'}], '安装客户端')
        selected = snapshot([home, help_page, download], [{
            'id': 'image-1', 'filename': '帮助.png', 'url': 'https://admin.example.invalid/api/media/file/help.png',
            'alt': '使用步骤示意', 'width': 1, 'height': 1, 'mimeType': 'image/png',
            'filesize': len(PNG), 'credit': '配图作者 · CC BY 4.0',
        }])
        result = apply_snapshot(self.site, selected, media)
        rendered_home = (self.site / 'index.html').read_text(encoding='utf-8')
        self.assertIn('继续自己的事情', rendered_home)
        self.assertIn('&lt;script&gt;只是文字&lt;/script&gt;', rendered_home)
        self.assertIn('class="gh-hero-network"', rendered_home)
        self.assertIn('data-home-example=', rendered_home)
        self.assertEqual(original_home.count('/assets/home-experience.js'), rendered_home.count('/assets/home-experience.js'))
        rendered_help = (self.site / 'help/welcome/index.html').read_text(encoding='utf-8')
        self.assertEqual(rendered_help.count('<main '), 1)
        self.assertEqual(rendered_help.count('class="global-rail"'), 1)
        self.assertIn('/assets/public-bootstrap.js', rendered_help)
        self.assertIn('/downloads/native-client/0.1.16/galaxy-install.zip', rendered_help)
        self.assertNotIn('admin.example.invalid', rendered_help)
        self.assertIn('配图作者 · CC BY 4.0', rendered_help)
        data = json.loads((self.site / 'assets/public-pages/help/welcome/index.json').read_text(encoding='utf-8'))
        image = next(node for node in tree_nodes(data['body']) if node['tag'] == 'img')
        self.assertEqual(image['attrs']['src'], '/media/cms/image-1/%E5%B8%AE%E5%8A%A9.png')
        self.assertEqual(image['attrs']['alt'], '使用步骤示意')
        self.assertEqual((self.site / 'media/cms/image-1/帮助.png').read_bytes(), PNG)
        self.assertFalse((self.site / 'media/cms/unreferenced-private.txt').exists())
        rendered_download = (self.site / 'downloads/index.html').read_text(encoding='utf-8')
        self.assertIn('安装客户端', slot_content(rendered_download, 'page-intro'))
        self.assertIn('id="client-package"', slot_content(rendered_download, 'page-body'))
        self.assertIn('0.1.16', rendered_download)
        self.assertIn('安装提示', slot_content(rendered_download, 'page-extra'))
        self.assertEqual((self.site / 'release.json').read_bytes(), release_before)
        self.assertEqual(signature.read_bytes(), signature_before)
        self.assertIn('/help/welcome/', json.loads((self.site / 'assets/public-pages/index.json').read_text(encoding='utf-8'))['routes'])
        self.assertEqual(result['routes'], ['/help/welcome/', '/downloads/'])
        self.assertIn('https://agigalaxy.org/help/welcome/', (self.site / 'sitemap.xml').read_text(encoding='utf-8'))
        apply_snapshot(self.site, selected, media)
        self.assertEqual((self.site / 'help/welcome/index.html').read_text(encoding='utf-8'), rendered_help)
        self.assertEqual((self.site / 'index.html').read_text(encoding='utf-8'), rendered_home)

    def test_reserved_and_versioned_routes_do_not_replace_existing_capabilities(self):
        before = (self.site / 'index.html').read_bytes()
        for path in ['/app/', '/v1/lookup/', '/v2/service/', '/api/', '/assets/', '/admin/',
                     '/archives/public/docs/', '/downloads/native-client/', '/docs/native-client/0.1.16/installation/']:
            with self.subTest(path=path), self.assertRaises(ContentError):
                apply_snapshot(self.site, snapshot([page(path)]))
        self.assertEqual((self.site / 'index.html').read_bytes(), before)
        self.assertFalse((self.site / 'cms-routes.json').exists())

    def test_invalid_block_or_url_fails_before_any_candidate_write(self):
        before = (self.site / 'index.html').read_bytes()
        cases = [
            {'blockType': 'html', 'html': '<script>bad()</script>'},
            {'blockType': 'linkList', 'heading': '链接', 'links': [{'label': 'bad', 'href': 'javascript:bad()'}]},
            {'blockType': 'linkList', 'heading': '链接', 'links': [{'label': 'bad', 'href': '//another.example/path'}]},
            {'blockType': 'notice', 'tone': 'open-all', 'title': 'bad', 'text': 'bad'},
        ]
        for block in cases:
            with self.subTest(kind=block['blockType']), self.assertRaises(ContentError):
                apply_snapshot(self.site, snapshot([page(blocks=[block])]))
        self.assertEqual((self.site / 'index.html').read_bytes(), before)
        self.assertFalse((self.site / 'help/welcome/index.html').exists())

    def test_only_explicit_regular_referenced_images_are_read(self):
        media = self.root / 'cms-media'
        media.mkdir()
        selected = snapshot([page(blocks=[{'blockType': 'image', 'mediaId': 'image-1', 'caption': ''}])], [{
            'id': 'image-1', 'filename': '../outside.png', 'mimeType': 'image/png', 'alt': '配图',
        }])
        (self.root / 'outside.png').write_bytes(PNG)
        with self.assertRaises(ContentError):
            apply_snapshot(self.site, selected, media)
        selected['media'][0]['filename'] = 'private.png'
        (media / 'private.png').write_text('private material is not an image', encoding='utf-8')
        with self.assertRaises(ContentError):
            apply_snapshot(self.site, selected, media)
        with self.assertRaises(ContentError):
            apply_snapshot(self.site, selected)
        self.assertFalse((self.site / 'cms-routes.json').exists())

    def test_unrelated_prebuilt_page_is_not_overwritten(self):
        existing = self.site / 'legacy-page/index.html'
        existing.parent.mkdir()
        existing.write_text('original independent document', encoding='utf-8')
        with self.assertRaises(ContentError):
            apply_snapshot(self.site, snapshot([page('/legacy-page/')]))
        self.assertEqual(existing.read_text(encoding='utf-8'), 'original independent document')

    def test_source_or_candidate_link_cannot_escape_selected_directories(self):
        media = self.root / 'cms-media'
        media.mkdir()
        outside = self.root / 'outside.png'
        outside.write_bytes(PNG)
        try:
            (media / 'linked.png').symlink_to(outside)
        except OSError:
            self.skipTest('This local account cannot create a test symlink')
        selected = snapshot([page(blocks=[{'blockType': 'image', 'mediaId': 'image-1', 'caption': ''}])], [{
            'id': 'image-1', 'filename': 'linked.png', 'mimeType': 'image/png', 'alt': '配图',
        }])
        with self.assertRaises(ContentError):
            apply_snapshot(self.site, selected, media)
        target = self.site / 'help'
        target.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ContentError):
            apply_snapshot(self.site, snapshot([page()]))
        self.assertFalse((self.root / 'welcome/index.html').exists())


if __name__ == '__main__':
    unittest.main()
