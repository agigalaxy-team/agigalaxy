"""Shared public website shell and the unchanged orbital brand geometry."""
from html import escape
import json
from pathlib import Path
from public_reading import public_page_data

ORIGIN = "https://agigalaxy.org"
PREVIEW = True
OUT = None
WEB_ASSETS = None
PUBLIC_PAGES = []
NAVIGATION = json.loads(Path(__file__).with_name('workspace-navigation.json').read_text(encoding='utf-8'))


def write(path, value):
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding='utf-8')


def link(href, label, cls=''):
    return f'<a class="{cls}" href="{href}">{label}</a>'


def brand_mark(cls=''):
    """Reuse the official source geometry, including the pale-pink satellite."""
    return (
        f'<svg class="brand-mark {escape(cls, quote=True)}" width="31" height="31" '
        'viewBox="0 0 32 32" fill="none" aria-hidden="true">'
        '<ellipse cx="16" cy="16" rx="13" ry="6" transform="rotate(-36 16 16)" '
        'stroke="currentColor" stroke-width="1.65"/>'
        '<ellipse cx="16" cy="16" rx="6" ry="13" transform="rotate(-36 16 16)" '
        'stroke="currentColor" stroke-width="1.65"/>'
        '<circle cx="16" cy="16" r="3.2" fill="currentColor"/>'
        '<circle cx="26" cy="7" r="2.2" fill="#d8a9be" stroke="#ffffff" stroke-width="1.5"/>'
        '</svg>'
    )


def navigation_icon(name):
    paths = {
        'home': '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
        'discover': '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5Z"/>',
        'community': '<path d="M7 17H4l-2 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M8 9h12a2 2 0 0 1 2 2v11l-4-3H8a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z"/>',
        'messages': '<path d="M21 11.5a9 9 0 0 1-9 9 10 10 0 0 1-4-.9L3 21l1.4-5a9 9 0 1 1 16.6-4.5Z"/>',
        'work': '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a23 23 0 0 0 18 0M12 11v4"/>',
        'account': '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
        'search': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
        'plus': '<path d="M12 5v14M5 12h14"/>',
    }
    return ('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + paths[name] + '</svg>')


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
    nav = ''.join(
        f'<a href="{url}"' + (' aria-current="page"' if path == url else '') + f'>{label}</a>'
        for url, label in [('/app/', '发现'), ('/app/community', '社区'), ('/app/account?section=access', '接入与 AI')]
    )
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
    footer = (f'<footer class="site-footer"><div class="shell footer-grid">{brand}<nav aria-label="银河说明">{footer_links}</nav></div>\n'
              f'<div class="shell footer-continue"><span>继续使用</span><nav aria-label="个人与工作入口">{continue_links}</nav></div>\n'
              '<div class="shell footer-bottom"><span>© 2026 银河 · GALAXY NETWORK</span>\n<span>'
              + ('交互示例中的资料、身份与回答均为预设内容。' if is_home else '从真实工作出发，由你决定下一步。')
              + '</span></div>\n</footer>')
    home_assets = (
        '<link rel="stylesheet" href="/assets/home-experience.css">'
        '<script src="/assets/home-experience.js" defer></script>' if is_home else ''
    )
    main_class = 'home-shell' if is_home else 'shell'
    header = (f'<header class="site-header"><div class="shell header-inner">{brand}'
              f'<nav aria-label="主要功能">{nav}</nav><div class="header-actions"><a class="site-enter" href="/app/">进入银河</a></div></div></header>')
    rail = ''
    if not is_home:
        primary = ''.join(
            '<a href="' + entry['href'] + '"' + (' aria-current="page"' if entry['href'] == '/app/account' and location == '账户' else '') + '>'
            + navigation_icon(entry['icon']) + '<span>' + entry['label'] + '</span></a>'
            for entry in NAVIGATION['primary']
        )
        rail = '<aside class="selected-global-rail" aria-label="银河全局导航"><nav class="selected-rail-primary" aria-label="主要功能">' + primary + '</nav></aside>'
        header = ('<header class="site-app-header selected-app-header"><div class="site-header-inner">'
                  '<a class="selected-header-brand" href="/" aria-label="银河首页"><span class="galaxy-mark">' + brand_mark() + '</span></a>'
                  '<p class="selected-context-title" aria-label="当前位置：银河 · ' + escape(location, quote=True) + '"><span>银河</span><span class="selected-context-divider" aria-hidden="true">·</span><span>' + escape(location) + '</span></p>'
                  '<search class="selected-header-search"><form action="/app/find" method="get">' + navigation_icon('search') + '<input name="q" type="search" maxlength="160" placeholder="搜索公开内容" aria-label="搜索银河公开内容"></form></search>'
                  '<nav class="selected-header-actions" aria-label="内容操作"><a class="selected-public-help" href="/docs/">文档</a>'
                  '<a class="site-create" href="/app/publish" aria-label="发起求助">' + navigation_icon('plus') + '<span>发起求助</span></a>'
                  '<a class="selected-account-entry" href="/app/account" aria-label="账户中心">' + navigation_icon('account') + '<span>账户</span></a></nav></div></header>')
        preview_note = '<div class="local-preview-label" role="note">本地重构预览 · 尚未发行</div>' if PREVIEW else ''
        sidebar = public_sidebar(path, location)
        data = public_page_data(path, title + ' · 银河', description, location, sidebar, preview_note + body, footer)
        write('assets/public-pages' + path + 'index.json', json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
        PUBLIC_PAGES.append(path)
        body = '<div class="public-reading-page"><div class="public-page-layout">' + sidebar + '<div class="public-page-content">' + preview_note + body + '</div></div></div>'
        main_class = 'workspace-main site-content public-content'
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
{home_assets}{shell_assets}<script src="/assets/navigation.js" defer></script>{bootstrap}</head>
<body{body_class}>{root_start}<a class="skip" href="#main">跳到内容</a>
{rail}{header}
<div class="navigation-progress" role="status" aria-live="polite" hidden>{brand_mark('navigation-orbit')}<span>正在打开页面</span></div>
<main class="{main_class}" id="main" tabindex="-1">{body}</main>
{footer}{root_end}</body></html>'''
    if PREVIEW:
        html = html.replace('<body>', '<body><div class="local-preview-label" role="note">本地重构预览 · 尚未发行</div>', 1)
        html = html.replace('<meta name="viewport"', '<meta name="robots" content="noindex,nofollow"><meta name="viewport"', 1)
    write('index.html' if is_home else path.strip('/') + '/index.html', html)
