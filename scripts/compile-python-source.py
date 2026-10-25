"""Compile Python code objects without importing services or writing source caches."""
import argparse,json
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('source',type=Path)
parser.add_argument('output',type=Path)
args=parser.parse_args()
source=args.source.resolve();output=args.output.resolve()
if not source.is_dir() or output==source or source.is_relative_to(output):raise ValueError('Separate source and new output required')
files=[]
for path in sorted(source.rglob('*.py')):
    if path.is_symlink() or '__pycache__' in path.parts:continue
    compile(path.read_text(encoding='utf8'),str(path),'exec')
    files.append(path.relative_to(source).as_posix())
if not files:raise ValueError('No Python source files')
output.mkdir(parents=True)
record={'source':str(source),'files':files,'mode':'code-object-only','modulesImported':False,'sourceCacheWritten':False,'dockerBuilt':False}
(output/'compiled-source.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf8')
print(json.dumps({'compiledFiles':len(files),'sourceCacheWritten':False,'dockerBuilt':False}))
