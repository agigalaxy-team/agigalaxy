"""Public content composed with the shared React website presentation."""
from html import escape
import json
from pathlib import Path
import subprocess
from public_reading import public_page_data, reading_tree
from cms_slots import content_slot, home_slots, TEMPLATE_PATH, TOKENS

ORIGIN = "https://agigalaxy.org"
PREVIEW = True
OUT = None
WEB_ASSETS = None
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


def _document(path, title, description, body, header, rail, footer, is_home):
    home_assets = (
        '<link rel="stylesheet" href="/assets/home-experience.css">'
        '<script src="/assets/home-experience.js" defer></script>' if is_home else ''
    )
    main_class = 'home-shell' if is_home else 'workspace-main site-content public-content'
    body_class = '' if is_home else ' class="galaxy-site selected-shell selected-public-shell"'
    shell_assets = '' if is_home else '<link rel="stylesheet" data-galaxy-static-style href="/assets/selected-shell.css"><link rel="stylesheet" data-galaxy-static-style href="/assets/public-reading.css">'
    bootstrap = '<script type="module" src="/assets/public-bootstrap.js"></script>' if not is_home and WEB_ASSETS else ''
    root_start, root_end = ('', '') if is_home else ('<div id="root">', '</div>')
    static_style = '' if is_home else ' data-galaxy-static-style'
    html = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(title)} · 银河</title><meta name="description" content="{escape(description)}">
<meta name="theme-color" content="#ffffff"><link rel="canonical" href="{ORIGIN}{path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet"{static_style} href="/assets/site.css">
{home_assets}{shell_assets}<script type="module" src="/assets/navigation.js"></script>{bootstrap}</head>
<body{body_class}>{root_start}<a class="skip" href="#main">跳到内容</a>
{rail}{header}
<div class="navigation-progress" role="status" aria-live="polite" hidden>{brand_mark('navigation-orbit')}<span>正在打开页面</span></div>
<main class="{main_class}" id="main" tabindex="-1">{body}</main>
{content_slot('footer', footer)}{root_end}</body></html>'''
    if PREVIEW:
        html = html.replace('<body>', '<body><div class="local-preview-label" role="note">本地重构预览 · 尚未发行</div>', 1)
        html = html.replace('<meta name="viewport"', '<meta name="robots" content="noindex,nofollow"><meta name="viewport"', 1)
    return html


def _reading_content(sidebar, body):
    return ('<div class="public-reading-page"><div class="public-page-layout">' + sidebar
            + '<div class="public-page-content">' + content_slot('reading-body', body) + '</div></div></div>')


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
        body = _reading_content(sidebar, preview_note + body)
        if path == '/how-it-works/':
            # Capture the real shared chrome once during the ordinary site build.
            # CMS publication fills these text slots without launching Node again.
            generic_sidebar = public_sidebar('', '页面')
            template_body = preview_note + content_slot('page-body', TOKENS['body']) + content_slot('page-extra')
            template = {
                'version': 1,
                'html': _document(TOKENS['path'], TOKENS['title'], TOKENS['description'],
                                  _reading_content(generic_sidebar, template_body),
                                  shared['headers']['页面'], shared['rails']['public'], footer, False),
                'sidebar': reading_tree(generic_sidebar),
            }
            write(TEMPLATE_PATH, json.dumps(template, ensure_ascii=False, separators=(',', ':')) + '\n')
    html = _document(path, title, description, body, header, rail, footer, is_home)
    write('index.html' if is_home else path.strip('/') + '/index.html', html)
