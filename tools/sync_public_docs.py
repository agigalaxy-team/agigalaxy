"""Local-only publisher. Reads explicit public sources; never traverses docs or uploads."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import tempfile
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'docs/public/publish-manifest.json'
ASSETS = frozenset('docs/assets/' + name for name in (
    'client-entry.svg', 'community-value.svg', 'galaxy-mark.png',
    'hub-topology.svg', 'network-functions.svg', 'website-home.jpg'))
GENERATED = frozenset(('llms.txt', 'llms-full.txt'))
LINK = re.compile(r'''(?P<start>\]\(|\b(?:src|href)=["'])(?P<url>[^\s)"']+)(?P<end>\)|["'])''')


def relative(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ValueError('Invalid relative path: ' + str(value))
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or str(path) != value or '.git' in path.parts:
        raise ValueError('Unsafe relative path: ' + value)
    return path


def contained(root, value):
    relative(value)
    root = root.resolve()
    current = root
    for part in PurePosixPath(value).parts:
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise ValueError('Linked path is forbidden: ' + value)
    if not current.resolve().is_relative_to(root):
        raise ValueError('Path escaped root: ' + value)
    return current


def local_link(url):
    parsed = urlsplit(url)
    return not parsed.scheme and not parsed.netloc and bool(parsed.path)


def rewrite_links(text, source, target, reverse):
    def replace(match):
        url = match['url']
        if not local_link(url):
            return match[0]
        parsed = urlsplit(url)
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), unquote(parsed.path)))
        destination = reverse.get(resolved)
        if destination is None:
            raise ValueError(f'Unpublished local link in {source}: {url}')
        path = posixpath.relpath(destination, posixpath.dirname(target) or '.')
        suffix = ('?' + parsed.query if parsed.query else '') + ('#' + parsed.fragment if parsed.fragment else '')
        return match['start'] + path + suffix + match['end']
    return LINK.sub(replace, text)


def validate_links(files):
    for name, content in files.items():
        if not name.endswith('.md'):
            continue
        for match in LINK.finditer(content.decode('utf-8')):
            url = match['url']
            if local_link(url):
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(urlsplit(url).path)))
                if target not in files:
                    raise ValueError(f'Broken published link: {name}: {url}')


def plan(root=ROOT):
    manifest = json.loads(contained(root, MANIFEST).read_text(encoding='utf-8'))
    if manifest['schemaVersion'] != 1:
        raise ValueError('Unknown public manifest')
    entries = manifest['files']
    reverse = {'docs/public/' + name: name for name in GENERATED}
    targets = set()
    for item in entries:
        source, target = item['source'], item['target']
        relative(source); relative(target)
        if not (source.startswith('docs/public/') or source in ASSETS):
            raise ValueError('Source outside public allowlist: ' + source)
        if any(part in ('originals', 'internal', 'product', 'reference') for part in PurePosixPath(source).parts):
            raise ValueError('Internal materials cannot be published: ' + source)
        if target in targets or source in reverse or target in GENERATED:
            raise ValueError('Duplicate or reserved public mapping')
        if source in ASSETS and target != source:
            raise ValueError('Asset destination changed')
        reverse[source] = target
        targets.add(target)
    files = {}
    for item in entries:
        source, target = item['source'], item['target']
        path = contained(root, source)
        content = path.read_bytes()
        if path.suffix == '.md':
            text = content.decode('utf-8')
            if re.search(r'(?:[A-Z]:[\\/]+Users[\\/]|/Users/|/home/|02-architecture/|07-logs/|originals/)', text):
                raise ValueError('Private path in public content: ' + source)
            content = rewrite_links(text, source, target, reverse).encode('utf-8')
        files[target] = content
    from build_reader_bundle import reader_outputs
    files.update(reader_outputs(files, manifest['readerDocuments']))
    validate_links(files)
    return files, entries


def apply_plan(output, files, dry_run=False, check=False):
    output = output.absolute()
    if any(path.is_symlink() or path.is_junction() for path in (output, *output.parents)):
        raise ValueError('Output root cannot be linked')
    resolved = output.resolve()
    if resolved == ROOT or resolved in ROOT.parents or resolved.is_relative_to(ROOT):
        raise ValueError('Output must be outside the source repository')
    changed = []
    for name, data in sorted(files.items()):
        target = contained(output, name)
        if target.exists() and not target.is_file():
            raise ValueError('Output is not a file: ' + name)
        if target.is_file() and target.read_bytes() == data:
            continue
        changed.append(name)
    if check and changed:
        raise ValueError('Generated public files differ: ' + ', '.join(changed))
    # Every path is validated before mutation. Unlisted files are preserved, never recursively deleted.
    if not dry_run and not check:
        for name in changed:
            target = contained(output, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + '.', suffix='.tmp', delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(files[name])
            try:
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
    return {'mode': 'check' if check else 'dry-run' if dry_run else 'write',
            'files': len(files), 'changed': changed, 'output': str(output), 'uploaded': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    files, _ = plan()
    print(json.dumps(apply_plan(args.output, files, args.dry_run, args.check), ensure_ascii=False))


if __name__ == '__main__':
    main()
