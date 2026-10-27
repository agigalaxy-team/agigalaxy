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
from guide_pages import render_versioned_guides

ROOT = Path(__file__).resolve().parent


def windows_filesystem_path(value):
    # GetFinalPathNameByHandle can add an extended namespace to an ordinary
    # drive/UNC path. Compare the same resolved filesystem path consistently.
    if value.startswith('\\\\?\\UNC\\'):
        return '\\\\' + value[8:]
    if (value.startswith('\\\\?\\') and len(value) > 6
            and value[4].isascii() and value[4].isalpha() and value[5:7] == ':\\'):
        return value[4:]
    return value


def resolved_file_path(path):
    resolved = path.resolve()
    return Path(windows_filesystem_path(str(resolved))) if os.name == 'nt' else resolved


def copy_example_images(output):
    """Publish only the named, attributed covers used by community examples."""
    directory = ROOT.parent.parent / 'public' / 'images' / 'examples'
    resolved_directory = resolved_file_path(directory)
    if directory.is_symlink() or not resolved_directory.is_relative_to(resolved_file_path(ROOT.parent.parent)):
        raise ValueError('Example images must stay in the repository')
    for name in ('reading-lamp.png', 'travel-journal.png', 'reading-room.png', 'credits.json'):
        source = directory / name
        if source.is_symlink() or not resolved_file_path(source).is_relative_to(resolved_directory):
            raise ValueError('Example image escaped its source directory: ' + name)
        target = output / 'images' / 'examples' / name
        if target.is_symlink() or not resolved_file_path(target).is_relative_to(output):
            raise ValueError('Example image escaped the selected output: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())


def copy_external_images(output):
    """Publish only the two verified editorial covers and their attribution."""
    directory = ROOT.parent.parent / 'public' / 'images' / 'external'
    resolved_directory = resolved_file_path(directory)
    if directory.is_symlink() or not resolved_directory.is_relative_to(resolved_file_path(ROOT.parent.parent)):
        raise ValueError('External images must stay in the repository')
    for name in ('webb-pillars.png', 'alice-mad-tea-party.gif', 'credits.json'):
        source = directory / name
        if source.is_symlink() or not resolved_file_path(source).is_relative_to(resolved_directory):
            raise ValueError('External image escaped its source directory: ' + name)
        target = output / 'images' / 'external' / name
        if target.is_symlink() or not resolved_file_path(target).is_relative_to(output):
            raise ValueError('External image escaped the selected output: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--runtime-data', action='store_true', help='Compile public data/assets for the dynamic website; do not generate current HTML or browser bootstrap')
    parser.add_argument('--preview', action='store_true')
    parser.add_argument('--site-release', default=os.environ.get('GALAXY_SITE_RELEASE'))
    parser.add_argument('--api-release', default=os.environ.get('GALAXY_API_RELEASE'))
    parser.add_argument('--release-data', type=Path, default=ROOT / 'release-data.json')
    parser.add_argument('--archive-source', type=Path, help='Captured public assets for a not-yet-published release; every file must match the catalog hash')
    parser.add_argument('--preserved-public-source', type=Path, help='Copy the selected existing public release files without fetching or recalculating archive digests')
    parser.add_argument('--offline', action='store_true', help='Use already verified cached public archives')
    parser.add_argument('--node', default='node', help='Node.js executable used by the shared website UI renderer')
    args = parser.parse_args()
    output = resolved_file_path(args.output)
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

    chrome.configure_shell(args.node)

    # This catalog contains publicly served historical documents and downloads.
    # Their exact bytes remain available across a website redesign.
    catalog = json.loads((ROOT / 'public-archive.json').read_text(encoding='utf-8'))
    origin = catalog['origin']
    if origin != 'https://agigalaxy.org':
        raise ValueError('Unexpected public archive origin')
    cache = ROOT / '.cache' / 'public-archive'
    archive_source = resolved_file_path(args.archive_source) if args.archive_source else None
    preserved_source = resolved_file_path(args.preserved_public_source) if args.preserved_public_source else None
    if preserved_source and (archive_source or not preserved_source.is_dir() or preserved_source.is_symlink()):
        raise ValueError('Choose one existing public release directory')
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
        archive_name = 'archives/public/' + name if name in ('docs/index.html', 'downloads/index.html') else name
        if preserved_source:
            selected = preserved_source / archive_name
            if selected.is_symlink() or not selected.is_file() or not resolved_file_path(selected).is_relative_to(preserved_source):
                raise ValueError('The selected existing release is missing a public file: ' + name)
            raw = selected.read_bytes()
        elif source and source.exists():
            if source.is_symlink() or not resolved_file_path(source).is_relative_to(archive_source):
                raise ValueError('Captured public asset escaped the selected source')
            raw = source.read_bytes()
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError('Captured public asset differs from its catalog: ' + name)
            cached.write_bytes(raw)
        else:
            raw = cached.read_bytes() if cached.exists() else None
        if not preserved_source and (raw is None or hashlib.sha256(raw).hexdigest() != digest):
            if args.offline:
                raise ValueError('Missing verified archive: ' + name)
            with urllib.request.urlopen(origin + '/' + urllib.parse.quote(archive_name), timeout=30) as response:
                raw = response.read()
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError('Published archive bytes changed: ' + name)
            cached.write_bytes(raw)
        target = output.joinpath(*relative.parts)
        resolved_target = resolved_file_path(target)
        if not resolved_target.is_relative_to(output) or target.is_symlink():
            raise ValueError('Archive destination escaped the selected output: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        # These two catalog entries are also the current product landing pages.
        # Keep their original bytes at an explicit archive URL before rendering
        # the redesigned current UI at /docs/ and /downloads/.
        if name in ('docs/index.html', 'downloads/index.html'):
            original = output / 'archives' / 'public' / name
            if original.is_symlink() or not resolved_file_path(original).is_relative_to(output):
                raise ValueError('Original entry archive escaped the selected output')
            original.parent.mkdir(parents=True, exist_ok=True)
            original.write_bytes(raw)

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(copy_archive, catalog['files'].items()))

    public = ROOT / 'public'
    if public.is_symlink():
        raise ValueError('Authored public documents must stay in the repository')
    for source in sorted(public.rglob('*')):
        if source.is_symlink():
            raise ValueError('Authored public document symlink rejected')
        if not source.is_file():
            continue
        name = source.relative_to(public).as_posix()
        if not name.startswith('docs/') or source.suffix != '.md' or name in catalog['files']:
            raise ValueError('Authored documents must use a new versioned documentation path')
        target = output / name
        if target.is_symlink() or not resolved_file_path(target).is_relative_to(output):
            raise ValueError('Authored document destination escaped the selected output')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())

    chrome.OUT = output
    chrome.PREVIEW = preview
    chrome.PUBLIC_PAGES.clear()
    chrome.write('release.json', json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    assets = ('site.css', 'cms-content.css', 'interaction-copy.mjs', 'home-experience.css')
    for name in assets:
        chrome.write('assets/' + name, (ROOT / name).read_text(encoding='utf-8'))
    for name in chrome.shared_shell()['styles']:
        chrome.write('assets/' + name,
                     (ROOT.parent.parent / 'packages' / 'galaxy-web' / 'src' / name).read_text(encoding='utf-8'))
    chrome.write('assets/public-reading.css',
                 (ROOT.parent.parent / 'packages' / 'galaxy-web' / 'src' / 'features' / 'public-reading' / 'workspace.css').read_text(encoding='utf-8')
                 .replace("'../../../../../apps/galaxy-site/cms-content.css'", "'/assets/cms-content.css'"))
    copy_example_images(output)
    copy_external_images(output)
    site = {'page': chrome.page, 'write': chrome.write, 'OUT': output, 'PREVIEW': preview, 'RUNTIME_DATA': True}
    guide_pages = render_versioned_guides(site, metadata)
    render_product_pages({**site, 'GUIDE_PAGES': guide_pages})
    chrome.write('assets/public-pages/index.json', json.dumps({'version': 1, 'routes': chrome.PUBLIC_PAGES}, indent=2) + '\n')
    pages = ['/', '/how-it-works/', '/start/', '/downloads/', '/downloads/verification/', '/network/', '/docs/', '/privacy/', '/status/']
    pages.extend(guide_pages.values())
    chrome.write('robots.txt', 'User-agent: *\nDisallow: /\n' if preview else
                 'User-agent: *\nAllow: /\nSitemap: https://agigalaxy.org/sitemap.xml\n')
    chrome.write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
                 ''.join('<url><loc>https://agigalaxy.org' + page + '</loc></url>' for page in pages) + '</urlset>\n')
    types = {'.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.gif':'image/gif', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.md':'text/plain', '.txt':'text/plain', '.xml':'application/xml', '.js':'text/javascript', '.mjs':'text/javascript', '.html':'text/html', '.zip':'application/zip', '.tgz':'application/gzip'}
    files = [{'path': source.relative_to(output).as_posix(), 'contentType': types.get(source.suffix, 'application/octet-stream')} for source in sorted(output.rglob('*')) if source.is_file() and source.name != 'public-assets.json']
    chrome.write('public-assets.json', json.dumps({'version':1,'files':files}, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'output': str(output), 'preview': preview,
                      'siteRelease': metadata['version'], 'apiRelease': metadata['backendRelease'],
                      'clientVersion': metadata['nativeClientDownload']['package']['version'],
                      'publicArchiveFilesCopied': len(catalog['files']),
                      'archiveDigestChecks': not bool(preserved_source)}))


if __name__ == '__main__':
    main()
