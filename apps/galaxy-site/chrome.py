"""Shared public website shell and the unchanged orbital brand geometry."""
from html import escape

ORIGIN = "https://agigalaxy.org"
PREVIEW = True
OUT = None


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


def page(path, title, description, body):
    nav = ''.join(
        f'<a href="{url}"' + (' aria-current="page"' if path == url else '') + f'>{label}</a>'
        for url, label in [('/app/', '发现'), ('/app/community', '社区'), ('/downloads/', '接入')]
    )
    brand = (
        f'<a class="brand" href="/" aria-label="银河首页">{brand_mark()}'
        '<span>银河 <span class="brand-divider" aria-hidden="true">/</span> <small>GALAXY</small></span></a>'
    )
    footer_links = ''.join(link(url, label) for url, label in [
        ('/how-it-works/', '关于银河'), ('/network/', '开放网络'), ('/docs/', '文档'),
        ('/privacy/', '隐私与数据'), ('/status/', '服务与版本')
    ])
    continue_links = ''.join(link(url, label) for url, label in [
        ('/app/search', '找帮助'), ('/app/publish', '发起求助'), ('/app/work', '我的工作'),
        ('/app/rooms', '消息'), ('/app/account', '账户中心')
    ])
    is_home = path == '/'
    home_assets = (
        '<link rel="stylesheet" href="/assets/home-experience.css">'
        '<script src="/assets/home-experience.js" defer></script>' if is_home else ''
    )
    main_class = 'home-shell' if is_home else 'shell'
    html = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(title)} · 银河</title><meta name="description" content="{escape(description)}">
<meta name="theme-color" content="#ffffff"><link rel="canonical" href="{ORIGIN}{path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/site.css">
{home_assets}<script src="/assets/navigation.js" defer></script></head>
<body><a class="skip" href="#main">跳到内容</a>
<header class="site-header"><div class="shell header-inner">{brand}
<nav aria-label="主要功能">{nav}</nav><div class="header-actions"><a class="site-enter" href="/app/">进入银河</a></div>
</div></header>
<div class="navigation-progress" role="status" aria-live="polite" hidden>{brand_mark('navigation-orbit')}<span>正在打开页面</span></div>
<main class="{main_class}" id="main">{body}</main>
<footer class="site-footer"><div class="shell footer-grid">{brand}<nav aria-label="银河说明">{footer_links}</nav></div>
<div class="shell footer-continue"><span>继续使用</span><nav aria-label="个人与工作入口">{continue_links}</nav></div>
<div class="shell footer-bottom"><span>© 2026 银河 · GALAXY NETWORK</span>
<span>{'交互示例中的资料、身份与回答均为预设内容。' if is_home else '从真实工作出发，由你决定下一步。'}</span></div>
</footer></body></html>'''
    if PREVIEW:
        html = html.replace('<body>', '<body><div class="local-preview-label" role="note">本地重构预览 · 尚未发行</div>', 1)
        html = html.replace('<meta name="viewport"', '<meta name="robots" content="noindex,nofollow"><meta name="viewport"', 1)
    write('index.html' if is_home else path.strip('/') + '/index.html', html)
