import {readFile} from 'node:fs/promises';

export async function publicConfiguration() {
  if (!process.env.GALAXY_WEB_CONFIG_FILE) throw new Error('Missing GALAXY_WEB_CONFIG_FILE');
  const raw = await readFile(/* turbopackIgnore: true */ process.env.GALAXY_WEB_CONFIG_FILE, 'utf8');
  if (raw.length > 16000) throw new Error('Public configuration is too large');
  const config = JSON.parse(raw);
  const endpoint = new URL(config.endpoint);
  if (config.version !== 1 || endpoint.username || endpoint.password
      || !['http:', 'https:'].includes(endpoint.protocol)
      || !Array.isArray(config.signingKeys) || !config.signingKeys.length) throw new Error('Invalid public configuration');
  const signingKeys = config.signingKeys.map((pin) => {
    if (typeof pin.kid !== 'string' || typeof pin.publicKeyPem !== 'string'
        || !pin.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')
        || pin.publicKeyPem.includes('PRIVATE KEY') || !Number.isFinite(pin.notBefore)
        || !Number.isFinite(pin.notAfter) || typeof pin.revoked !== 'boolean') throw new Error('Invalid public signing key');
    return { kid: pin.kid, publicKeyPem: pin.publicKeyPem, notBefore: pin.notBefore, notAfter: pin.notAfter, revoked: pin.revoked };
  });
  return { version: 1, endpoint: endpoint.href.replace(/\/$/, ''), operator: typeof config.operator === 'string' ? config.operator : '银河技术团队', signingKeys };
}
