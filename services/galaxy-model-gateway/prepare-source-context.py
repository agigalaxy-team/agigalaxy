"""Prepare a fresh Docker context from fixed public upstream source; no install/deploy."""
import argparse,json,os,re,shutil,tarfile,urllib.request
from pathlib import Path,PurePosixPath

def physical(path):
    path=Path(path).absolute()
    return Path('\\\\?\\'+str(path)) if os.name=='nt' and not str(path).startswith('\\\\?\\') else path

def prepare(output,archive):
    here=Path(__file__).resolve().parent
    source=json.loads((here/'SOURCE.json').read_text(encoding='utf8'))
    if source['repository']!='https://github.com/BerriAI/litellm' or not re.fullmatch('[a-f0-9]{40}',source['commit']):raise ValueError('Fixed reviewed upstream required')
    output=output.resolve()
    if output.exists():raise ValueError('Choose a new output directory; source is never overwritten')
    if output==here or here.is_relative_to(output):raise ValueError('Output must be separate from source')
    output.mkdir(parents=True)
    if archive is None:
        archive=output/'upstream-source.tar.gz'
        url='https://codeload.github.com/BerriAI/litellm/tar.gz/'+source['commit']
        with urllib.request.urlopen(url,timeout=60) as response,archive.open('xb') as target:
            while chunk:=response.read(1024*1024):
                if target.tell()+len(chunk)>1024*1024*1024:raise ValueError('Upstream archive size limit exceeded')
                target.write(chunk)
    upstream=output/'upstream';upstream.mkdir();members=0;links=[];excluded_enterprise_links=0
    with tarfile.open(archive,'r:gz') as bundle:
        for item in bundle:
            parts=PurePosixPath(item.name).parts
            if not parts or parts[0]!='litellm-'+source['commit'] or any(part in {'..','.'} for part in parts) or item.name.startswith('/') or '\\' in item.name or ':' in item.name or item.islnk():raise ValueError('Unsafe or mismatched fixed source archive')
            if len(parts)==1:continue
            target=upstream.joinpath(*parts[1:]).resolve()
            if not target.is_relative_to(upstream):raise ValueError('Unsafe source path')
            if item.issym():
                # The MIT-only runtime deliberately does not install the
                # optional enterprise alias. Keep its original archive intact.
                if '/'.join(parts[1:])=='litellm/proxy/enterprise' and item.linkname=='../../enterprise':
                    excluded_enterprise_links+=1
                    continue
                if PurePosixPath(item.linkname).is_absolute() or '\\' in item.linkname or ':' in item.linkname:raise ValueError('Unsafe source link')
                origin=(target.parent/item.linkname).resolve()
                if not origin.is_relative_to(upstream):raise ValueError('Unsafe source link')
                links.append((origin,target))
                continue
            if item.isdir():physical(target).mkdir(parents=True,exist_ok=True)
            elif item.isfile():
                members+=1
                if members>200000:raise ValueError('Upstream member limit exceeded')
                physical(target.parent).mkdir(parents=True,exist_ok=True)
                with bundle.extractfile(item) as incoming,physical(target).open('xb') as outgoing:shutil.copyfileobj(incoming,outgoing)
            else:raise ValueError('Unsupported source archive member')
    for origin,target in links:
        if not physical(origin).is_file() or physical(target).exists():raise ValueError('Source link requires one ordinary internal file')
        physical(target.parent).mkdir(parents=True,exist_ok=True)
        shutil.copyfile(physical(origin),physical(target))
    for name in ['uv.lock','pyproject.toml','LICENSE','litellm-proxy-extras/LICENSE']:
        if not (upstream/name).is_file():raise ValueError('Missing required fixed upstream material: '+name)
    destination=output/'services/galaxy-model-gateway';destination.mkdir(parents=True)
    for name in ['Dockerfile','SOURCE.json','README.md']:shutil.copyfile(here/name,destination/name)
    for area in ['src','tests']:
        for path in (here/area).rglob('*.py'):
            if any(part in {'__pycache__','.venv'} for part in path.parts) or path.is_symlink():continue
            target=destination/path.relative_to(here);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
    target=destination/'config/models.empty.yaml';target.parent.mkdir();shutil.copyfile(here/'config/models.empty.yaml',target)
    (output/'SOURCE-CONTEXT.json').write_text(json.dumps({'repository':source['repository'],'commit':source['commit'],'upstreamFiles':members,'runtimeConfigurationIncluded':False,'built':False,'deployed':False},indent=2)+'\n',encoding='utf8')
    return {'output':str(output),'upstreamFiles':members,'materializedFileLinks':len(links),'excludedEnterpriseLinks':excluded_enterprise_links,'built':False,'deployed':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    selected=parser.add_mutually_exclusive_group(required=True)
    selected.add_argument('--archive',type=Path,help='Existing tar.gz for the exact SOURCE.json commit')
    selected.add_argument('--download',action='store_true',help='Read the exact public codeload archive')
    args=parser.parse_args()
    print(json.dumps(prepare(args.output,args.archive)))
