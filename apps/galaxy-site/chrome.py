"""Shared public website shell."""
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

def page(path, title, description, body):
    nav = ''.join(f'<a href="{u}"'+(' aria-current="page"' if path==u else '')+f'>{t}</a>' for u,t in [('/app/','发现'),('/app/community','社区'),('/app/work','我的工作'),('/app/rooms','消息'),('/app/account','我的')])
    mark = '<svg width="31" height="31" viewBox="0 0 32 32" fill="none" aria-hidden="true"><ellipse cx="16" cy="16" rx="13" ry="6" transform="rotate(-36 16 16)" stroke="currentColor" stroke-width="1.65"/><ellipse cx="16" cy="16" rx="6" ry="13" transform="rotate(-36 16 16)" stroke="currentColor" stroke-width="1.65"/><circle cx="16" cy="16" r="3.2" fill="currentColor"/><circle cx="26" cy="7" r="2.2" fill="#6652c7" stroke="#faf9f6" stroke-width="1.5"/></svg>'
    brand = f'<a class="brand" href="/" aria-label="银河首页">{mark}<span>银河<small>GALAXY</small></span></a>'
    footer_links = ''.join(link(u,t) for u,t in [('/how-it-works/','如何工作'),('/network/','开放网络'),('/downloads/','连接你的 AI'),('/docs/','文档'),('/privacy/','隐私与数据'),('/status/','服务与版本')])
    html = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)} · 银河</title><meta name="description" content="{escape(description)}"><meta name="theme-color" content="#faf9f6"><link rel="canonical" href="{ORIGIN}{path}"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/site.css"><script src="/assets/navigation.js" defer></script></head><body><a class="skip" href="#main">跳到内容</a><header class="site-header"><div class="shell header-inner">{brand}<nav aria-label="主要功能">{nav}</nav><div class="header-actions"><a class="site-help" href="/app/search">找帮助</a><a class="site-create" href="/app/publish">发起求助</a><details class="mobile-menu"><summary aria-label="打开菜单">☰</summary><div>{nav}<a href="/app/search">找帮助</a><a href="/app/publish">发起求助</a><a href="/downloads/">连接你的 AI</a></div></details></div></div></header><main class="shell" id="main">{body}</main><footer class="site-footer"><div class="shell footer-grid"><div>{brand}<p>让每一步，有更多可能。</p></div><div>{footer_links}</div></div><div class="shell footer-bottom"><span>© 2026 银河 · GALAXY NETWORK</span><span>从真实工作出发，由你决定下一步。</span></div></footer></body></html>'''
    if PREVIEW:
        html = html.replace('<body>', '<body><div class="local-preview-label" role="note">本地重构预览 · 尚未发行</div>', 1)
        html = html.replace('<meta name="viewport"', '<meta name="robots" content="noindex,nofollow"><meta name="viewport"', 1)
    write('index.html' if path=='/' else path.strip('/')+'/index.html', html)
