"""Apply published CMS content to an explicit, prebuilt website candidate.

The publisher supplies a fresh copy of the built site. This module only writes
controlled content slots, public reading trees and referenced local images. It
does not build the application, contact a service or activate a website.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
from html import escape, unescape
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from urllib.parse import quote, unquote, urlsplit
import xml.etree.ElementTree as ET

from public_reading import reading_tree


ORIGIN = 'https://agigalaxy.org'
TEMPLATE_PATH = 'assets/cms-page-template.json'
ROUTES_PATH = 'cms-routes.json'
READING_INDEX = 'assets/public-pages/index.json'
TOKENS = {
    'title': '__GALAXY_CMS_TITLE__',
    'description': '__GALAXY_CMS_DESCRIPTION__',
    'path': '__GALAXY_CMS_PATH__',
    'body': '__GALAXY_CMS_BODY__',
}
RESERVED = {'admin', 'api', 'app', 'v1', 'v2', 'preview', 'assets', 'archives',
            'media', 'releases', 'downloads', 'docs', '404'}
MANAGED_EXISTING = {'/how-it-works/', '/network/', '/privacy/', '/start/',
                    '/docs/', '/downloads/', '/downloads/verification/', '/status/'}
RELEASE_PAGES = {'/downloads/', '/downloads/verification/', '/status/'}
IMAGE_TYPES = {
    'image/png': {'.png'}, 'image/jpeg': {'.jpg', '.jpeg'},
    'image/webp': {'.webp'}, 'image/gif': {'.gif'}, 'image/avif': {'.avif'},
}
MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
MAX_MEDIA_BYTES = 20 * 1024 * 1024
MAX_REFERENCED_MEDIA_BYTES = 256 * 1024 * 1024


class ContentError(ValueError):
    """Invalid published content or an unsuitable candidate directory."""


def content_slot(name, content=''):
    if not re.fullmatch(r'[a-z][a-z-]*', name):
        raise ContentError('Invalid content slot name')
    return f'<!--galaxy-cms:{name}:start-->{content}<!--galaxy-cms:{name}:end-->'


def slot_content(document, name):
    start, end = f'<!--galaxy-cms:{name}:start-->', f'<!--galaxy-cms:{name}:end-->'
    if document.count(start) != 1 or document.count(end) != 1:
        raise ContentError('The prebuilt page is missing its ' + name + ' slot')
    first = document.index(start) + len(start)
    last = document.index(end)
    if last < first:
        raise ContentError('Invalid content slot order')
    return document[first:last]


def replace_slot(document, name, content):
    previous = slot_content(document, name)
    return document.replace(content_slot(name, previous), content_slot(name, content), 1)


def home_slots(body):
    """Mark the authored copy; leave the interactive illustration untouched."""
    start = body.find('<div class="gh-hero-copy">')
    following = body.find('<div class="gh-hero-network"', start)
    if start < 0 or following < 0:
        raise ContentError('The homepage is missing its authored hero copy')
    copy = body[start:following]
    return body[:start] + content_slot('home-hero', copy) + body[following:]


def _object(value, label):
    if not isinstance(value, dict):
        raise ContentError(label + ' must be an object')
    return value


def _text(value, label, maximum, *, required=False):
    if not isinstance(value, str) or len(value) > maximum:
        raise ContentError(label + ' must be text within its limit')
    if any(ord(char) < 32 and char not in '\n\r\t' for char in value):
        raise ContentError(label + ' contains an unsupported control character')
    if required and not value.strip():
        raise ContentError(label + ' cannot be empty')
    return value


def safe_href(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        return False
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value) or '\\' in value:
        return False
    if value.startswith('/'):
        return not value.startswith('//') and '\\' not in unquote(value)
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == 'https' and bool(parsed.hostname)
                and not parsed.username and not parsed.password)
    except ValueError:
        return False


def page_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'/(?:[a-z0-9]+(?:-[a-z0-9]+)*/)*', value):
        raise ContentError('A page needs a lowercase, slash-delimited path')
    if value != '/' and value not in MANAGED_EXISTING and value.split('/')[1] in RESERVED:
        raise ContentError('A CMS page cannot replace this website area')
    return value


def _links(value, label):
    if not isinstance(value, list) or len(value) > 12:
        raise ContentError(label + ' must contain at most twelve links')
    result = []
    for item in value:
        item = _object(item, label)
        if not safe_href(item.get('href')):
            raise ContentError(label + ' contains an unsupported URL')
        result.append({'label': _text(item.get('label'), label + ' label', 100, required=True),
                       'href': item['href'],
                       'description': _text(item.get('description', ''), label + ' description', 600)})
    return result


def _filename(value):
    if (not isinstance(value, str) or not value or len(value) > 220
            or value in {'.', '..'} or '/' in value or '\\' in value or ':' in value
            or value[-1] in '. ' or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or any(char in '<>"|?*' for char in value)
            or re.fullmatch(r'(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', value)):
        raise ContentError('A referenced image needs its stored, ordinary filename')
    return value


def _is_reparse(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _root(path, label):
    chosen = Path(path).absolute()
    if not chosen.is_dir() or _is_reparse(chosen):
        raise ContentError(label + ' must be an explicit, ordinary directory')
    return chosen.resolve()


def _within(root, relative, *, existing=False):
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts:
        raise ContentError('A candidate path escaped its directory')
    target = root / relative
    current = root
    for part in relative.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            if _is_reparse(current):
                raise ContentError('Content paths cannot use links or junctions')
        elif existing:
            raise ContentError('A required candidate file is missing')
    if not target.resolve().is_relative_to(root):
        raise ContentError('A candidate path escaped its directory')
    if existing and not stat.S_ISREG(target.stat().st_mode):
        raise ContentError('A required candidate file must be an ordinary file')
    return target


def _read_json(path, limit=MAX_SNAPSHOT_BYTES):
    if not path.is_file() or path.stat().st_size > limit:
        raise ContentError('A required JSON file is missing or too large')
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (ValueError, UnicodeError) as error:
        raise ContentError('A required file is not valid UTF-8 JSON') from error


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def _has_image_header(data, mime):
    if mime == 'image/png':
        return data.startswith(b'\x89PNG\r\n\x1a\n')
    if mime == 'image/jpeg':
        return data.startswith(b'\xff\xd8\xff')
    if mime == 'image/webp':
        return data.startswith(b'RIFF') and data[8:12] == b'WEBP'
    if mime == 'image/gif':
        return data.startswith((b'GIF87a', b'GIF89a'))
    if mime == 'image/avif':
        return data[4:8] == b'ftyp' and any(brand in data[8:40] for brand in (b'avif', b'avis'))
    return False


@dataclass(frozen=True)
class Image:
    url: str
    alt: str
    credit: str
    width: int | None
    height: int | None


class Renderer:
    def __init__(self, release, images):
        self.release = release
        self.images = images

    @staticmethod
    def links(links, *, home=False):
        if home:
            return '<div class="gh-actions">' + ''.join(
                '<a class="gh-button' + (' gh-primary' if index == 0 else '')
                + '" href="' + escape(item['href'], quote=True) + '">' + escape(item['label']) + '</a>'
                for index, item in enumerate(links)) + '</div>'
        return '<ul class="cms-links">' + ''.join(
            '<li><a href="' + escape(item['href'], quote=True) + '">' + escape(item['label']) + '</a>'
            + ('<p>' + escape(item['description']) + '</p>' if item['description'] else '') + '</li>'
            for item in links) + '</ul>'

    def home_hero(self, page, hero=None, *, previous=''):
        heading = hero['heading'] if hero else page['title']
        text = hero['text'] if hero else page['description']
        if hero:
            actions = self.links(hero['links'], home=True)
        else:
            match = re.search(r'<div class="gh-actions">.*?</div>', previous, re.DOTALL)
            actions = match.group(0) if match else self.links([
                {'label': '探索银河', 'href': '/app/'}, {'label': '接入我的 AI', 'href': '/downloads/'},
            ], home=True)
        return ('<div class="gh-hero-copy"><h1>' + escape(heading) + '</h1>'
                + ('<p>' + escape(text) + '</p>' if text else '') + actions + '</div>\n')

    def release_links(self, block):
        native = self.release.get('nativeClientDownload')
        native = native if isinstance(native, dict) else {}
        package = native.get('installBundle') or native.get('package')
        package = package if isinstance(package, dict) else {}
        base = native.get('downloadBase')
        filename = package.get('filename')
        if (not isinstance(base, str) or not re.fullmatch(r'/downloads/native-client/[A-Za-z0-9_.-]+/', base)
                or not filename):
            raise ContentError('Stable client download metadata is unavailable')
        _filename(filename)
        url = base + quote(filename)
        title = '<h2>' + escape(block['heading']) + '</h2>' if block['heading'] else ''
        version = _text(package.get('version', native.get('package', {}).get('version', '')), 'release version', 100)
        return ('<section class="cms-block cms-release-links">' + title
                + ('<p>银河客户端 ' + escape(version) + '</p>' if version else '')
                + self.links([{'label': block['label'], 'href': url, 'description': ''},
                              {'label': '安装说明', 'href': '/downloads/', 'description': ''},
                              {'label': '发行资料', 'href': '/downloads/verification/', 'description': ''}])
                + '</section>')

    def blocks(self, blocks):
        result = []
        for block in blocks:
            kind = block['blockType']
            heading = block.get('heading', '')
            title = '<h2>' + escape(heading) + '</h2>' if heading else ''
            if kind == 'hero':
                result.append('<section class="cms-block cms-hero">' + title
                              + ('<p>' + escape(block['text']) + '</p>' if block['text'] else '')
                              + self.links(block['links']) + '</section>')
            elif kind == 'prose':
                paragraphs = [paragraph for paragraph in re.split(r'\n\s*\n', block['body'].replace('\r\n', '\n')) if paragraph.strip()]
                result.append('<section class="cms-block cms-prose">' + title + ''.join(
                    '<p>' + escape(paragraph).replace('\n', '<br>') + '</p>' for paragraph in paragraphs) + '</section>')
            elif kind == 'linkList':
                result.append('<nav class="cms-block cms-link-list" aria-label="' + escape(heading or '相关内容', quote=True)
                              + '">' + title + self.links(block['links']) + '</nav>')
            elif kind == 'notice':
                result.append('<aside class="cms-block cms-notice cms-notice-' + block['tone'] + '"><h2>'
                              + escape(block['title']) + '</h2><p>' + escape(block['text']) + '</p></aside>')
            elif kind == 'image':
                image = self.images[block['mediaId']]
                dimensions = ''.join(' ' + name + '="' + str(value) + '"' for name, value in
                                     [('width', image.width), ('height', image.height)] if value is not None)
                caption = ('<p>' + escape(block['caption']) + '</p>' if block['caption'] else '')
                credit = '<p class="cms-media-credit">' + escape(image.credit) + '</p>' if image.credit else ''
                result.append('<figure class="cms-block cms-image"><img src="' + escape(image.url, quote=True)
                              + '" alt="' + escape(image.alt, quote=True) + '" loading="lazy" decoding="async"'
                              + dimensions + '>' + ('<figcaption>' + caption + credit + '</figcaption>' if caption or credit else '') + '</figure>')
            elif kind == 'releaseLinks':
                result.append(self.release_links(block))
        return ''.join(result)


def _block(value):
    block = _object(value, 'A content block')
    kind = block.get('blockType')
    if not isinstance(kind, str):
        raise ContentError('A content block needs its supported type')
    result = {'blockType': kind}
    if kind in {'hero', 'prose', 'linkList', 'releaseLinks'}:
        result['heading'] = _text(block.get('heading', ''), 'block heading', 240, required=kind == 'hero')
    if kind in {'hero', 'linkList'}:
        result['links'] = _links(block.get('links', []), 'block links')
    if kind == 'hero':
        result['text'] = _text(block.get('text', ''), 'hero text', 4000)
    elif kind == 'prose':
        result['body'] = _text(block.get('body'), 'prose body', 30000)
    elif kind == 'notice':
        if block.get('tone') not in {'information', 'service-impact'}:
            raise ContentError('Unknown notice tone')
        result.update(tone=block['tone'], title=_text(block.get('title'), 'notice title', 240, required=True),
                      text=_text(block.get('text'), 'notice text', 4000))
    elif kind == 'image':
        result.update(mediaId=_text(block.get('mediaId'), 'image reference', 100, required=True),
                      caption=_text(block.get('caption', ''), 'image caption', 800))
    elif kind == 'releaseLinks':
        if block.get('channel') != 'stable':
            raise ContentError('Release links must use the existing stable channel')
        result.update(channel='stable', label=_text(block.get('label'), 'release link label', 100, required=True))
    elif kind != 'linkList':
        raise ContentError('Unsupported CMS content block')
    return result


def _snapshot(value):
    value = _object(value, 'Published snapshot')
    if value.get('version') != 1:
        raise ContentError('Unsupported published snapshot version')
    settings = _object(value.get('settings'), 'Published site settings')
    settings = {'siteTitle': _text(settings.get('siteTitle'), 'site title', 120, required=True),
                'description': _text(settings.get('description', ''), 'site description', 600),
                'footerLinks': _links(settings.get('footerLinks', []), 'footer links')}
    pages, seen = value.get('pages'), set()
    if not isinstance(pages, list) or len(pages) > 500:
        raise ContentError('Published pages must be a bounded list')
    projected = []
    for item in pages:
        item = _object(item, 'A published page')
        path = page_path(item.get('path'))
        if path in seen:
            raise ContentError('Published page paths must be unique')
        seen.add(path)
        blocks = item.get('blocks')
        if not isinstance(blocks, list) or len(blocks) > 80:
            raise ContentError('A published page can contain at most eighty blocks')
        updated = _text(item.get('updatedAt', ''), 'page update time', 100)
        if updated:
            try:
                datetime.fromisoformat(updated.replace('Z', '+00:00'))
            except ValueError as error:
                raise ContentError('A published page has an invalid update time') from error
        projected.append({'path': path, 'title': _text(item.get('title'), 'page title', 240, required=True),
                          'description': _text(item.get('description', ''), 'page description', 600),
                          'blocks': [_block(block) for block in blocks], 'updatedAt': updated})
    media = value.get('media', [])
    if not isinstance(media, list):
        raise ContentError('Published media must be a list')
    return settings, projected, media


def _media_files(media, referenced, site, media_directory):
    if not referenced:
        return {}, {}
    if media_directory is None:
        raise ContentError('Referenced images require an explicit CMS media directory')
    source_root = _root(media_directory, 'CMS media directory')
    selected = {}
    for item in media:
        item = _object(item, 'A published media item')
        identifier = item.get('id')
        if not isinstance(identifier, str):
            raise ContentError('A published media item needs its identifier')
        if identifier not in referenced:
            continue
        if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', identifier):
            raise ContentError('Unsupported published media identifier')
        if identifier in selected:
            raise ContentError('Published media identifiers must be unique')
        selected[identifier] = item
    if set(selected) != referenced:
        raise ContentError('A page refers to an image absent from the published snapshot')
    images, writes, total = {}, {}, 0
    for identifier, item in selected.items():
        filename = _filename(item.get('filename'))
        mime = item.get('mimeType')
        if mime not in IMAGE_TYPES or Path(filename).suffix.lower() not in IMAGE_TYPES[mime]:
            raise ContentError('Only supported, ordinary image files can be published')
        source = _within(source_root, filename, existing=True)
        size = source.stat().st_size
        if size > MAX_MEDIA_BYTES:
            raise ContentError('A referenced image exceeds the supported publication size')
        total += size
        if total > MAX_REFERENCED_MEDIA_BYTES:
            raise ContentError('Referenced images exceed the publication size')
        data = source.read_bytes()
        if not _has_image_header(data, mime):
            raise ContentError('A referenced file does not match its image type')
        dimensions = {}
        for name in ('width', 'height'):
            dimension = item.get(name)
            if dimension is not None and (type(dimension) is not int or not 1 <= dimension <= 100000):
                raise ContentError('A referenced image has invalid dimensions')
            dimensions[name] = dimension
        relative = 'media/cms/' + identifier + '/' + filename
        url = '/media/cms/' + identifier + '/' + quote(filename)
        images[identifier] = Image(url, _text(item.get('alt'), 'image alternative text', 400, required=True),
                                   _text(item.get('credit', ''), 'image credit', 1600), **dimensions)
        writes[_within(site, relative)] = data
    return images, writes


def _metadata(document, title, description):
    document, count = re.subn(r'<title>[^<]*</title>', lambda _: '<title>' + escape(title) + '</title>', document, count=1)
    if count != 1:
        raise ContentError('The prebuilt page is missing its document title')
    document, count = re.subn(r'<meta name="description" content="[^"]*">',
                              lambda _: '<meta name="description" content="' + escape(description, quote=True) + '">',
                              document, count=1)
    if count != 1:
        raise ContentError('The prebuilt page is missing its description')
    return document


def _intro(page):
    return '<header class="reading-intro"><h1>' + escape(page['title']) + '</h1>' + (
        '<p>' + escape(page['description']) + '</p>' if page['description'] else '') + '</header>'


def _page_html_path(path):
    return 'index.html' if path == '/' else path.strip('/') + '/index.html'


def _reading_path(path):
    return 'assets/public-pages' + path + 'index.json'


def _template_document(template, page, content):
    document = template.get('html')
    if template.get('version') != 1 or not isinstance(document, str):
        raise ContentError('The prebuilt shared page template is invalid')
    values = {'title': escape(page['title']), 'description': escape(page['description'], quote=True),
              'path': page['path'], 'body': content}
    # Replace authored tokens in one pass; user text is never interpreted as a token.
    by_token = {TOKENS[name]: value for name, value in values.items()}
    if any(token not in document for token in TOKENS.values()):
        raise ContentError('The prebuilt shared page template is incomplete')
    pattern = '|'.join(re.escape(token) for token in TOKENS.values())
    return re.sub(pattern, lambda match: by_token[match.group(0)], document)


def _atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.cms-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            # Only generated public artifacts are written here. The publisher
            # shares their read-only group with the web server; its private
            # snapshot and selected-media input remain in a separate 0700 tree.
            os.chmod(temporary, 0o640)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def apply_snapshot(site_directory, snapshot, media_directory=None):
    """Prepare all content in memory, then write only inside the candidate site.

    Each publication attempt starts from the controlled prebuilt baseline. An
    unsuccessful candidate is discarded. Reapplying a completed snapshot replaces
    slots rather than adding duplicate content. No live pointer is handled here.
    """
    site = _root(site_directory, 'Website candidate')
    if site == Path(__file__).resolve().parent or (site / 'cms_content.py').exists():
        raise ContentError('Choose a prebuilt website candidate, not its source directory')
    _within(site, 'index.html', existing=True)
    release = _object(_read_json(_within(site, 'release.json', existing=True)), 'Existing release metadata')
    template = _object(_read_json(_within(site, TEMPLATE_PATH, existing=True)), 'Shared page template')
    index = _object(_read_json(_within(site, READING_INDEX, existing=True)), 'Public reading index')
    baseline_routes = index.get('routes')
    if index.get('version') != 1 or not isinstance(baseline_routes, list):
        raise ContentError('The prebuilt public reading index is invalid')
    if any(not isinstance(path, str) or not re.fullmatch(r'/(?:[a-zA-Z0-9_.-]+/)+', path) for path in baseline_routes):
        raise ContentError('The prebuilt public reading index contains an invalid path')
    settings, pages, media = _snapshot(snapshot)
    published = {page['path']: page for page in pages}
    referenced = {block['mediaId'] for page in pages for block in page['blocks'] if block['blockType'] == 'image'}
    images, writes = _media_files(media, referenced, site, media_directory)
    renderer = Renderer(release, images)
    footer_links = ''.join('<a href="' + escape(item['href'], quote=True) + '">' + escape(item['label']) + '</a>'
                           for item in settings['footerLinks'])
    routes = list(dict.fromkeys(baseline_routes + [page['path'] for page in pages if page['path'] != '/']))
    old_cms = _within(site, ROUTES_PATH)
    previous_routes = []
    if old_cms.exists():
        previous_routes = _object(_read_json(old_cms), 'Previous published route index').get('routes', [])
    for path in ['/'] + routes:
        existing_html = _within(site, _page_html_path(path))
        page = published.get(path)
        existing_data = None
        if existing_html.exists():
            if path not in baseline_routes and path != '/' and path not in previous_routes:
                raise ContentError('A CMS page cannot replace an unrelated prebuilt document')
            document = _within(site, _page_html_path(path), existing=True).read_text(encoding='utf-8')
            if path != '/':
                existing_data = _object(_read_json(_within(site, _reading_path(path), existing=True)), 'Existing public reading page')
        elif page is not None:
            content = _intro(page) + renderer.blocks(page['blocks'])
            document = _template_document(template, page, content)
        else:
            raise ContentError('A page listed by the baseline is missing')
        if page is not None:
            if path == '/':
                previous = slot_content(document, 'home-hero')
                hero = next((block for block in page['blocks'] if block['blockType'] == 'hero'), None)
                document = replace_slot(document, 'home-hero', renderer.home_hero(page, hero, previous=previous))
                remaining = [block for block in page['blocks'] if block is not hero]
                document = replace_slot(document, 'page-extra', '<div class="cms-home-content">' + renderer.blocks(remaining) + '</div>' if remaining else '')
            elif path in RELEASE_PAGES:
                document = replace_slot(document, 'page-intro', _intro(page))
                document = replace_slot(document, 'page-extra', renderer.blocks(page['blocks']))
            else:
                document = replace_slot(document, 'page-body', _intro(page) + renderer.blocks(page['blocks']))
                document = replace_slot(document, 'page-extra', '')
            document_title, description = page['title'] + ' · ' + settings['siteTitle'], page['description']
        elif path == '/':
            title = re.search(r'<title>([^<]*)</title>', document)
            description_meta = re.search(r'<meta name="description" content="([^"]*)">', document)
            if title is None or description_meta is None:
                raise ContentError('The homepage is missing its document metadata')
            # Site settings affect metadata, never the shared logo or navigation.
            document_title = unescape(title.group(1)).rsplit(' · ', 1)[0] + ' · ' + settings['siteTitle']
            description = settings['description'] or unescape(description_meta.group(1))
        else:
            original_title = _text(existing_data.get('title'), 'existing page title', 1000)
            document_title = original_title.rsplit(' · ', 1)[0] + ' · ' + settings['siteTitle']
            description = _text(existing_data.get('description'), 'existing page description', 4000)
        document = _metadata(document, document_title, description)
        document = replace_slot(document, 'footer-links', footer_links)
        writes[existing_html] = document.encode('utf-8')
        if path != '/':
            data = dict(existing_data) if existing_data is not None else {
                'version': 1, 'path': path, 'location': '页面', 'behaviors': [],
                'sidebar': template.get('sidebar'),
            }
            data.update(title=document_title, description=description)
            if not isinstance(data.get('sidebar'), list):
                raise ContentError('The shared page template is missing its reading navigation')
            data['body'] = reading_tree(slot_content(document, 'reading-body'))
            data['footer'] = reading_tree(slot_content(document, 'footer'))
            writes[_within(site, _reading_path(path))] = _json_bytes(data)
    writes[_within(site, READING_INDEX)] = _json_bytes({'version': 1, 'routes': routes})
    cms_routes = [page['path'] for page in pages if page['path'] != '/']
    writes[_within(site, ROUTES_PATH)] = _json_bytes({'version': 1, 'routes': cms_routes})
    sitemap = _within(site, 'sitemap.xml')
    if sitemap.exists():
        sitemap = _within(site, 'sitemap.xml', existing=True)
        try:
            root = ET.fromstring(sitemap.read_text(encoding='utf-8'))
        except ET.ParseError as error:
            raise ContentError('The prebuilt sitemap is not valid XML') from error
        namespace = root.tag[1:].split('}')[0] if root.tag.startswith('{') else ''
        tag = lambda name: '{' + namespace + '}' + name if namespace else name
        if namespace:
            ET.register_namespace('', namespace)
        locations = {node.text for node in root.iter(tag('loc'))}
        for page in pages:
            url = ORIGIN + page['path']
            if url in locations:
                continue
            entry = ET.SubElement(root, tag('url'))
            ET.SubElement(entry, tag('loc')).text = url
            if page['updatedAt']:
                ET.SubElement(entry, tag('lastmod')).text = page['updatedAt']
            locations.add(url)
        writes[sitemap] = ET.tostring(root, encoding='utf-8', xml_declaration=True) + b'\n'
    # All parsing, source selection and destination resolution happen before writes.
    for destination, data in writes.items():
        _atomic_write(destination, data)
    return {'version': 1, 'pages': [page['path'] for page in pages], 'routes': cms_routes,
            'media': [image.url for image in images.values()]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', required=True, type=Path)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--media-dir', type=Path)
    args = parser.parse_args(argv)
    try:
        snapshot_path = args.snapshot.absolute()
        if snapshot_path.is_symlink() or _is_reparse(snapshot_path):
            raise ContentError('Choose an ordinary published snapshot file')
        result = apply_snapshot(args.site, _read_json(snapshot_path), args.media_dir)
    except (ContentError, OSError, UnicodeError, ValueError) as error:
        # Do not echo a snapshot, URL or filesystem exception containing its data.
        message = str(error) if isinstance(error, ContentError) else 'The website candidate could not be prepared'
        print(json.dumps({'error': message}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
