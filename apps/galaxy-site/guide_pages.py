"""Render the headings, paragraphs, lists, links, code and tables in our guides.

Original Markdown remains available verbatim. Embedded HTML is escaped, and
signed distribution files are never changed by this public reading view.
"""
from html import escape
from pathlib import PurePosixPath
import re
from urllib.parse import urljoin, urlsplit, urlunsplit


LABELS = {"installation": "安装客户端", "hosts": "宿主与接入", "runtime": "使用与专业配置"}
TOKEN = re.compile(r"(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*)")


def page_path(source):
    path = PurePosixPath(source)
    if not source.startswith('/docs/') or path.suffix != '.md' or '..' in path.parts:
        raise ValueError('Expected a versioned public guide')
    return str(path.with_suffix('')) + '/'


def inline(text, source, pages):
    result = []
    for part in TOKEN.split(text):
        if part.startswith('`') and part.endswith('`'):
            result.append('<code>' + escape(part[1:-1]) + '</code>')
        elif part.startswith('**') and part.endswith('**'):
            result.append('<strong>' + escape(part[2:-2]) + '</strong>')
        elif part.startswith('[') and '](' in part:
            label, href = part[1:-1].split('](', 1)
            parsed = urlsplit(urljoin('https://agigalaxy.org' + source, href))
            if parsed.scheme not in ('https', 'http') or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError('Unsupported guide link')
            if parsed.netloc == 'agigalaxy.org':
                href = urlunsplit(('', '', pages.get(parsed.path, parsed.path), parsed.query, parsed.fragment))
            download = ' download' if href.startswith('/downloads/') else ''
            result.append('<a href="' + escape(href, quote=True) + '"' + download + '>' + escape(label) + '</a>')
        else:
            # Keep archived source bytes intact; prose navigation uses words.
            result.append(escape(part.replace(' → ', '、')))
    return ''.join(result)


def render_markdown(markdown, source, pages):
    lines = markdown.splitlines()
    if not lines or not lines[0].startswith('# '):
        raise ValueError('Each versioned guide needs one title')
    title, blocks, headings = lines[0][2:], [], []
    i = 1
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith('```'):
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i])
                i += 1
            if i == len(lines):
                raise ValueError('Unclosed code block in versioned guide')
            blocks.append('<pre tabindex="0" aria-label="可复制的命令或配置"><code>' + escape('\n'.join(code)) + '</code></pre>')
            i += 1
            continue
        heading = re.fullmatch(r'(#{2,4}) (.+)', line)
        if heading:
            level, text = len(heading[1]), heading[2]
            anchor = 'section-' + str(len(headings) + 1)
            headings.append((level, anchor, text))
            blocks.append(f'<h{level} id="{anchor}">' + inline(text, source, pages) + f'</h{level}>')
            i += 1
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [cell.strip() for cell in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{3,}:?', cell) for cell in cells):
                    rows.append(cells)
                i += 1
            head, *body = rows
            if any(len(row) != len(head) for row in body):
                raise ValueError('Mismatched guide table columns')
            blocks.append('<div class="guide-table" role="region" aria-label="配置与支持对照" tabindex="0"><table><thead><tr>' +
                          ''.join('<th scope="col">' + inline(cell, source, pages) + '</th>' for cell in head) +
                          '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + inline(cell, source, pages) + '</td>' for cell in row) + '</tr>' for row in body) +
                          '</tbody></table></div>')
            continue
        item = re.fullmatch(r'(- |\d+\. )(.+)', line)
        if item:
            tag, pattern = ('ol', r'\d+\. (.+)') if item[1] != '- ' else ('ul', r'- (.+)')
            entries = []
            while i < len(lines) and (match := re.fullmatch(pattern, lines[i].strip())):
                entries.append('<li>' + inline(match[1], source, pages) + '</li>')
                i += 1
            blocks.append('<' + tag + '>' + ''.join(entries) + '</' + tag + '>')
            continue
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#{1,6} |```|\||- |\d+\. )', lines[i].strip()):
            paragraph.append(lines[i].strip())
            i += 1
        blocks.append('<p>' + inline(' '.join(paragraph), source, pages) + '</p>')
    return title, ''.join(blocks), headings


def render_versioned_guides(site, metadata):
    guides = metadata.get('nativeClientDownload', {}).get('guides', {})
    if not guides:
        return {}
    source_pages = {source: page_path(source) for source in guides.values()}
    community = metadata.get('webGuides', {}).get('community')
    if community:
        parsed = urlsplit(community)
        if parsed.netloc and (parsed.scheme != 'https' or parsed.netloc != 'agigalaxy.org'):
            raise ValueError('Community guide must belong to the public website')
        community = parsed.path
        source_pages[community] = page_path(community)
    version = metadata['nativeClientDownload']['package']['version']
    for kind, source in guides.items():
        raw_path = site['OUT'] / source.lstrip('/')
        if raw_path.is_symlink() or not raw_path.is_file():
            raise ValueError('Versioned guide source missing')
        title, content, headings = render_markdown(raw_path.read_text(encoding='utf-8'), source, source_pages)
        sections = ''.join('<a href="#' + anchor + '">' + escape(label) + '</a>' for level, anchor, label in headings if level == 2)
        siblings = ''.join('<a href="' + escape(source_pages[path], quote=True) + '"' + (' aria-current="page"' if current == kind else '') + '>' + LABELS[current] + '</a>' for current, path in guides.items())
        body = ('<div class="guide-breadcrumb"><a href="/downloads/">连接你的 AI</a><span aria-hidden="true"> / </span><span>本机接入 ' + escape(version) + '</span></div>' +
                '<nav class="guide-tabs" aria-label="客户端说明">' + siblings + '</nav>' +
                '<header class="guide-heading"><p class="release-label">开发候选 · ' + escape(version) + '</p><h1>' + escape(title) + '</h1></header>' +
                '<div class="guide-layout"><aside class="guide-contents"><nav aria-label="本页目录"><strong>本页内容</strong>' + sections + '</nav>' +
                '<a class="guide-original" href="' + escape(source, quote=True) + '">供 Agent 读取的 Markdown 原文</a></aside>' +
                '<article class="guide-body" aria-label="' + escape(LABELS[kind], quote=True) + '">' + content + '</article></div>')
        site['page'](source_pages[source], title, '本机接入 ' + version + ' 的' + LABELS[kind] + '，按当前目的阅读与操作。', body)
    result = {kind: source_pages[source] for kind, source in guides.items()}
    if community:
        raw_path = site['OUT'] / community.lstrip('/')
        if raw_path.is_symlink() or not raw_path.is_file():
            raise ValueError('Community guide source missing')
        title, content, headings = render_markdown(raw_path.read_text(encoding='utf-8'), community, source_pages)
        sections = ''.join('<a href="#' + anchor + '">' + escape(label) + '</a>' for level, anchor, label in headings if level == 2)
        body = ('<div class="guide-breadcrumb"><a href="/docs/">使用说明</a><span aria-hidden="true"> / </span><span>社区与收藏</span></div>' +
                '<header class="guide-heading"><h1>' + escape(title) + '</h1></header>' +
                '<div class="guide-layout"><aside class="guide-contents"><nav aria-label="本页目录"><strong>本页内容</strong>' + sections + '</nav>' +
                '<a class="guide-original" href="' + escape(community, quote=True) + '">供 Agent 读取的 Markdown 原文</a></aside>' +
                '<article class="guide-body" aria-label="社区与收藏说明">' + content + '</article></div>')
        site['page'](source_pages[community], title, '按主题找到讨论，接续阅读并找回收藏。', body)
        result['community'] = source_pages[community]
    return result
