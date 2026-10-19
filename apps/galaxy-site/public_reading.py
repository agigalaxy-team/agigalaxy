"""A small, non-executable content tree shared with the current React shell."""
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
CONTRACT = json.loads((ROOT / 'public-reading-contract.json').read_text(encoding='utf-8'))
TAGS, ATTRIBUTES, VOID = (set(CONTRACT[key]) for key in ('tags', 'attributes', 'voidTags'))


def safe_url(value):
    if (re.search(r'[\x00-\x20\x7f]', value) or value.startswith('//') or '\\' in value):
        return False
    if value.startswith(('/', '#')):
        return True
    parsed = urlsplit(value)
    return parsed.scheme in ('http', 'https') and bool(parsed.netloc) and not parsed.username and not parsed.password


class ReadingTree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = []
        self.stack = []
        self.nodes = 0
        self.text_length = 0

    def append(self, node):
        self.nodes += 1
        if self.nodes > CONTRACT['maxNodes'] or len(self.stack) > CONTRACT['maxDepth']:
            raise ValueError('Public reading content exceeds its limits')
        (self.stack[-1]['children'] if self.stack else self.root).append(node)

    def handle_starttag(self, tag, attrs):
        if tag not in TAGS:
            raise ValueError('Unsupported public reading tag: ' + tag)
        properties = {}
        for name, value in attrs:
            if name not in ATTRIBUTES or name in properties or value is None and name != 'download':
                raise ValueError('Unsupported public reading attribute: ' + name)
            value = value or ''
            if name == 'href' and not safe_url(value):
                raise ValueError('Unsafe public reading URL')
            properties[name] = value
        node = {'tag': tag, 'attrs': properties, 'children': []}
        self.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1]['tag'] != tag:
            raise ValueError('Unbalanced public reading content: ' + tag)
        self.stack.pop()

    def handle_data(self, text):
        self.text_length += len(text)
        if self.text_length > CONTRACT['maxTextLength']:
            raise ValueError('Public reading text exceeds its limit')
        self.append(text)


def reading_tree(fragment):
    parser = ReadingTree()
    parser.feed(fragment)
    parser.close()
    if parser.stack:
        raise ValueError('Unclosed public reading content')
    return parser.root


def public_page_data(path, title, description, location, sidebar, body, footer):
    return {'version': CONTRACT['version'], 'path': path, 'title': title,
            'description': description, 'location': location, 'behaviors': [],
            'sidebar': reading_tree(sidebar), 'body': reading_tree(body), 'footer': reading_tree(footer)}


class WebEntry(HTMLParser):
    def __init__(self):
        super().__init__()
        self.entries = []
        self.styles = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'module' and attrs.get('src'):
            self.entries.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet' and attrs.get('href'):
            self.styles.append(attrs['href'])


def web_entry_assets(directory):
    directory = directory.resolve()
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Choose an existing, explicit Web build directory')
    index = directory / 'index.html'
    if index.is_symlink() or not index.is_file():
        raise ValueError('The selected Web build is missing its index')
    parser = WebEntry()
    parser.feed(index.read_text(encoding='utf-8'))
    if len(parser.entries) != 1 or not parser.styles:
        raise ValueError('The selected Web build needs one entry and its styles')
    hashes = {}
    for name in parser.entries + parser.styles:
        if not re.fullmatch(r'/app/assets/[A-Za-z0-9_.-]+\.(?:js|css)', name):
            raise ValueError('Unexpected Web build entry URL')
        source = directory / name.removeprefix('/app/')
        if source.is_symlink() or not source.resolve().is_relative_to(directory) or not source.is_file():
            raise ValueError('Web build entry escaped the selected directory')
        hashes[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    return {'version': 1, 'entry': parser.entries[0], 'styles': parser.styles, 'sha256': hashes}
