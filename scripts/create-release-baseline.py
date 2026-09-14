"""Create a secret-free source baseline; never include local data/configuration."""
from pathlib import Path
from tempfile import TemporaryDirectory
import datetime, hashlib, json, zipfile, uuid

root = Path(__file__).resolve().parents[1]
extensions = {'.mjs', '.js', '.ts', '.tsx', '.css', '.py', '.md', '.svg', '.png', '.jpg', '.webp', '.ico'}
roots = [root / name for name in ['app', 'components', 'hooks', 'lib', 'scripts', 'docs', 'public', 'integrations/host-adapters']]
for package in (root / 'packages').iterdir():
    if package.is_dir() and not package.is_symlink():
        roots.extend(package / name for name in ['src', 'test', 'scripts', 'examples', 'deploy'])
files = set()
for area in roots:
    if not area.exists():
        continue
    for path in area.rglob('*'):
        sql_source = path.suffix == '.sql' and path.is_relative_to(root / 'packages/galaxy-official/src')
        if path.is_file() and not path.is_symlink() and (path.suffix in extensions or sql_source):
            if not any(part in {'node_modules', 'outputs', '.git', '__pycache__'} for part in path.relative_to(root).parts):
                files.add(path)
for name in ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'next-env.d.ts', 'components.json', 'vite.config.ts', 'next.config.ts', '.oxlintrc.json', '.oxfmtrc.json', 'packages/galaxy-official/package.json', 'packages/galaxy-official/package-lock.json']:
    path = root / name
    if path.is_file() and not path.is_symlink():
        files.add(path)
# Share the runtime package's explicit resource list and add source-only inputs.
# Arbitrary local JSON/configuration is still excluded.
catalog = json.loads((root / 'packages/galaxy-official/release-resources.json').read_text(encoding='utf-8'))
required_resources = catalog['service'] + catalog['source']
for name in required_resources:
    path = root / name
    if not path.resolve().is_relative_to(root) or not path.is_file() or path.is_symlink():
        raise ValueError('Missing or unsafe required source resource: ' + name)
    files.add(path)
(root / 'outputs').mkdir(exist_ok=True)
output = root / 'outputs' / ('release-baseline-' + str(uuid.uuid4()))
output.mkdir()
records = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(files)}
manifest = {'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'kind': 'source-baseline', 'files': records,
            'excluded': ['.env', 'local identity and private keys', 'host authentication/configuration', '.openai', '.opencode', 'dependency trees', 'outputs', 'Git history'],
            'limits': 'Source checkpoint only; deployment configuration must be supplied through authorized secure channels.'}
archive = output / 'source.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for name in records:
        bundle.write(root / name, name)
    bundle.writestr('baseline-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
with TemporaryDirectory(prefix='galaxy-source-restore-') as temporary:
    destination = Path(temporary).resolve()
    with zipfile.ZipFile(archive) as bundle:
        for name, digest in records.items():
            target = (destination / name).resolve()
            if not target.is_relative_to(destination):
                raise ValueError('Unsafe archive target')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(name))
            assert hashlib.sha256(target.read_bytes()).hexdigest() == digest
result = {'output': str(output), 'sourceFiles': len(records), 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
          'isolatedExtractionHashes': 'passed', 'manifest': manifest}
(output / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'manifest'}))
