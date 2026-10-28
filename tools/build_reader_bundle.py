"""Build optional local reader artifacts from canonical main-repository documents."""
import argparse
import json
from urllib.parse import urljoin
from pathlib import Path
import re

RAW = 'https://raw.githubusercontent.com/agigalaxy-team/agigalaxy/main/'


def reader_outputs(files, documents):
    index = ['# Galaxy reading index', '', 'Canonical source: https://github.com/agigalaxy-team/agigalaxy', '',
             'Read relevant originals; this local bundle does not replace them.', '']
    sections = ['# 银河本地阅读导出', '', 'Generated from the public main repository. Preserve document dates and license boundaries.', '']
    for source in documents:
        content = files[source].decode('utf-8').strip()
        title = next((line[2:] for line in content.splitlines() if line.startswith('# ')), source)
        index.append('- ' + title + ': ' + RAW + source)
        content = re.sub(r'(\]\()([^\s)]+)\)',
                         lambda m: m[1] + urljoin(RAW + source, m[2]) + ')', content)
        sections.extend(['---', '', 'Canonical source: ' + RAW + source, '', content, ''])
    return {'reader-index.md': ('\n'.join(index) + '\n').encode('utf-8'),
            'reader-bundle.md': '\n'.join(sections).encode('utf-8')}


def main():
    from sync_public_docs import ROOT, MANIFEST, plan, apply_plan
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    files, _ = plan()
    manifest = json.loads((ROOT / MANIFEST).read_text(encoding='utf-8'))
    selected = reader_outputs(files, manifest['readerDocuments'])
    print(json.dumps(apply_plan(args.output, selected, args.dry_run, args.check), ensure_ascii=False))


if __name__ == '__main__':
    main()
