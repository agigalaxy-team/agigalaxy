"""Build the current public website from repository sources and pinned archives."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import urllib.parse
import urllib.request

import chrome
from product_pages import render_product_pages

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--preview', action='store_true')
    parser.add_argument('--site-release', default=os.environ.get('GALAXY_SITE_RELEASE'))
    parser.add_argument('--api-release', default=os.environ.get('GALAXY_API_RELEASE'))
    parser.add_argument('--release-data', type=Path, default=ROOT / 'release-data.json')
    parser.add_argument('--archive-source', type=Path, help='Captured public assets for a not-yet-published release; every file must match the catalog hash')
    parser.add_argument('--offline', action='store_true', help='Use already verified cached public archives')
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents or output.is_symlink():
        raise ValueError('Choose a generated output directory, separate from source')
    preview = args.preview or not args.site_release
    metadata = json.loads(args.release_data.read_text(encoding='utf-8'))
    base_release = {'site': metadata['version'], 'api': metadata['backendRelease']}
    if preview:
        metadata.update(version='local-ux-preview', releaseId=None,
                        unpublishedLocalPreview=True, baseReleaseRecord=base_release)
    else:
        for value in (args.site_release, args.api_release):
            if not isinstance(value, str) or not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', value):
                raise ValueError('Select exact website and API versions for a release build')
        metadata.update(version=args.site_release, releaseId=args.site_release,
                        backendRelease=args.api_release, unpublishedLocalPreview=False)
        metadata.pop('baseReleaseRecord', None)

    # This catalog contains publicly served historical documents and downloads.
    # Their exact bytes remain available across a website redesign.
    catalog = json.loads((ROOT / 'public-archive.json').read_text(encoding='utf-8'))
    origin = catalog['origin']
    if origin != 'https://agigalaxy.org':
        raise ValueError('Unexpected public archive origin')
    cache = ROOT / '.cache' / 'public-archive'
    archive_source = args.archive_source.resolve() if args.archive_source else None
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)

    def copy_archive(item):
        name, digest = item
        relative = PurePosixPath(name)
        if (relative.is_absolute() or '..' in relative.parts or '\\' in name
                or not (name.startswith(('docs/', 'downloads/', 'releases/'))
                        or name in ('favicon.svg', 'changelog.md'))
                or not re.fullmatch('[a-f0-9]{64}', digest)):
            raise ValueError('Invalid public archive entry')
        cached = cache / digest
        if cached.is_symlink():
            raise ValueError('Archive cache must contain regular files')
        source = archive_source.joinpath(*relative.parts) if archive_source else None
        if source and source.exists():
            if source.is_symlink() or not source.resolve().is_relative_to(archive_source):
                raise ValueError('Captured public asset escaped the selected source')
            raw = source.read_bytes()
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError('Captured public asset differs from its catalog: ' + name)
            cached.write_bytes(raw)
        else:
            raw = cached.read_bytes() if cached.exists() else None
        if raw is None or hashlib.sha256(raw).hexdigest() != digest:
            if args.offline:
                raise ValueError('Missing verified archive: ' + name)
            with urllib.request.urlopen(origin + '/' + urllib.parse.quote(name), timeout=30) as response:
                raw = response.read()
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError('Published archive bytes changed: ' + name)
            cached.write_bytes(raw)
        target = output.joinpath(*relative.parts)
        if not target.resolve().is_relative_to(output) or target.is_symlink():
            raise ValueError('Archive destination escaped the selected output')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(copy_archive, catalog['files'].items()))

    chrome.OUT = output
    chrome.PREVIEW = preview
    chrome.write('release.json', json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    for name in ('site.css', 'navigation.js'):
        chrome.write('assets/' + name, (ROOT / name).read_text(encoding='utf-8'))
    render_product_pages({'page': chrome.page, 'write': chrome.write, 'OUT': output, 'PREVIEW': preview})
    pages = ['/', '/how-it-works/', '/start/', '/downloads/', '/network/', '/docs/', '/privacy/', '/status/']
    chrome.write('robots.txt', 'User-agent: *\nDisallow: /\n' if preview else
                 'User-agent: *\nAllow: /\nSitemap: https://agigalaxy.org/sitemap.xml\n')
    chrome.write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
                 ''.join('<url><loc>https://agigalaxy.org' + page + '</loc></url>' for page in pages) + '</urlset>\n')
    print(json.dumps({'output': str(output), 'preview': preview,
                      'siteRelease': metadata['version'], 'apiRelease': metadata['backendRelease'],
                      'clientVersion': metadata['nativeClientDownload']['package']['version'],
                      'publicArchiveFilesVerified': len(catalog['files'])}))


if __name__ == '__main__':
    main()
