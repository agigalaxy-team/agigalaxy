"""Shared authored content slots for site generation and CMS publication."""
import re


TEMPLATE_PATH = 'assets/cms-page-template.json'
TOKENS = {
    'title': '__GALAXY_CMS_TITLE__',
    'description': '__GALAXY_CMS_DESCRIPTION__',
    'path': '__GALAXY_CMS_PATH__',
    'body': '__GALAXY_CMS_BODY__',
}


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
