"""Extract the website's explicitly authored public docs without executing its build."""
import ast
import argparse
import hashlib
import json
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
SOURCE = PACKAGE.parents[3] / 'official-site' / 'build.py'
tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
versions = {}
for version, name in [('v0.1', 'docs'), ('v0.2', 'docs_v02')]:
    assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
    if len(assignments) != 1:
        raise ValueError('Expected exactly one source per public document version')
    docs = ast.literal_eval(assignments[0].value)
    if set(docs) != {'overview', 'installation', 'compatibility', 'privacy'}:
        raise ValueError('Public document allowlist changed; review before publishing')
    if any(not isinstance(text, str) or len(text.encode()) > 16384 for text in docs.values()):
        raise ValueError('Invalid public content')
    versions[version] = docs
payload = {'version': 'v0.2', 'source': 'official-site/build.py:docs,docs_v02',
           'documents': versions['v0.2'], 'versions': versions}
encoded = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
target = PACKAGE / 'public-docs.json'
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
if args.check:
    if not target.exists() or target.read_text(encoding='utf-8') != encoded:
        raise ValueError('Public MCP bundle differs from website source; rebuild required')
else:
    target.write_text(encoded, encoding='utf-8')
print(json.dumps({'versions': len(versions), 'documents': sum(len(d) for d in versions.values()), 'sha256': hashlib.sha256(encoded.encode()).hexdigest()}))
