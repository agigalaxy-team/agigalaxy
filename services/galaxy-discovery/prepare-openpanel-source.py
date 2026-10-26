"""Prepare the fixed full OpenPanel context from an explicitly supplied archive.

This never downloads, installs dependencies, starts Docker or loads runtime
configuration. The partial reference trees in Git are patch inputs, not an API.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile

HERE = Path(__file__).resolve().parent
TOP = 'openpanel-account-scope-cd24bb8-r1'
COMMIT = 'cd24bb838301df1a9087e2e132b344e5b8a99963'


def physical(path):
    path = Path(path).absolute()
    return Path('\\\\?\\' + str(path)) if os.name == 'nt' and not str(path).startswith('\\\\?\\') else path


def members(archive):
    rows = archive.getmembers()
    if not rows or len(rows) > 10000 or sum(row.size for row in rows) > 2 * 1024**3:
        raise ValueError('Source archive exceeds the bounded full-source context.')
    seen = set()
    for row in rows:
        path = PurePosixPath(row.name)
        if path.is_absolute() or '..' in path.parts or '\\' in row.name or ':' in row.name or not path.parts or path.parts[0] != TOP:
            raise ValueError('Source archive path is outside the fixed top-level directory.')
        name = path.as_posix()
        if name in seen or not (row.isfile() or row.isdir()):
            raise ValueError('Duplicate, link or special source entry is not permitted.')
        seen.add(name)
        if any(part in {'node_modules', '.git', '__pycache__', '.next'} for part in path.parts):
            raise ValueError('Dependencies, VCS data and generated caches are not source inputs.')
        if path.name == '.env' or path.suffix.lower() in {'.pem', '.key', '.sqlite', '.db'}:
            raise ValueError('Private runtime material is not a source input.')
    return rows


def same_text(left, right):
    return left.decode('utf-8').replace('\r\n', '\n') == right.decode('utf-8').replace('\r\n', '\n')


def verify_inputs(archive, rows):
    lookup = {row.name: row for row in rows}
    required = ['LICENSE.md', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'apps/api/package.json']
    for name in required:
        if TOP + '/' + name not in lookup:
            raise ValueError('Incomplete corresponding source: missing ' + name)
    # Bind the provided full source to the exact reviewed patch context, rather
    # than accepting an unrelated archive with a matching filename/version.
    references = HERE / 'openpanel-account-scope' / 'upstream-reference'
    changed = HERE / 'openpanel-account-scope' / 'modified-source'
    for root, names in [(references, ['package.json', 'apps/api/package.json']),
                        (changed, [str(path.relative_to(physical(changed))).replace(os.sep, '/') for path in physical(changed).rglob('*.ts')])]:
        for name in names:
            row = lookup.get(TOP + '/' + name)
            if row is None or not row.isfile() or not same_text(archive.extractfile(row).read(), physical(root / name).read_bytes()):
                raise ValueError('Full source does not match the fixed account-scope input: ' + name)


def overlay(source, destination):
    source = physical(source)
    for path in source.rglob('*'):
        relative = path.relative_to(source)
        if 'artifacts' in relative.parts or '__pycache__' in relative.parts:
            continue
        if path.is_symlink():
            raise ValueError('Patch support cannot contain a symbolic link.')
        if path.is_file():
            target = physical(destination / relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(physical(path), target)


def prepare(source, output, variant):
    source, output = Path(source).resolve(strict=True), Path(output).resolve()
    if output == HERE or HERE in output.parents or output in HERE.parents or output == source or output in source.parents:
        raise ValueError('Output must be a separate new directory.')
    repository = HERE.parents[1]
    if output.is_relative_to(repository) and not output.is_relative_to(repository / 'outputs'):
        raise ValueError('Inside the repository, use a new outputs subdirectory.')
    # All archive shape/source checks happen before the new output is created.
    with tarfile.open(physical(source), 'r:gz') as archive:
        rows = members(archive)
        verify_inputs(archive, rows)
        physical(output.parent).mkdir(parents=True, exist_ok=True)
        physical(output).mkdir()  # Never reuse a previous or nonempty attempt.
        for row in rows:
            relative = PurePosixPath(row.name).relative_to(TOP)
            target = physical(output.joinpath(*relative.parts))
            if row.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(row) as origin, target.open('xb') as destination:
                    shutil.copyfileobj(origin, destination)
                os.chmod(target, row.mode & 0o777)
    overlay(HERE / 'openpanel-account-scope', output / 'galaxy-account-scope')
    shutil.copyfile(HERE / 'openpanel-account-scope' / 'Dockerfile.account-scope', physical(output / 'Dockerfile.account-scope'))
    if variant == 'p18':
        name = Path('apps/api/src/controllers/export.controller.ts')
        expected = physical(HERE / 'p18-search-native/current-reference' / name).read_bytes()
        if not same_text(physical(output / name).read_bytes(), expected):
            raise ValueError('P18 export controller preimage does not match the fixed account-scope context.')
        shutil.copyfile(physical(HERE / 'p18-search-native/modified-source' / name), physical(output / name))
        overlay(HERE / 'p18-search-native', output / 'galaxy-p18-search-native')
        shutil.copyfile(HERE / 'p18-search-native/Dockerfile.p18-search-native', physical(output / 'Dockerfile.p18-search-native'))
    receipt = {'upstreamCommit': COMMIT, 'variant': variant, 'archiveEntries': len(rows),
               'correspondingSource': True, 'dependenciesInstalled': False, 'imageBuilt': False,
               'runtimeConfigurationLoaded': False, 'deployed': False}
    physical(output / 'GALAXY_SOURCE_CONTEXT.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, help='Full account-scope corresponding-source tar.gz supplied by its release owner')
    parser.add_argument('--output', required=True, help='Separate new directory; existing results are never overwritten')
    parser.add_argument('--variant', choices=['accounts', 'p18'], default='p18')
    args = parser.parse_args()
    print(json.dumps(prepare(args.archive, args.output, args.variant)))
