"""Generate optional reader files from the selected public output; no private inputs."""
import argparse
import json
from pathlib import Path
from urllib.parse import urljoin
import re

RAW = 'https://raw.githubusercontent.com/agigalaxy-team/agigalaxy-public/main/'


def reader_outputs(files, documents):
    index = ['# Galaxy public materials', '', 'Choose relevant pages; the combined bundle is optional.', '',
             '- Reading guide: ' + RAW + 'docs/ai-reading.md', '', '## Documents']
    sections = ['# 银河公开资料合并阅读包', '',
                'Generated from canonical public sources. Preserve each version and date boundary.', '']
    for source in documents:
        content = files[source].decode('utf-8').strip()
        title = next((line[2:] for line in content.splitlines() if line.startswith('# ')), source)
        index.append('- ' + title + ': ' + RAW + source)
        content = re.sub(r'(\]\()([^\s)]+)\)',
                         lambda m: m[1] + urljoin(RAW + source, m[2]) + ')', content)
        sections.extend(['---', '', 'Public counterpart: ' + RAW + source, '', content, ''])
    example = 'examples/capsule-v2.json'
    sections.extend(['---', '', 'Public counterpart: ' + RAW + example, '',
                     '# Capsule v2 合成结构示例', '', '```json', files[example].decode('utf-8').strip(), '```', ''])
    return {'llms.txt': ('\n'.join(index) + '\n').encode('utf-8'),
            'llms-full.txt': '\n'.join(sections).encode('utf-8')}


def main():
    from sync_public_docs import plan, apply_plan
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='Explicit local output directory; never uploads')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    files, _ = plan()
    selected = {key: files[key] for key in ('llms.txt', 'llms-full.txt')}
    print(json.dumps(apply_plan(args.output, selected, args.dry_run, args.check), ensure_ascii=False))


if __name__ == '__main__':
    main()
