"""Build reviewed public docs from a package-local, versioned content manifest."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

PACKAGE = Path(__file__).resolve().parents[1]
TOPICS = ('overview', 'installation', 'compatibility', 'privacy')
SEMVER = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
LEGACY = {'v0.1', 'v0.2', 'v0.3', 'v0.4'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact_keys(value, keys, description):
    require(isinstance(value, dict) and set(value) == set(keys), 'Invalid ' + description + ' fields')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate manifest key')
        result[key] = value
    return result


def read_file(root, relative, limit):
    path = root / relative
    require(not Path(relative).is_absolute() and '..' not in Path(relative).parts, 'Invalid public document path')
    current = root
    require(not root.is_symlink(), 'Public source cannot be a symbolic link')
    for part in Path(relative).parts:
        current = current / part
        require(not current.is_symlink(), 'Public source cannot be a symbolic link')
    require(path.resolve().is_relative_to(root.resolve()) and path.is_file(), 'Public document is missing or outside source root')
    raw = path.read_bytes()
    require(0 < len(raw) <= limit, 'Invalid public content size')
    text = raw.decode('utf-8')
    require(not text.startswith('\ufeff') and '\x00' not in text, 'Invalid public UTF-8 content')
    return raw, text


def load_source(package=PACKAGE):
    source = package / 'public-docs'
    raw, text = read_file(source, 'manifest.json', 65536)
    manifest = json.loads(text, object_pairs_hook=unique_object)
    exact_keys(manifest, ('schemaVersion', 'currentVersion', 'publicOrigin', 'topics', 'versions'), 'public manifest')
    require(type(manifest['schemaVersion']) is int and manifest['schemaVersion'] == 1, 'Unknown manifest schema')
    require(manifest['topics'] == list(TOPICS), 'Public document allowlist changed')
    current = manifest['currentVersion']
    require(isinstance(current, str) and re.fullmatch(SEMVER, current), 'Current document version must be pure semver')
    origin = manifest['publicOrigin']
    require(isinstance(origin, str), 'Invalid public origin')
    url = urlsplit(origin)
    require(url.scheme == 'https' and url.hostname and not url.username and not url.password
            and not url.path and not url.query and not url.fragment, 'Invalid public origin')
    records = manifest['versions']
    require(isinstance(records, list) and 1 <= len(records) <= 32, 'Invalid public version count')
    versions, hashes, dates = {}, {}, {}
    for record in records:
        exact_keys(record, ('version', 'documentDate', 'documents'), 'public version')
        version = record['version']
        require(isinstance(version, str) and (version in LEGACY or re.fullmatch(SEMVER, version)), 'Invalid public version')
        require(version not in versions, 'Duplicate public version')
        date = record['documentDate']
        require(date is None or isinstance(date, str) and re.fullmatch(r'20[0-9]{2}-[0-9]{2}-[0-9]{2}', date), 'Invalid document date')
        if date is not None:
            datetime.date.fromisoformat(date)
        exact_keys(record['documents'], TOPICS, 'public topic')
        documents, digests = {}, {}
        for topic in TOPICS:
            item = record['documents'][topic]
            exact_keys(item, ('path', 'sha256'), 'public document')
            require(item['path'] == f'versions/{version}/{topic}.md', 'Non-canonical public document path')
            require(isinstance(item['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', item['sha256']), 'Invalid public content digest')
            data, document = read_file(source, item['path'], 16384)
            actual = hashlib.sha256(data).hexdigest()
            require(actual == item['sha256'], 'Public content digest mismatch: ' + version + '/' + topic)
            documents[topic], digests[topic] = document, actual
        versions[version], hashes[version], dates[version] = documents, digests, date
    require(current in versions, 'Current public version is missing')
    require(dates[current] is not None, 'Current document date is missing')
    return {'schemaVersion': 2, 'version': current, 'source': 'public-docs/manifest.json',
            'sourceSha256': hashlib.sha256(raw).hexdigest(), 'publicOrigin': origin,
            'documentDate': dates[current], 'topics': list(TOPICS), 'documents': versions[current],
            'versions': versions, 'documentHashes': hashes, 'versionDates': dates}


def outputs(package=PACKAGE):
    bundle = load_source(package)
    version, date, origin = bundle['version'], bundle['documentDate'], bundle['publicOrigin']
    links = [(topic, f'{origin}/docs/{version}/{topic}.md') for topic in TOPICS]
    agent = '# Galaxy Agent 入口\n\n' + f'当前公开文档：{version}（{date}）。\n\n'
    agent += '先读取概览，再按当前目标读取相应主题。公开说明不授予初始化、连接、发布或私有资料读取权限。\n\n'
    agent += '\n'.join(f'- [{topic}]({url})' for topic, url in links) + '\n\n'
    agent += f'[当前状态]({origin}/status/) · [公开文档索引]({origin}/docs/)\n'
    llms = '# AGI Galaxy Network\n\n' + f'> 当前公开文档 {version}，{date}。\n\n'
    llms += '\n'.join(f'- [{topic}]({url})' for topic, url in links) + '\n'
    llms += f'- [Current status]({origin}/status/)\n'
    encoded = (json.dumps(bundle, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    return bundle, {package / 'public-docs.json': encoded,
                    package / 'public-docs/generated/agent.md': agent.encode('utf-8'),
                    package / 'public-docs/generated/llms.txt': llms.encode('utf-8')}


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as file:
        temporary = Path(file.name)
        file.write(data)
    try:
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    bundle, generated = outputs()
    for path, data in generated.items():
        if args.check:
            require(path.is_file() and path.read_bytes() == data, 'Generated public docs differ from canonical source: ' + path.name)
        else:
            atomic_write(path, data)
    print(json.dumps({'currentVersion': bundle['version'], 'versions': len(bundle['versions']),
                      'documents': len(bundle['versions']) * len(TOPICS),
                      'sha256': hashlib.sha256(generated[PACKAGE / 'public-docs.json']).hexdigest()}))


if __name__ == '__main__':
    main()
