"""A small, non-executable content tree shared with the current React shell."""
from html.parser import HTMLParser
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
            if name in ('src', 'alt', 'loading', 'decoding') and tag != 'img':
                raise ValueError('Image attributes require an image')
            properties[name] = value
        if tag == 'img' and (not re.fullmatch(r'/media/cms/[a-zA-Z0-9_-]+/(?:[a-zA-Z0-9._~-]|%[0-9a-fA-F]{2})+', properties.get('src', ''))
                or 'alt' not in properties or properties.get('loading') != 'lazy' or properties.get('decoding') != 'async'
                or any(key in properties and not re.fullmatch(r'[1-9][0-9]{0,5}', properties[key]) for key in ('width', 'height'))):
            raise ValueError('Unsafe public reading image')
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
