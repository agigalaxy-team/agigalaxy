"""Project release.json facts into the existing status page, without activation.

The API version is the website publication's recorded API version, not a live
service status. Both the ordinary site renderer and software-release projection
use this body. The latter retains the existing CMS chrome and editable slots.
"""
from datetime import datetime, timedelta, timezone
from html import escape
import json
from pathlib import Path
import stat


def _publication_observation(metadata):
    observed = metadata.get('observedDeployment')
    if not isinstance(observed, dict) or observed.get('releaseId') != metadata.get('backendRelease'):
        return '核对时间未记录。'
    try:
        value = observed['observedAt']
        if not isinstance(value, str) or len(value) > 80:
            raise ValueError('Invalid observation time')
        instant = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if instant.tzinfo is None:
            raise ValueError('An observation time needs its time zone')
    except (KeyError, TypeError, ValueError, OverflowError):
        return '核对时间未记录。'
    local = instant.astimezone(timezone(timedelta(hours=8)))
    return '核对时间：' + local.strftime('%Y-%m-%d %H:%M:%S') + '（上海时间）。'


def release_status_body(metadata, content_slot):
    """Render only the authored status body from recorded release metadata."""
    native = metadata.get('nativeClientDownload', {})
    package = native.get('package', {})
    site_version = escape(str(metadata.get('releaseId', metadata.get('version', '未提供'))))
    api_version = escape(str(metadata.get('backendRelease', '未提供')))
    client_version = escape(str(package.get('version', '未提供')))

    def section(title, content, href, label):
        return ('<section class="reading-section"><h2>' + title + '</h2><div>'
                + content + '<a class="text-link" href="' + href + '">' + label
                + ' </a></div></section>')

    return (content_slot('page-intro', '<header class="reading-intro"><h1>版本信息</h1>'
                         '<p>本次网站发布的版本与使用入口。</p></header>')
            + section('网站', '<p>' + site_version + '</p><p>本次网站发行版本。</p>', '/app/', '打开银河')
            + section('API', '<p>' + api_version + '</p><p>网站发布时核对的 API 版本。'
                      + _publication_observation(metadata) + '</p>',
                      '/docs/builders-support-v2.md', '接口文档')
            + section('客户端', '<p>' + client_version + '</p>', '/downloads/', '下载客户端')
            + section('历史发行记录', '<p>查阅此前版本的发行说明。</p>', '/changelog.md', '查看历史记录'))


def project_release_status(document, data, metadata, *, cms):
    """Keep current CMS content and produce matching HTML and reading data."""
    if not isinstance(data, dict) or data.get('version') != 1 or data.get('path') != '/status/':
        raise ValueError('The existing status reading document is required')
    if not isinstance(data.get('body'), list) or not isinstance(data.get('footer'), list):
        raise ValueError('The existing status reading trees are required')
    body = release_status_body(metadata, cms.content_slot)
    body = cms.replace_slot(body, 'page-intro', cms.slot_content(document, 'page-intro'))
    updated_document = cms.replace_slot(document, 'page-body', body)
    updated_data = dict(data)
    updated_data['body'] = cms.reading_tree(cms.slot_content(updated_document, 'reading-body'))
    updated_data['footer'] = cms.reading_tree(cms.slot_content(updated_document, 'footer'))
    return updated_document, updated_data


def refresh_release_status(target, metadata, *, cms, atomic):
    """Write only the two status representations in an unpublished candidate.

    The activation tool owns candidate creation, live checks, atomic writes and
    the final publication switch. This helper neither follows the current link
    nor changes release.json, CMS publication metadata or any other page.
    """
    root = Path(target).absolute()
    if root.is_symlink() or not root.is_dir():
        raise ValueError('An explicit regular website candidate is required')
    names = ('release.json', 'status/index.html', 'assets/public-pages/status/index.json')
    paths = []
    for name in names:
        item = root
        for part in Path(name).parts:
            item = item / part
            if item.is_symlink():
                raise ValueError('A status candidate cannot contain symbolic links')
        if not stat.S_ISREG(item.stat().st_mode):
            raise ValueError('The existing status candidate files are required')
        paths.append(item)
    release_path, html_path, data_path = paths
    if json.loads(release_path.read_text(encoding='utf-8')) != metadata:
        raise ValueError('Candidate release metadata differs from the selected publication')
    document, data = project_release_status(
        html_path.read_text(encoding='utf-8'),
        json.loads(data_path.read_text(encoding='utf-8')), metadata, cms=cms)
    # Validate both complete representations before either candidate write.
    encoded_data = json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n'
    atomic(html_path, document)
    atomic(data_path, encoded_data)
    return {'path': '/status/', 'websiteRelease': metadata.get('releaseId', metadata.get('version')),
            'publicationApiRelease': metadata.get('backendRelease'), 'representations': 2,
            'cmsContentRetained': True, 'liveServiceStatus': False}
