"""Shared authored content slots for site generation and CMS publication."""
import re


def content_slot(name, content=''):
    if not re.fullmatch(r'[a-z][a-z-]*', name):
        raise ValueError('Invalid content slot name')
    return f'<!--galaxy-cms:{name}:start-->{content}<!--galaxy-cms:{name}:end-->'


def home_slots(body):
    """Mark the authored copy; leave the interactive illustration untouched."""
    start = body.find('<div class="gh-hero-copy">')
    following = body.find('<div class="gh-hero-network"', start)
    if start < 0 or following < 0:
        raise ValueError('The homepage is missing its authored hero copy')
    copy = body[start:following]
    return body[:start] + content_slot('home-hero', copy) + body[following:]
