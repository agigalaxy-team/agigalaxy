#!/usr/bin/env python3
"""Prepare the operations stack without starting or replacing product services.

Run as root on the exact configured host. Secrets stay in protected host files.
The application/database cutover and the first product capture are separate actions.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import urllib.request

SOURCE = Path(__file__).resolve().parent
STATE = Path('/var/lib/galaxy/operations-stage-20261020')
SECRET_SOURCE = Path('/etc/galaxy/operations-pilot')
NODE = '/opt/galaxy/runtime/node-v24.19.0-linux-x64/bin/node'


def safe_path(path):
    p = Path(path)
    if not p.is_absolute() or p == Path('/'):
        raise RuntimeError('operations_absolute_path_required')
    for current in [p, *p.parents]:
        if current.is_symlink():
            raise RuntimeError('operations_symlink_target_rejected')
    return p


def private_file(path, value, *, owner=0, group=0, mode=0o600, keep=False):
    p = safe_path(path)
    if p.exists():
        info = p.stat()
        if not p.is_file() or info.st_uid not in (0, owner):
            raise RuntimeError('operations_existing_secret_owner_mismatch')
        if keep:
            if not info.st_size or info.st_mode & 0o077:
                raise RuntimeError('operations_existing_secret_permissions_invalid')
            return p
    p.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    temporary = p.with_name(p.name + '.' + secrets.token_hex(6) + '.tmp')
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value if isinstance(value, bytes) else value.encode())
        os.chown(temporary, owner, group)
        os.chmod(temporary, mode)
        os.replace(temporary, p)
    finally:
        if temporary.exists():
            temporary.unlink()
    return p


def run(args, *, timeout=120, log=None, env=None):
    if log:
        with open(log, 'ab') as stream:
            r = subprocess.run(args, stdout=stream, stderr=stream, timeout=timeout, env=env)
        output = b''
    else:
        r = subprocess.run(args, capture_output=True, timeout=timeout, env=env)
        output = r.stdout
    if r.returncode:
        raise RuntimeError('operations_' + Path(args[0]).name.replace('-', '_') + '_failed_' + str(r.returncode))
    return output.decode().strip()


def save_state(part, result):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    file = STATE / (part + '.json')
    result = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), **result}
    private_file(file, json.dumps(result, indent=2) + '\n')
    return result


def node_action(action, config):
    # Deliberate finite staging actions: no up, activate-pitr, backup or retention.
    if action not in ('prepare', 'prepare-pitr', 'install-units', 'repository-init', 'plan'):
        raise RuntimeError('operations_stage_action_invalid')
    result = subprocess.run([NODE, str(SOURCE / 'manage.mjs'), action, '--config', str(config)], capture_output=True, text=True, timeout=180)
    if result.returncode:
        try:
            diagnostic = json.loads(result.stderr)
            code = diagnostic.get('error', '')
        except Exception:
            code = ''
        raise RuntimeError('operations_stage_' + action.replace('-', '_') + '_' + (code if re_safe_code(code) else 'failed'))
    return json.loads(result.stdout)


def re_safe_code(value):
    return isinstance(value, str) and value.startswith('operations_') and all(c.islower() or c == '_' for c in value)


def prepare(config_path, config):
    root = safe_path(config['directories']['data'])
    root.mkdir(mode=0o755, parents=True, exist_ok=True)
    mirror = root / 'secrets'
    mirror.mkdir(mode=0o700, exist_ok=True)
    if mirror.stat().st_uid != 0 or mirror.stat().st_mode & 0o077:
        raise RuntimeError('operations_secret_mirror_not_private')
    sources = {
        'grafana-secret-key': 64,
        'grafana-bootstrap-password': 48,
        'pgbackrest.business.cipher': 64,
        'pgbackrest.accounts.cipher': 64,
        'restic.password': 64,
    }
    for name, length in sources.items():
        private_file(SECRET_SOURCE / name, secrets.token_urlsafe(length) + '\n', keep=True)
    client = safe_path(SECRET_SOURCE / 'grafana-client.secret')
    if not client.is_file() or client.stat().st_uid != 0 or client.stat().st_mode & 0o077:
        raise RuntimeError('operations_grafana_client_secret_required')
    for name in ('grafana-client.secret', 'grafana-secret-key', 'grafana-bootstrap-password'):
        private_file(mirror / name, (SECRET_SOURCE / name).read_bytes(), owner=472, group=472, mode=0o400)
    repository = Path('/var/lib/galaxy/backups/product-restic')
    safe_path(repository)
    repository.mkdir(mode=0o700, parents=True, exist_ok=True)
    if repository.stat().st_uid != 0 or repository.stat().st_mode & 0o077:
        raise RuntimeError('operations_local_repository_not_private')
    repository_reference = private_file(SECRET_SOURCE / 'restic.repository', str(repository) + '\n', keep=True)
    if repository_reference.read_text().strip() != str(repository):
        raise RuntimeError('operations_local_repository_reference_changed')
    # A private runnable receiver starts with no outbound destination. smtp-prepare
    # replaces it only after the operator's exact destination is supplied.
    private_file(SECRET_SOURCE / 'alertmanager.json', json.dumps({'global': {'resolve_timeout': '5m'}, 'route': {'receiver': 'not-configured'}, 'receivers': [{'name': 'not-configured'}]}) + '\n', keep=True)
    first = node_action('prepare', config_path)
    actual_path = Path(config['directories']['configuration']) / 'configuration.json'
    pitr = node_action('prepare-pitr', actual_path)
    actual = json.loads(actual_path.read_text())
    for pg in actual['postgres']:
        private_file(pg['cipherFile'], (SECRET_SOURCE / ('pgbackrest.' + pg['id'] + '.cipher')).read_bytes(), owner=pg['uid'], group=pg['gid'], mode=0o400)
    units = node_action('install-units', actual_path)
    repository_result = node_action('repository-init', actual_path)
    plan = node_action('plan', actual_path)
    private_file(STATE / 'plan.json', json.dumps(plan, indent=2) + '\n')
    return save_state('prepare', {'state': 'prepared', 'configuration': str(actual_path), 'units': units['units'], 'started': False,
        'postgresArchiveActivated': False, 'repository': str(repository), 'repositoryState': repository_result['state'], 'offsite': False,
        'stanzas': [{k: pg[k] for k in ('id', 'container', 'dataPath', 'systemIdentifier', 'uid', 'gid')} for pg in actual['postgres']],
        'secretReferences': [str(SECRET_SOURCE / name) for name in [*sources, 'grafana-client.secret']], 'configure': plan['configure']})


def download_runtime(name, version, binary, github):
    directory = Path('/opt/galaxy/runtime') / (name + '-' + version + '.linux-amd64')
    if (directory / binary).is_file():
        return {'tool': name, 'version': version, 'path': str(directory / binary), 'state': 'existing'}
    if directory.exists():
        raise RuntimeError('operations_runtime_target_already_exists')
    archive = STATE / (directory.name + '.tar.gz')
    url = 'https://github.com/' + github + '/releases/download/v' + version + '/' + directory.name + '.tar.gz'
    if not archive.is_file():
        run(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--location', '--connect-timeout', '20', '--max-time', '600', url, '--output', str(archive)], timeout=620, log=STATE / 'tools.log')
    with tarfile.open(archive, 'r:gz') as bundle:
        for item in bundle.getmembers():
            if not (item.name.startswith(directory.name + '/') or item.isdir() and item.name == directory.name) or item.issym() or item.islnk():
                raise RuntimeError('operations_runtime_archive_invalid')
        bundle.extractall('/opt/galaxy/runtime', filter='data')
    archive.unlink()
    if not os.access(directory / binary, os.X_OK):
        raise RuntimeError('operations_runtime_binary_missing')
    return {'tool': name, 'version': version, 'path': str(directory / binary), 'state': 'installed'}


def tools(config):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    save_state('tools', {'state': 'running', 'phase': 'runtimes'})
    runtimes = [download_runtime('alertmanager', '0.34.1', 'alertmanager', 'prometheus/alertmanager'),
                download_runtime('blackbox_exporter', '0.29.0', 'blackbox_exporter', 'prometheus/blackbox_exporter')]
    images = []
    for name in ('grafana', 'loki', 'alloy'):
        save_state('tools', {'state': 'running', 'phase': 'image-' + name, 'runtimes': runtimes, 'images': images})
        run(['/usr/bin/docker', 'pull', config['images'][name]], timeout=1200, log=STATE / 'tools.log')
        images.append(config['images'][name])
    save_state('tools', {'state': 'running', 'phase': 'pgbackrest-build', 'runtimes': runtimes, 'images': images})
    run(['/usr/bin/docker', 'build', '--build-arg', 'POSTGRES_BASE_IMAGE=' + config['images']['postgresBase'], '--tag', config['images']['postgresBackup'], str(SOURCE / 'postgres')], timeout=3600, log=STATE / 'tools.log')
    images.append(config['images']['postgresBackup'])
    return save_state('tools', {'state': 'prepared', 'runtimes': runtimes, 'images': images, 'servicesStarted': False})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'tools', 'status'])
    parser.add_argument('--config', required=True, help='Absolute path to the protected target configuration')
    args = parser.parse_args()
    config_path = safe_path(args.config)
    config = json.loads(config_path.read_text())
    if os.geteuid() != 0 or socket.gethostname() != config['targetHostname']:
        raise RuntimeError('operations_target_host_mismatch')
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.action == 'prepare':
        result = prepare(config_path, config)
    elif args.action == 'tools':
        try:
            result = tools(config)
        except Exception as error:
            save_state('tools', {'state': 'failed', 'errorCode': str(error) if str(error).startswith('operations_') else type(error).__name__})
            raise
    else:
        result = {p.stem: json.loads(p.read_text()) for p in STATE.glob('*.json')}
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'state': 'failed', 'errorCode': code if code.startswith('operations_') else type(error).__name__}))
        raise SystemExit(1)
