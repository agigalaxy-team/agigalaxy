// Installation helper: read only the user's explicitly selected HTTPS website.
// No local identity, business session or cloud authorization is created here.
import { createHash, createPublicKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new Error('Select an exact HTTPS origin without credentials, path or query.');
  return value;
};
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(name => names.includes(name));

export async function prepareServiceConfiguration({ website, endpoint, dataDirectory, output,
  fetch: fetcher = globalThis.fetch, now = Math.floor(Date.now() / 1000) }) {
  origin(website); origin(endpoint);
  if (!isAbsolute(dataDirectory) || !isAbsolute(output) || resolve(dataDirectory) === resolve(output))
    throw new Error('Separate absolute data directory and new configuration file paths required.');
  const response = await fetcher(website + '/galaxy-web-config.json', {
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200 || !response.body || response.redirected)
    throw new Error('The selected website has no readable public service configuration.');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16384) throw new Error('Public service configuration is too large.');
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    throw new Error('Could not read the complete bounded public configuration.');
  }
  const raw = Buffer.concat(chunks);
  let source;
  try { source = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid public configuration JSON.'); }
  if (!exactKeys(source, ['version', 'endpoint', 'operator', 'signingKeys']) || source.version !== 1
    || source.endpoint !== endpoint || !Array.isArray(source.signingKeys)
    || !source.signingKeys.length || source.signingKeys.length > 32)
    throw new Error('Public configuration does not match the explicitly selected service.');
  const trustedKeys = Object.create(null), publicFingerprints = [];
  for (const pin of source.signingKeys) {
    if (!exactKeys(pin, ['kid', 'publicKeyPem', 'notBefore', 'notAfter', 'revoked'])
      || typeof pin.kid !== 'string' || !pin.kid.length || pin.kid.length > 160 || /[\x00-\x1f]/.test(pin.kid)
      || typeof pin.publicKeyPem !== 'string' || pin.publicKeyPem.length > 4096
      || !Number.isSafeInteger(pin.notBefore) || !Number.isSafeInteger(pin.notAfter)
      || pin.notAfter <= pin.notBefore || typeof pin.revoked !== 'boolean' || Object.hasOwn(trustedKeys, pin.kid))
      throw new Error('Invalid or repeated public signing key.');
    let key;
    try { key = createPublicKey(pin.publicKeyPem); } catch { throw new Error('Invalid public signing key encoding.'); }
    if (key.asymmetricKeyType !== 'ed25519' || !pin.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')
      || key.export({ type: 'spki', format: 'pem' }).trim() !== pin.publicKeyPem.trim())
      throw new Error('A public Ed25519 signing key is required.');
    trustedKeys[pin.kid] = { publicKeyPem: pin.publicKeyPem, notBefore: pin.notBefore,
      notAfter: pin.notAfter, revoked: pin.revoked };
    publicFingerprints.push({ kid: pin.kid, sha256: createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' })).digest('hex'),
      notBefore: pin.notBefore, notAfter: pin.notAfter, revoked: pin.revoked });
  }
  if (!publicFingerprints.some(pin => !pin.revoked && pin.notBefore <= now && pin.notAfter > now))
    throw new Error('The selected service has no currently valid signing key.');
  const config = { version: 2, endpoint, website, dataDirectory: resolve(dataDirectory), trustedKeys };
  // wx preserves an existing user's endpoint, pins and local data choice.
  await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { configured: true, output: resolve(output), website, endpoint, publicFingerprints,
    publicConfigurationSha256: createHash('sha256').update(raw).digest('hex'),
    trustSource: 'explicitly-selected-website-over-HTTPS', connected: false,
    identityCreated: false, dataDirectoryCreated: false, automaticKeyRefresh: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [website, endpoint, dataDirectory, output, ...extra] = process.argv.slice(2);
    if (extra.length || !output) throw new Error('Usage: node prepare-service-config.mjs <website-origin> <API-origin> <absolute-data-directory> <new-absolute-config-file>');
    console.log(JSON.stringify(await prepareServiceConfiguration({ website, endpoint, dataDirectory, output })));
  } catch (error) {
    process.stderr.write(error?.code === 'EEXIST' ? 'Configuration already exists; no existing settings changed.\n'
      : 'Could not prepare the selected public configuration. Check the explicit origins, valid public keys and new output path.\n');
    process.exitCode = 1;
  }
}
