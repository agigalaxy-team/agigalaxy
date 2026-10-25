"""Create a secret-free source baseline; never include local data/configuration."""
from pathlib import Path
from tempfile import TemporaryDirectory
import datetime, hashlib, json, zipfile, uuid, os, subprocess

root = Path(__file__).resolve().parents[1]
components = json.loads((root / 'repository-components.json').read_text(encoding='utf8'))
extensions = set(components['sourceExtensions'])
roots = [root / name for name in components['sourceRoots']]
excluded = set(components['sourceExcludedDirectories'])
def filesystem_path(path):
    if os.name!='nt':return path
    prefix=chr(92)*2+'?'+chr(92)
    return path if str(path).startswith(prefix) else Path(prefix+str(path.absolute()))

def descendants(area):
    pending=[area]
    while pending:
        directory=pending.pop()
        with os.scandir(filesystem_path(directory)) as entries:
            for entry in entries:
                path=directory/entry.name
                if entry.is_symlink():continue
                if entry.is_dir(follow_symlinks=False):
                    if entry.name not in excluded and not filesystem_path(path).is_junction():pending.append(path)
                elif entry.is_file(follow_symlinks=False):yield path
files = set()
for area in roots:
    if not filesystem_path(area).exists() or filesystem_path(area).is_symlink() or filesystem_path(area).is_junction():
        continue
    for path in descendants(area):
        name = path.name
        private = (name.startswith('.env') and not name.endswith('.example')) or path.suffix in {'.key','.pem','.pyc','.log','.tsbuildinfo'}
        named = name.startswith(('LICENSE','NOTICE','COPYING')) or name.startswith('Dockerfile') or name.endswith('.env.example') or name in {'.gitignore','.dockerignore','.gitattributes'}
        configuration = path.suffix in {'.json','.yaml','.yml'}
        source_config = any(part in {'src','test','tests','theme','.github'} for part in path.relative_to(root).parts) or any(mark in name for mark in ('.example','.empty')) or name in {'SOURCE.json','package.json','package-lock.json','tsconfig.json','client-contract.json'}
        if not private and (path.suffix in extensions or named) and (not configuration or source_config):
            if not any(part in excluded for part in path.relative_to(root).parts):
                files.add(path)
for name in components['sourceFiles']:
    path = root / name
    if filesystem_path(path).is_file() and not filesystem_path(path).is_symlink():
        files.add(path)
# Share the runtime package's explicit resource list and add source-only inputs.
# Arbitrary local JSON/configuration is still excluded.
catalog = json.loads((root / 'packages/galaxy-official/release-resources.json').read_text(encoding='utf-8'))
closure=subprocess.run([os.environ.get('GALAXY_BUILD_NODE','node'),str(root/'scripts/components.mjs'),'resources','--component','hub'],cwd=root,capture_output=True,text=True,encoding='utf8')
if closure.returncode:
    raise ValueError('Hub runtime import closure is incomplete; source archive refused. See component resources command.')
required_resources = catalog['service'] + catalog['source'] + components['requiredSourceResources'] + json.loads(closure.stdout)
for name in required_resources:
    path = root / name
    physical=filesystem_path(path)
    if not physical.resolve().is_relative_to(filesystem_path(root).resolve()) or not physical.is_file() or physical.is_symlink():
        raise ValueError('Missing or unsafe required source resource: ' + name)
    files.add(path)
(root / 'outputs').mkdir(exist_ok=True)
output = root / 'outputs' / ('release-baseline-' + str(uuid.uuid4()))
output.mkdir()
records = {path.relative_to(root).as_posix(): hashlib.sha256(filesystem_path(path).read_bytes()).hexdigest() for path in sorted(files)}
manifest = {'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'kind': 'source-baseline', 'files': records,
            'componentCatalog':'repository-components.json','components':[item['id'] for item in components['components']],
            'excluded': ['.env', 'local identity and private keys', 'host authentication/configuration', '.openai', '.opencode', 'dependency trees', 'outputs', 'Git history'],
            'limits': 'Source checkpoint only; deployment configuration must be supplied through authorized secure channels.'}
archive = output / 'source.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for name in records:
        bundle.write(filesystem_path(root / name), name)
    bundle.writestr('baseline-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
with TemporaryDirectory(prefix='galaxy-source-restore-') as temporary:
    destination = Path(temporary).resolve()
    with zipfile.ZipFile(archive) as bundle:
        for name, digest in records.items():
            target = (destination / name).resolve()
            if not target.is_relative_to(destination):
                raise ValueError('Unsafe archive target')
            physical=filesystem_path(target)
            physical.parent.mkdir(parents=True, exist_ok=True)
            physical.write_bytes(bundle.read(name))
            assert hashlib.sha256(physical.read_bytes()).hexdigest() == digest
result = {'output': str(output), 'sourceFiles': len(records), 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
          'isolatedExtractionHashes': 'passed', 'manifest': manifest}
(output / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'manifest'}))
