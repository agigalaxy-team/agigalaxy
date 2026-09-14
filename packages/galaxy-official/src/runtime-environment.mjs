import { isAbsolute, relative, basename, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';

// Validate before opening a database or loading signing material. No discovery,
// fallback environment or secret values are included in errors or return data.
export function assertRuntimeEnvironment(env, role) {
  const fail = () => { throw new Error('Invalid isolated runtime configuration'); };
  const stage = env.GALAXY_ENVIRONMENT;
  if (!['local', 'integration', 'pilot'].includes(stage) || !['api', 'worker', 'migration'].includes(role)) fail();
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { fail(); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname
    || database.pathname !== `/galaxy_${stage}` || !database.username || database.hash || database.search) fail();
  // URL query options could override host/dbname/user in pg. Keep the destination
  // unambiguous; TLS configuration needs its own reviewed configuration path.
  const signingFields = ['GALAXY_SIGNING_KEY_FILE', 'GALAXY_SIGNING_KEY_ID', 'GALAXY_ROOT_PINS_FILE',
    'GALAXY_KEYRING_FILE', 'GALAXY_TRUST_DIRECTORY'];
  if (role !== 'api') {
    if (signingFields.some(field => env[field] !== undefined)) fail();
    return Object.freeze({ environment: stage, role });
  }
  const directory = env.GALAXY_ENVIRONMENT_DIRECTORY;
  if (typeof directory !== 'string' || !isAbsolute(directory) || basename(resolve(directory)) !== stage) fail();
  for (const field of signingFields.filter(field => field !== 'GALAXY_SIGNING_KEY_ID')) {
    const path = env[field];
    if (typeof path !== 'string' || !isAbsolute(path)) fail();
    const child = relative(resolve(directory), resolve(path));
    if (!child || child === '..' || child.startsWith('..\\') || child.startsWith('../') || isAbsolute(child)) fail();
  }
  if (!env.GALAXY_SIGNING_KEY_ID) fail();
  return Object.freeze({ environment: stage, role });
}

export async function assertRuntimePaths(env) {
  try {
    const directory = await realpath(env.GALAXY_ENVIRONMENT_DIRECTORY);
    if (directory !== resolve(env.GALAXY_ENVIRONMENT_DIRECTORY)) throw new Error();
    for (const field of ['GALAXY_SIGNING_KEY_FILE', 'GALAXY_ROOT_PINS_FILE', 'GALAXY_KEYRING_FILE', 'GALAXY_TRUST_DIRECTORY']) {
      const actual = await realpath(env[field]);
      if (actual !== resolve(env[field])) throw new Error();
      const child = relative(directory, actual);
      if (!child || child === '..' || child.startsWith('..\\') || child.startsWith('../') || isAbsolute(child)) throw new Error();
    }
  } catch { throw new Error('Invalid isolated runtime paths'); }
}
