import { statfs } from 'node:fs/promises';

// A capture and the local restic repository can grow at the same time. Reserve
// two complete source sizes even when deduplication is expected to save space.
export function requiredBackupSpace(sourceBytes, reserveBytes) {
  if (![sourceBytes, reserveBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('operations_capture_size_unknown');
  const required = sourceBytes * 2 + reserveBytes;
  if (!Number.isSafeInteger(required)) throw new Error('operations_capture_size_limit');
  return required;
}

export async function assertBackupSpace(config, sourceBytes, inspect = statfs) {
  const free = await inspect(config.directories.captures);
  const available = Number(free.bavail) * Number(free.bsize);
  if (!Number.isSafeInteger(available) || available < requiredBackupSpace(sourceBytes, config.backup.minimumFreeBytes)) throw new Error('operations_capture_space_unavailable');
}
