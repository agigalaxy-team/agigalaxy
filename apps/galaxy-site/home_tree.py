"""Compile the authored homepage to data, never CMS or user supplied HTML."""
from html.parser import HTMLParser


class HomeTree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nodes = []
        self.stack = []

    def append(self, value):
        (self.stack[-1]['children'] if self.stack else self.nodes).append(value)

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'iframe', 'object') or any(name.startswith('on') for name, _ in attrs):
            raise ValueError('Executable authored homepage element rejected')
        node = {'tag': tag, 'attrs': dict((name, value if value is not None else '') for name, value in attrs), 'children': []}
        self.append(node)
        if tag not in ('area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'):
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack and self.stack[-1]['tag'] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1]['tag'] != tag:
            raise ValueError('Unbalanced homepage element: ' + tag)
        self.stack.pop()

    def handle_data(self, value):
        self.append(value)

    def handle_comment(self, value):
        if not value.startswith('galaxy-cms:'):
            return
        _, name, boundary = value.split(':')
        if boundary == 'start':
            node = {'tag': 'galaxy-slot', 'attrs': {'name': name}, 'children': []}
            self.append(node)
            self.stack.append(node)
        elif boundary == 'end':
            if not self.stack or self.stack[-1]['tag'] != 'galaxy-slot' or self.stack[-1]['attrs']['name'] != name:
                raise ValueError('Unbalanced homepage content slot')
            self.stack.pop()


def trusted_tree(source):
    parser = HomeTree()
    parser.feed(source)
    parser.close()
    if parser.stack:
        raise ValueError('Unclosed homepage element')
    return parser.nodes
