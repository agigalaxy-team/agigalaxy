"""Bounded Galaxy release retention; called under the common operations job lock."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

from backup_housekeeping import PolicyError, atomic_json, plain_path, read_json

ROOTS = ('/srv/galaxy/admin/releases', '/srv/galaxy/website/releases', '/opt/galaxy/releases')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9._-]+)?\Z')
TRASH = '.galaxy-release-retention'
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')


def family(root, name):
    if VERSION.fullmatch(name):
        return 'product'
    if str(root) == ROOTS[1]:
        if re.fullmatch(r'\.cms-[A-Za-z0-9-]+', name):
            return 'published-site'
        if re.fullmatch(r'[0-9]{8}(?:-[A-Za-z0-9._-]+|T[0-9]{6}Z)', name):
            return 'product'
    if str(root) == ROOTS[2]:
        if re.fullmatch(r'maintenance-[A-Za-z0-9._-]+', name):
            return 'maintenance'
        if re.fullmatch(r'official-[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9-]+', name):
            return 'product'
    return None


def release_references(text, roots):
    text = text.replace(os.sep, '/')
    result = set()
    for root in roots:
        for match in re.finditer(re.escape(root.as_posix()) + r'/([A-Za-z0-9._-]+)', text):
            if family(root, match[1]):
                result.add(root / match[1])
        # Open file descriptors follow a renamed directory into quarantine. Map
        # them back to the original release before the final deletion check.
        for match in re.finditer(re.escape((root / TRASH).as_posix()) + r'/([0-9a-f-]+)/payload(?:/|$)', text):
            if UUID.fullmatch(match[1]):
                marker = read_json(root / TRASH / match[1] / 'owner.json', limit=8192)
                original = Path(marker.get('originalPath', ''))
                if original.parent != root or not family(root, original.name):
                    raise PolicyError('release_quarantine_invalid')
                result.add(original)
    return result


def run(args, timeout=45):
    try:
        p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise PolicyError('release_reference_command_unavailable') from None
    if p.returncode:
        raise PolicyError('release_reference_command_failed')
    return p.stdout


def runtime_references(roots):
    """Read reference metadata only. Raw command lines/config values never leave memory."""
    protected = set()
    names = run(['systemctl', 'list-units', '--all', '--plain', '--no-legend', '--no-pager', 'galaxy*']).splitlines()
    units = [line.split()[0] for line in names if line.strip() and line.split()[0].endswith('.service')]
    if not units:
        raise PolicyError('release_service_inventory_unavailable')
    fields = 'ExecStart,ExecStartPre,ExecStartPost,ExecStopPost,WorkingDirectory,EnvironmentFiles,ReadOnlyPaths,ReadWritePaths,BindPaths,BindReadOnlyPaths,RootDirectory,RootImage'
    metadata = run(['systemctl', 'show', '--no-pager', '--property=' + fields, *units])
    protected |= release_references(metadata, roots)
    for line in metadata.splitlines():
        if not line.startswith('EnvironmentFiles='):
            continue
        for value in re.findall(r'/etc/galaxy/[A-Za-z0-9._/-]+', line):
            p = Path(value)
            if p.is_symlink() or not p.is_file() or p.stat().st_size > 262144:
                raise PolicyError('release_service_reference_invalid')
            for setting in p.read_text().splitlines():
                if re.match(r'^[A-Z][A-Z0-9_]*(?:DIRECTORY|ROOT|PATH|FILE)=/', setting):
                    protected |= release_references(setting.split('=', 1)[1], roots)
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            for name in ['cwd', 'exe']:
                try:
                    protected |= release_references(os.readlink(p / name), roots)
                except (FileNotFoundError, ProcessLookupError):
                    pass
            try:
                protected |= release_references((p / 'cmdline').read_bytes().decode(errors='replace').replace('\x00', '\n'), roots)
            except (FileNotFoundError, ProcessLookupError):
                pass
            for fd in (p / 'fd').iterdir():
                try:
                    protected |= release_references(os.readlink(fd), roots)
                except (FileNotFoundError, ProcessLookupError):
                    continue
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            raise PolicyError('release_process_reference_unreadable') from None
    for root in roots:
        for p in root.parent.iterdir():
            if p.is_symlink():
                protected |= release_references(str(p.resolve()), roots)
    containers = run(['docker', 'ps', '-aq']).split()
    if containers:
        for line in run(['docker', 'inspect', '--format', '{{json .Mounts}}', *containers]).splitlines():
            mounts = json.loads(line)
            for mount in mounts:
                protected |= release_references(str(mount.get('Source', '')), roots)
    # Includes mount points below candidate directories, even for non-Docker mounts.
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        protected |= release_references(line.split()[4].replace('\\040', ' '), roots)
    return protected


def configuration_references(config, roots):
    protected = release_references(json.dumps(config), roots)
    current = Path('/etc/galaxy/operations/configuration.json')
    if current.exists():
        protected |= release_references(json.dumps(read_json(current)), roots)
    for p in [Path('/etc/galaxy/maintenance/agent.json'), Path('/etc/caddy/Caddyfile')]:
        if p.exists():
            protected |= release_references(p.read_text(), roots)
    control = Path('/var/lib/galaxy/maintenance/models')
    for p in control.glob('*.json'):
        value = read_json(p)
        if value.get('state') not in ['completed', 'cancelled', 'failed', 'succeeded', 'expired']:
            protected |= release_references(json.dumps(value), roots)
    # Only explicitly declared path metadata from existing private env files.
    # Runtime services already specify these files; credentials are not returned.
    for p in Path('/etc/galaxy').glob('*.env'):
        if p.is_symlink() or not p.is_file() or p.stat().st_size > 262144:
            continue
        for line in p.read_text().splitlines():
            if re.match(r'^[A-Z][A-Z0-9_]*(?:DIRECTORY|ROOT|PATH|FILE)=/', line):
                protected |= release_references(line.split('=', 1)[1], roots)
    return protected


def primary_release_predecessors(roots):
    """A pending upload must not evict the running version's actual predecessor."""
    units = ['galaxy-admin-pilot.service', 'galaxy-api@pilot.service', 'galaxy-worker@pilot.service', 'galaxy-content-publisher-pilot.service', 'galaxy-maintenance.service']
    metadata = run(['systemctl', 'show', '--no-pager', '--property=ActiveState,ExecStart,WorkingDirectory,EnvironmentFiles', *units])
    current = set()
    for block in metadata.split('\n\n'):
        fields = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if fields.get('ActiveState') != 'active':
            continue
        current |= release_references(block, roots)
        for value in re.findall(r'/etc/galaxy/[A-Za-z0-9._/-]+', fields.get('EnvironmentFiles', '')):
            p = Path(value)
            if p.is_symlink() or not p.is_file() or p.stat().st_size > 262144:
                raise PolicyError('release_service_reference_invalid')
            for line in p.read_text().splitlines():
                if line.startswith('GALAXY_RELEASE_DIRECTORY=/'):
                    current |= release_references(line.split('=', 1)[1], roots)
    pointer = Path('/srv/galaxy/website/current')
    if pointer.is_symlink():
        current |= release_references(str(pointer.resolve()), roots)
    result = set(current)
    for active in current:
        peers = [p for p in active.parent.iterdir() if not p.is_symlink() and p.is_dir() and family(active.parent, p.name) == family(active.parent, active.name)]
        peers.sort(key=lambda p: p.stat().st_ctime, reverse=True)
        if active in peers and peers.index(active) + 1 < len(peers):
            result.add(peers[peers.index(active) + 1])
    return result


def symlink_dependencies(protected, roots):
    protected = set(protected)
    seen = set()
    while protected - seen:
        release = next(iter(protected - seen))
        seen.add(release)
        if not release.exists():
            continue
        plain_path(str(release), directory=True)
        for directory, dirs, files in os.walk(release, followlinks=False):
            for name in dirs + files:
                p = Path(directory) / name
                if p.is_symlink():
                    protected |= release_references(str(p.resolve()), roots)
    return protected


def release_plan(roots, protected, now, keep=2, minimum_age=3600):
    kept = {p: 'referenced' for p in protected}
    candidates = []
    for root in roots:
        groups = {}
        for p in root.iterdir():
            if p.is_symlink() or not p.is_dir():
                continue
            kind = family(root, p.name)
            if kind is None:
                continue
            groups.setdefault(kind, []).append(p)
        for group in groups.values():
            group.sort(key=lambda p: p.stat().st_ctime, reverse=True)
            for p in group[:keep]:
                kept.setdefault(p, 'recent-rollback')
            for p in group:
                if now - max(p.stat().st_ctime, p.stat().st_mtime) < minimum_age:
                    kept.setdefault(p, 'recent-upload-or-build')
            candidates.extend(p for p in group if p not in kept)
    return sorted(candidates), kept


def checked_release(root, target):
    root = plain_path(str(root), directory=True)
    target = plain_path(str(target), directory=True)
    if target.parent != root or not family(root, target.name) or target.stat().st_dev != root.stat().st_dev or target.is_mount():
        raise PolicyError('release_cleanup_outside_registered_root')
    return root, target


def quarantine(root, target):
    root, target = checked_release(root, target)
    trash = root / TRASH
    if not trash.exists():
        trash.mkdir(mode=0o700)
    plain_path(str(trash), directory=True)
    entry = trash / str(uuid.uuid4())
    entry.mkdir(mode=0o700)
    info = target.stat()
    marker = {'version': 1, 'id': entry.name, 'state': 'quarantined', 'originalPath': str(target), 'inode': info.st_ino, 'device': info.st_dev, 'at': datetime.now(timezone.utc).isoformat()}
    atomic_json(entry / 'owner.json', marker)
    # Existing or redirected trash paths are never reused.
    target.rename(entry / 'payload')
    return entry


def complete_quarantine(root, entry, protected):
    root = plain_path(str(root), directory=True)
    entry = plain_path(str(entry), directory=True)
    if entry.parent != root / TRASH or not UUID.fullmatch(entry.name):
        raise PolicyError('release_quarantine_invalid')
    value = read_json(entry / 'owner.json', limit=8192)
    original = Path(value.get('originalPath', ''))
    if value.get('version') != 1 or value.get('id') != entry.name or original.parent != root or not family(root, original.name):
        raise PolicyError('release_quarantine_invalid')
    if {p.name for p in entry.iterdir()} - {'owner.json', 'payload'}:
        raise PolicyError('release_quarantine_unknown_files')
    payload = entry / 'payload'
    if not payload.exists() and not payload.is_symlink():
        # Interrupted after deletion or before rename. Never remove an unknown file.
        (entry / 'owner.json').unlink()
        entry.rmdir()
        return {'path': str(original), 'state': 'already-complete'}
    plain_path(str(payload), directory=True)
    info = payload.stat()
    if info.st_ino != value.get('inode') or info.st_dev != value.get('device'):
        raise PolicyError('release_quarantine_identity_changed')
    if original in protected:
        if value.get('state') != 'quarantined':
            return {'path': str(original), 'state': 'protected-quarantine-needs-review'}
        if original.exists() or original.is_symlink():
            return {'path': str(original), 'state': 'protected-quarantine-needs-review'}
        payload.rename(original)
        state = 'restored-new-reference'
    else:
        if not shutil.rmtree.avoids_symlink_attacks:
            raise PolicyError('release_safe_rmtree_required')
        value['state'] = 'deleting'
        atomic_json(entry / 'owner.json', value)
        shutil.rmtree(payload)
        state = 'deleted'
    (entry / 'owner.json').unlink()
    entry.rmdir()
    return {'path': str(original), 'state': state}


def clean_releases(policy, config, apply):
    if policy.get('enabled') is not True or policy.get('roots') != list(ROOTS) or policy.get('keepPerFamily') != 2 or policy.get('minimumAgeMinutes') != 60:
        raise PolicyError('release_retention_policy_invalid')
    roots = [plain_path(value, directory=True) for value in ROOTS]
    protected = runtime_references(roots) | configuration_references(config, roots) | primary_release_predecessors(roots)
    # First add the small rollback set, then resolve links from every retained tree.
    _, kept = release_plan(roots, protected, time.time())
    protected = symlink_dependencies(set(kept), roots)
    candidates, kept = release_plan(roots, protected, time.time())
    progress = {'version': 1, 'at': datetime.now(timezone.utc).isoformat(), 'applied': apply, 'state': 'running' if apply else 'preview', 'candidateCount': len(candidates), 'candidates': [str(p) for p in candidates], 'kept': [{'path': str(p), 'reason': why} for p, why in sorted(kept.items())], 'events': []}
    status = Path(config['directories']['status']) / 'release-housekeeping.json'
    def save():
        if apply:
            progress['disk'] = dict(zip(['totalBytes', 'usedBytes', 'freeBytes'], shutil.disk_usage('/')))
            atomic_json(status, progress)
    save()
    if not apply:
        return progress
    for root in roots:
        trash = root / TRASH
        if trash.exists():
            plain_path(str(trash), directory=True)
            for entry in sorted(trash.iterdir()):
                if UUID.fullmatch(entry.name) and not entry.is_symlink() and entry.is_dir():
                    progress['events'].append(complete_quarantine(root, entry, protected | runtime_references(roots)))
                    save()
    for candidate in candidates:
        root = candidate.parent
        # Recheck fresh metadata for each exact target. A publication that starts
        # after planning can protect its directory without waiting for this job.
        fresh = runtime_references(roots) | configuration_references(config, roots) | primary_release_predecessors(roots)
        if fresh - protected:
            protected |= symlink_dependencies(fresh - protected, roots)
        if candidate in protected or candidate in fresh:
            progress['events'].append({'path': str(candidate), 'state': 'skipped-new-reference'})
            save()
            continue
        if not candidate.exists():
            continue
        if time.time() - max(candidate.stat().st_ctime, candidate.stat().st_mtime) < 3600:
            continue
        entry = quarantine(root, candidate)
        fresh = protected | runtime_references(roots) | configuration_references(config, roots) | primary_release_predecessors(roots)
        if fresh - protected:
            protected |= symlink_dependencies(fresh - protected, roots)
            fresh |= protected
        progress['events'].append(complete_quarantine(root, entry, fresh))
        save()
    progress['state'] = 'attention' if any(e['state'] == 'protected-quarantine-needs-review' for e in progress['events']) else 'complete'
    progress['finishedAt'] = datetime.now(timezone.utc).isoformat()
    save()
    return progress
