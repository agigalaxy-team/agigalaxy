#!/usr/bin/env python3
"""Root-only bounded backup housekeeping. No business data or Docker volumes are pruned."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid

GIB = 1024 ** 3
CAPTURE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
POINT = re.compile(r"[0-9a-f]{64}\Z")
ENV_KEYS = {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_DEFAULT_REGION', 'AWS_REGION', 'B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY', 'AZURE_ACCOUNT_NAME', 'AZURE_ACCOUNT_KEY', 'AZURE_ACCOUNT_SAS', 'GOOGLE_APPLICATION_CREDENTIALS'}


class PolicyError(RuntimeError):
    pass


def plain_path(value, *, directory=False, private=False):
    p = Path(value)
    if not p.is_absolute() or str(p) != value or p == Path('/'):
        raise PolicyError('housekeeping_path_invalid')
    for current in [p, *p.parents[:-1]]:
        if current.is_symlink():
            raise PolicyError('housekeeping_symlink_rejected')
    info = p.stat()
    if directory and not stat.S_ISDIR(info.st_mode):
        raise PolicyError('housekeeping_directory_required')
    if private and (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077):
        raise PolicyError('housekeeping_private_configuration_required')
    return p


def read_json(p, *, limit=1024 * 1024):
    if p.is_symlink() or not p.is_file() or p.stat().st_size > limit:
        raise PolicyError('housekeeping_record_invalid')
    return json.loads(p.read_text())


def atomic_json(p, value):
    tmp = p.with_name(p.name + '.' + str(uuid.uuid4()) + '.tmp')
    try:
        with open(tmp, 'x', encoding='utf-8') as f:
            os.chmod(tmp, 0o600)
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(tmp, p)
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def job_lock(root):
    """Same lock and owner format as operations-stack/host.mjs, including manual jobs."""
    directory = plain_path(str(root), directory=True) / '.operations-job.lock'
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        plain_path(str(directory), directory=True)
        owner = read_json(directory / 'owner.json')
        pid = owner.get('pid')
        if owner.get('hostname') != socket.gethostname() or type(pid) is not int or pid < 1:
            raise PolicyError('housekeeping_lock_unknown')
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            # Unknown extra files prevent rmdir; never recursively erase a lock.
            (directory / 'owner.json').unlink()
            directory.rmdir()
            directory.mkdir(mode=0o700)
        else:
            raise PolicyError('housekeeping_job_busy')
    try:
        atomic_json(directory / 'owner.json', {'pid': os.getpid(), 'hostname': socket.gethostname(), 'startedAt': int(time.time())})
        yield
    finally:
        (directory / 'owner.json').unlink(missing_ok=True)
        directory.rmdir()


def stage_candidates(root, now, max_age_hours):
    root = plain_path(str(root), directory=True)
    result = []
    for p in sorted(root.iterdir()):
        if p.is_symlink() or not p.is_dir() or not CAPTURE.fullmatch(p.name):
            continue
        try:
            marker = read_json(p / '.galaxy-capture', limit=8192)
        except (PolicyError, ValueError, OSError):
            continue
        if marker != {'id': p.name, 'purpose': 'backup'}:
            continue
        if now - p.stat().st_mtime >= max_age_hours * 3600:
            result.append(p)
    return result


def remove_stage(root, p):
    root = plain_path(str(root), directory=True)
    target = plain_path(str(p), directory=True)
    if target.parent != root or not CAPTURE.fullmatch(target.name):
        raise PolicyError('housekeeping_cleanup_outside_root')
    if read_json(target / '.galaxy-capture', limit=8192) != {'id': target.name, 'purpose': 'backup'}:
        raise PolicyError('housekeeping_marker_mismatch')
    if not shutil.rmtree.avoids_symlink_attacks:
        raise PolicyError('housekeeping_safe_rmtree_required')
    shutil.rmtree(target)


def command(args, *, env=None, timeout=3600):
    try:
        p = subprocess.run(args, env=env, text=True, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise PolicyError('housekeeping_command_unavailable') from None
    if p.returncode:
        # Backend output and arguments can contain credentials. Do not log them.
        raise PolicyError('housekeeping_command_failed_' + Path(args[0]).name) from None
    return p.stdout


def restic_environment(config):
    backup = config['backup']
    env = {k: os.environ[k] for k in ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] if k in os.environ}
    for key, field in [('RESTIC_REPOSITORY_FILE', 'repositoryFile'), ('RESTIC_PASSWORD_FILE', 'passwordFile')]:
        env[key] = str(plain_path(backup[field], private=True))
    if backup.get('credentialEnvironmentFile'):
        path = plain_path(backup['credentialEnvironmentFile'], private=True)
        if path.stat().st_size > 65536:
            raise PolicyError('housekeeping_credential_environment_invalid')
        for line in path.read_text().splitlines():
            if not line or line.lstrip().startswith('#'):
                continue
            key, sep, value = line.partition('=')
            if not sep or key not in ENV_KEYS or any(ord(ch) < 32 for ch in value):
                raise PolicyError('housekeeping_credential_environment_invalid')
            env[key] = value
    return env


def protected_points(policy, config):
    protected = set(policy.get('protectedSnapshots', []))
    last = Path(config['directories']['status']) / 'last-capture.json'
    if last.exists():
        protected.add(read_json(last).get('snapshotId'))
    control = plain_path(policy['controlDirectory'], directory=True)
    verified = []
    for p in control.glob('verified-*.json'):
        value = read_json(p)
        if value.get('basis') == 'restic-check-read-data-and-point-still-present':
            verified.append(value)
    if verified:
        protected.add(max(verified, key=lambda x: x.get('checkedAt', '')).get('pointId'))
    for p in (control / 'models').glob('*.json'):
        value = read_json(p)
        if value.get('state') not in ['completed', 'cancelled', 'failed', 'succeeded', 'expired']:
            protected.add(value.get('pointId') or value.get('snapshotId'))
    return {p for p in protected if isinstance(p, str) and POINT.fullmatch(p)}


def removable_snapshots(snapshots, groups, protected, host):
    eligible = {s['id']: s for s in snapshots if POINT.fullmatch(s.get('id', '')) and s.get('hostname') == host and 'galaxy-product' in s.get('tags', [])}
    remove = {s['id'] for group in groups for s in group.get('remove', []) if s.get('id') in eligible} - protected
    if len(eligible) - len(remove) < min(2, len(eligible)):
        raise PolicyError('housekeeping_minimum_recovery_points')
    return sorted(remove)


def repository_retention(policy, config, apply):
    env = restic_environment(config)
    executable, host = config['tools']['restic'], config['backup']['resticHost']
    def restic(args):
        return command([executable, '--no-cache', *args], env=env, timeout=7200)
    snapshots = json.loads(restic(['snapshots', '--host', host, '--tag', 'galaxy-product', '--json']))
    retention = config['backup']['retention']
    groups = json.loads(restic(['forget', '--host', host, '--tag', 'galaxy-product', '--group-by', 'host', '--keep-last', '2', '--keep-daily', str(retention['daily']), '--keep-weekly', str(retention['weekly']), '--keep-monthly', str(retention['monthly']), '--dry-run', '--json']))
    protected = protected_points(policy, config)
    remove = removable_snapshots(snapshots, groups, protected, host)
    pending = Path(config['directories']['status']) / 'retention-prune.pending.json'
    if apply and remove:
        # Delete only the revalidated complete IDs, then let restic reclaim packs.
        atomic_json(pending, {'version': 1, 'snapshotIds': remove})
        restic(['forget', *remove])
    if apply and pending.exists():
        restic(['prune', '--max-repack-size', '1G'])
        restic(['check'])
        pending.unlink()
    return {'removed' if apply else 'planned': remove, 'protected': sorted(protected), 'beforeCount': len(snapshots)}


def disk_state(path='/'):
    v = shutil.disk_usage(path)
    return {'totalBytes': v.total, 'usedBytes': v.used, 'freeBytes': v.free, 'usedPercent': round(v.used * 100 / v.total, 2)}


def active_working_directories():
    result = []
    for p in Path('/proc').glob('[0-9]*/cwd'):
        try:
            result.append(p.resolve(strict=True))
        except OSError:
            continue
    return result


def next_build_cache_candidates(root, now, age_hours, keep_recent=5):
    root = plain_path(str(root), directory=True)
    releases = [p for p in root.iterdir() if not p.is_symlink() and p.is_dir() and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:\.pre-proxy-fix)?', p.name)]
    releases.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    active = active_working_directories()
    result = []
    for release in releases[keep_recent:]:
        if any(p == release or release in p.parents for p in active):
            continue
        for relative in ['.next/cache', 'apps/galaxy-admin/.next/cache']:
            for name in ['turbopack', 'webpack', 'swc']:
                p = release / relative / name
                if not p.is_dir() or p.is_symlink():
                    continue
                try:
                    plain_path(str(p), directory=True)
                except (PolicyError, OSError):
                    continue
                if now - max(p.stat().st_mtime, release.stat().st_mtime) >= age_hours * 3600:
                    result.append(p)
    return result


def remove_next_build_cache(root, target):
    root = plain_path(str(root), directory=True)
    target = plain_path(str(target), directory=True)
    try:
        parts = target.relative_to(root).parts
    except ValueError:
        raise PolicyError('housekeeping_cache_outside_root') from None
    if len(parts) not in [4, 6] or parts[-3:-1] != ('.next', 'cache') or parts[-1] not in ['turbopack', 'webpack', 'swc'] or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:\.pre-proxy-fix)?', parts[0]):
        raise PolicyError('housekeeping_cache_outside_root')
    if len(parts) == 6 and parts[1:3] != ('apps', 'galaxy-admin'):
        raise PolicyError('housekeeping_cache_outside_root')
    release = root / parts[0]
    if any(p == release or release in p.parents for p in active_working_directories()):
        raise PolicyError('housekeeping_cache_in_use')
    if not shutil.rmtree.avoids_symlink_attacks:
        raise PolicyError('housekeeping_safe_rmtree_required')
    shutil.rmtree(target)


def validate(policy, config):
    if policy.get('version') != 1 or policy.get('targetHostname') != socket.gethostname() or config.get('targetHostname') != socket.gethostname():
        raise PolicyError('housekeeping_target_mismatch')
    for key, minimum, maximum in [('stageMaxAgeHours', 1, 720), ('pressureStageMinAgeHours', 1, 720), ('pressureFreeGiB', 32, 1024), ('pressureUsedPercent', 50, 95), ('minimumFreeGiB', 20, 1024)]:
        value = policy.get(key)
        if type(value) is not int or not minimum <= value <= maximum:
            raise PolicyError('housekeeping_policy_invalid')
    if policy['pressureStageMinAgeHours'] > policy['stageMaxAgeHours']:
        raise PolicyError('housekeeping_policy_invalid')
    for value in policy.get('protectedSnapshots', []):
        if not isinstance(value, str) or not POINT.fullmatch(value):
            raise PolicyError('housekeeping_policy_invalid')
    for key in ['captures', 'status']:
        plain_path(config['directories'][key], directory=True)
    plain_path(policy['controlDirectory'], directory=True)
    plain_path(policy['diagnosticsDirectory'], directory=True)
    cache_root = policy.get('nextBuildCacheRoot')
    if cache_root is not None:
        if cache_root != '/srv/galaxy/admin/releases':
            raise PolicyError('housekeeping_cache_root_invalid')
        plain_path(cache_root, directory=True)


def run(policy, config, action, apply):
    validate(policy, config)
    before = disk_state()
    pressure = before['freeBytes'] < policy['pressureFreeGiB'] * GIB or before['usedPercent'] >= policy['pressureUsedPercent']
    age = policy['pressureStageMinAgeHours'] if pressure else policy['stageMaxAgeHours']
    report = {'version': 1, 'at': datetime.now(timezone.utc).isoformat(), 'action': action, 'applied': apply, 'before': before, 'pressure': pressure, 'stages': [], 'errors': []}
    with job_lock(Path(config['directories']['status'])):
        for p in stage_candidates(Path(config['directories']['captures']), time.time(), age):
            report['stages'].append(p.name)
            if apply:
                # Keep only bounded metadata, never a second copy of failed data.
                record = {'id': p.name, 'purpose': 'backup', 'cleanedAt': report['at'], 'modifiedAt': p.stat().st_mtime, 'pressure': pressure, 'hadManifest': (p / 'capture.json').is_file()}
                atomic_json(Path(policy['diagnosticsDirectory']) / (p.name + '.json'), record)
                remove_stage(Path(config['directories']['captures']), p)
        if action == 'clean':
            try:
                report['repository'] = repository_retention(policy, config, apply)
            except (PolicyError, ValueError, KeyError) as e:
                report['errors'].append(str(e) if isinstance(e, PolicyError) else 'housekeeping_repository_metadata_invalid')
        diagnostics = Path(policy['diagnosticsDirectory'])
        for p in diagnostics.glob('*.json'):
            if CAPTURE.fullmatch(p.stem) and not p.is_symlink() and p.is_file() and time.time() - p.stat().st_mtime > 30 * 86400 and apply:
                p.unlink()
        if policy.get('nextBuildCacheRoot'):
            cache_root = Path(policy['nextBuildCacheRoot'])
            caches = next_build_cache_candidates(cache_root, time.time(), 6 if pressure else 48)
            report['buildCaches'] = []
            for p in caches:
                if apply:
                    # Only compiler caches; standalone output, code, media and
                    # dependencies remain usable for normal release rollback.
                    try:
                        remove_next_build_cache(cache_root, p)
                    except PolicyError as e:
                        if str(e) == 'housekeeping_cache_in_use':
                            continue
                        raise
                report['buildCaches'].append(str(p))
        if action == 'clean' and policy.get('releaseRetention', {}).get('enabled'):
            from release_housekeeping import clean_releases
            release_result = clean_releases(policy['releaseRetention'], config, apply)
            report['releaseRetention'] = {
                'state': release_result['state'], 'candidateCount': release_result['candidateCount'],
                'processedCount': len(release_result['events']),
                'deletedCount': sum(e['state'] == 'deleted' for e in release_result['events']),
                'retainedCount': len(release_result['kept']),
                'resultFile': str(Path(config['directories']['status']) / 'release-housekeeping.json')
            } if apply else release_result
            if report['releaseRetention']['state'] == 'attention':
                report['errors'].append('housekeeping_release_retention_needs_review')
        if apply and pressure:
            for name, args in [
                ('buildCache', [config['tools']['docker'], 'builder', 'prune', '--force', '--filter', 'until=48h', '--keep-storage=10GB']),
                ('journal', ['/usr/bin/journalctl', '--rotate', '--vacuum-size=512M', '--vacuum-time=14d'])
            ]:
                try:
                    command(args, timeout=600)
                    report[name] = 'completed'
                except PolicyError as e:
                    report['errors'].append(str(e))
        report['after'] = disk_state()
        if action == 'prepare-backup' and report['after']['freeBytes'] < policy['minimumFreeGiB'] * GIB:
            report['errors'].append('housekeeping_backup_reserve_unavailable')
        report['state'] = 'attention' if report['errors'] or report['after']['freeBytes'] < policy['minimumFreeGiB'] * GIB else 'complete'
        if apply:
            atomic_json(Path(config['directories']['status']) / 'housekeeping.json', report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['clean', 'prepare-backup'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PolicyError('housekeeping_root_required')
    policy = read_json(plain_path(args.config, private=True))
    config = read_json(plain_path(policy['operationsConfigurationFile'], private=True))
    try:
        report = run(policy, config, args.action, args.apply)
    except PolicyError as e:
        if str(e) != 'housekeeping_job_busy' or args.action != 'clean':
            raise
        report = {'state': 'busy', 'reason': 'backup-or-restore-active'}
    print(json.dumps(report, ensure_ascii=False))
    if report.get('state') == 'attention':
        return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (PolicyError, OSError, ValueError, KeyError) as failure:
        print(json.dumps({'state': 'failed', 'code': str(failure) if isinstance(failure, PolicyError) else 'housekeeping_failed'}), file=sys.stderr)
        sys.exit(1)
