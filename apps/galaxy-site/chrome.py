"""Public content composed with the shared React website presentation."""
from html import escape
import json
from pathlib import Path
import subprocess
from public_reading import public_page_data
from cms_slots import content_slot, home_slots

ORIGIN = "https://agigalaxy.org"
PREVIEW = True
OUT = None
PUBLIC_PAGES = []
NAVIGATION = json.loads(Path(__file__).with_name('workspace-navigation.json').read_text(encoding='utf-8'))
_SHARED_SHELL = None


def configure_shell(node='node'):
    """Render once per build, including every public heading and brand use."""
    global _SHARED_SHELL
    request = {
        'origin': '',
        'locations': [item['location'] for item in NAVIGATION['publicPages']] + ['页面'],
        'markClasses': ['', 'navigation-orbit', 'gh-hero-mark'],
    }
    renderer = Path(__file__).with_name('render-shell.mjs')
    try:
        result = subprocess.run(
            [str(node), str(renderer)], input=json.dumps(request, ensure_ascii=False),
            capture_output=True, text=True, encoding='utf-8', check=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError('Node.js is required to render the shared website UI; select it with --node') from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError('Shared website UI rendering failed: ' + error.stderr.strip()) from error
    _SHARED_SHELL = json.loads(result.stdout)


def shared_shell():
    if _SHARED_SHELL is None:
        configure_shell()
    return _SHARED_SHELL


def write(path, value):
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding='utf-8')


def link(href, label, cls=''):
    return f'<a class="{cls}" href="{href}">{label}</a>'


def brand_mark(cls=''):
    return shared_shell()['marks'][cls]


def public_location(path):
    for item in NAVIGATION['publicPages']:
        if path == item['href'] or path.startswith(item['href']):
            return item['location']
    return '页面'


def public_sidebar(path, location):
    def item(href, label):
        current = ' aria-current="page"' if path == href else ''
        return '<a href="' + escape(href, quote=True) + '"' + current + '>' + escape(label) + '</a>'

    resources = [entry for entry in NAVIGATION['publicPages'] if entry['location'] != '账户']
    if location == '账户':
        links = [('/app/account', '概览'), ('/app/account?section=access', '接入与 AI'),
                 ('/app/bookmarks', '我的收藏'), ('/downloads/', '客户端下载')]
        if path == '/start/':
            links.append(('/start/', '开始使用说明'))
        if path == '/downloads/verification/':
            links.append(('/downloads/verification/', '下载核验与历史版本'))
        primary = '<h2>账户</h2><nav aria-label="账户栏目">' + ''.join(item(*entry) for entry in links) + '</nav>'
        secondary = '<p class="public-navigation-label">说明与资料</p><nav aria-label="说明与资料">'
    else:
        primary = '<h2>使用指南</h2>'
        secondary = '<nav aria-label="使用指南">'
        resources = NAVIGATION['publicPages']
    return ('<aside class="public-page-navigation">' + primary + secondary
            + ''.join(item(entry['href'], entry['label']) for entry in resources) + '</nav></aside>')


def page(path, title, description, body):
    brand = (
        f'<a class="brand" href="/" aria-label="银河首页">{brand_mark()}'
        '<span>银河 <span class="brand-divider" aria-hidden="true">/</span> <small>GALAXY</small></span></a>'
    )
    footer_links = ''.join(link(url, label) for url, label in [
        ('/how-it-works/', '关于银河'), ('/network/', '开放网络'), ('/docs/', '文档'),
        ('/privacy/', '隐私与数据'), ('/status/', '版本信息')
    ])
    continue_links = ''.join(link(url, label) for url, label in [
        ('/app/search', '找帮助'), ('/app/publish', '发起求助'), ('/app/work', '我的工作'),
        ('/app/rooms', '消息'), ('/app/account', '账户中心')
    ])
    is_home = path == '/'
    location = public_location(path)
    footer = (f'<footer class="site-footer"><div class="shell footer-grid">{brand}<nav aria-label="银河说明">{content_slot("footer-links", footer_links)}</nav></div>\n'
              f'<div class="shell footer-continue"><span>继续使用</span><nav aria-label="个人与工作入口">{continue_links}</nav></div>\n'
              '<div class="shell footer-bottom"><span>© 2026 银河 · GALAXY NETWORK</span>\n<span>'
              + ('交互示例中的资料、身份与回答均为预设内容。' if is_home else '从真实工作出发，由你决定下一步。')
              + '</span></div>\n</footer>')
    header = ''
    rail = ''
    if is_home:
        nav = ''.join(
            f'<a href="{url}">{label}</a>'
            for url, label in [('/app/', '发现'), ('/app/community', '社区'), ('/app/account?section=access', '接入与 AI')]
        )
        header = (f'<header class="site-header"><div class="shell header-inner">{brand}'
                  f'<nav aria-label="主要功能">{nav}</nav><div class="header-actions"><a class="site-enter" href="/app/">进入银河</a></div></div></header>')
        body = home_slots(body) + content_slot('page-extra')
    else:
        shared = shared_shell()
        rail = shared['rails']['account' if location == '账户' else 'public']
        header = shared['headers'][location]
        preview_note = '<div class="local-preview-label" role="note">本地重构预览 · 尚未发行</div>' if PREVIEW else ''
        sidebar = public_sidebar(path, location)
        body = content_slot('page-body', body) + content_slot('page-extra')
        data = public_page_data(path, title + ' · 银河', description, location, sidebar, preview_note + body, footer)
        write('assets/public-pages' + path + 'index.json', json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
        PUBLIC_PAGES.append(path)
    if is_home:
        from home_tree import trusted_tree
        write('assets/home-content.json', json.dumps({'version': 1, 'title': title + ' · 银河', 'description': description, 'header': trusted_tree(header), 'body': trusted_tree(body), 'footer': trusted_tree(footer)}, ensure_ascii=False, separators=(',', ':')) + '\n')
