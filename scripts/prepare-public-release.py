"""Prepare local static-site/client candidates. No credentials, uploads or signing."""
import argparse
import hashlib
import json
import re
import tarfile
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT.parents[1] / 'official-site'
TOPICS = ['overview', 'installation', 'compatibility', 'privacy']
PAGES = ['index.html', 'how-it-works/index.html', 'start/index.html',
         'network/index.html', 'docs/index.html', 'status/index.html',
         'privacy/index.html', '404/index.html', '404.html']
PUBLIC_FILES = sorted(PAGES + ['agent.md', 'llms.txt', 'changelog.md', 'robots.txt',
    'sitemap.xml', 'release.json', 'assets/site.css', 'favicon.svg'] +
    [f'docs/{v}/{topic}.md' for v in ['v0.1', 'v0.2'] for topic in TOPICS])


def sha(value):
    return hashlib.sha256(value).hexdigest()


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        self.links.extend(value for key, value in attrs if key in ('href', 'src') and value)


def prepare(artifact, output):
    if not output.is_absolute() or output.exists():
        raise ValueError('Output must be a new absolute directory')
    dist = SITE / 'dist'
    actual = sorted(p.relative_to(dist).as_posix() for p in dist.rglob('*') if p.is_file())
    if actual != PUBLIC_FILES or any((dist / name).is_symlink() for name in actual):
        raise ValueError('Static file allowlist differs; rebuild or review the explicit public files')
    release = json.loads((dist / 'release.json').read_text(encoding='utf-8'))
    if release['publicApiEndpoints'] or release['publicDownload'] is not None or release['remoteBinding'] or release['publicProof']:
        raise ValueError('This candidate does not authorize live API or download claims')
    links = 0
    for name in actual:
        text = (dist / name).read_text(encoding='utf-8')
        if name.endswith('.html'):
            parser = Links()
            parser.feed(text)
            refs = parser.links
        elif name.endswith(('.md', '.txt')):
            refs = re.findall(r'\]\(([^\s)]+)\)', text)
        else:
            refs = []
        base = 'https://agigalaxy.org/' + name
        for ref in refs:
            if ref.startswith('#'):
                continue
            url = urlsplit(urljoin(base, ref))
            if url.hostname != 'agigalaxy.org':
                continue
            path = unquote(url.path).lstrip('/')
            if not path or path.endswith('/'):
                path += 'index.html'
            if path not in actual:
                raise ValueError(f'Broken local public link: {name} -> {path}')
            links += 1
    with zipfile.ZipFile(SITE / 'releases/2026.09.09-1-static.zip') as previous:
        for topic in TOPICS:
            name = f'docs/v0.1/{topic}.md'
            if previous.read(name) != (dist / name).read_bytes():
                raise ValueError('Historical public document changed: ' + name)
    verification = json.loads(artifact.with_name('verification.json').read_text(encoding='utf-8'))
    artifact_bytes = artifact.read_bytes()
    if sha(artifact_bytes) != verification['sha256'] or len(artifact_bytes) != verification['bytes']:
        raise ValueError('Client artifact differs from its installation record')
    with tarfile.open(artifact, 'r:gz') as package:
        members = package.getmembers()
        if any(not m.isfile() for m in members) or len({m.name for m in members}) != len(members):
            raise ValueError('Unexpected client archive entry')
        def read(name):
            return package.extractfile('package/' + name).read()
        manifest = json.loads(read('package.json'))
        hashes = json.loads(read('source-hashes.json'))
        expected = {'package/package.json', 'package/source-hashes.json', 'package/README.md'}
        expected.update('package/lib/' + name for name in hashes)
        if {m.name for m in members} != expected:
            raise ValueError('Client archive has unexpected files')
        for name, digest in hashes.items():
            source = (ROOT / name).resolve()
            if not source.is_relative_to(ROOT) or not name.startswith('packages/'):
                raise ValueError('Unexpected source reference')
            if sha(read('lib/' + name)) != digest or sha(source.read_bytes()) != digest:
                raise ValueError('Client artifact no longer matches current source: ' + name)
        if list(manifest['exports']) != verification['exports'] or manifest['dependencies'] != verification['dependencies']:
            raise ValueError('Client exports/dependencies differ from installation record')
    candidate = {'kind': 'local-publication-candidate', 'publicationReady': False,
        'package': manifest, 'filename': artifact.name, 'sha256': sha(artifact_bytes),
        'bytes': len(artifact_bytes), 'sourceFiles': len(hashes), 'currentSourceHashes': 'matched',
        'priorOfflineInstall': verification['offlineInstall'], 'priorConsumerSmoke': verification['consumerSmoke'],
        'installationRecordSha256': sha(artifact.with_name('verification.json').read_bytes()),
        'productionSignature': None, 'downloadUrl': None,
        'remaining': ['Formal publisher, trusted release key and matching release evidence',
                      'Actual supported-host acceptance and public download publication']}
    output.mkdir(parents=True)
    archive = output / ('galaxy-website-' + release['version'] + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
        for name in PUBLIC_FILES:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 11, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            target.writestr(info, (dist / name).read_bytes())
    website = {'version': release['version'], 'deployed': False, 'files': {
        name: sha((dist / name).read_bytes()) for name in PUBLIC_FILES},
        'archive': archive.name, 'archiveSha256': sha(archive.read_bytes()),
        'localReferencesChecked': links, 'historicalDocumentsUnchanged': 4,
        'scope': 'Static entrypoints and local references; no browser or live-server check'}
    for name, value in [('website-candidate.json', website), ('client-candidate.json', candidate)]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'websiteFiles': len(actual), 'localReferences': links, 'clientSourceFiles': len(hashes),
        'clientExports': len(manifest['exports']), 'publicationReady': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client-artifact', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    prepare(args.client_artifact.resolve(), args.output)
