import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const website = path.join(root, 'apps/galaxy-site/dist');
const web = path.join(root, 'packages/galaxy-web/dist');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/plain', '.txt': 'text/plain', '.xml': 'application/xml', '.tgz': 'application/gzip' };

async function publicConfiguration() {
  if (!process.env.GALAXY_WEB_CONFIG_FILE) throw new Error('Missing GALAXY_WEB_CONFIG_FILE');
  const raw = await readFile(process.env.GALAXY_WEB_CONFIG_FILE, 'utf8');
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

export function productMiddleware({ development = false } = {}) {
  return async (request, response, next = () => { response.writeHead(404); response.end(); }) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      const application = pathname === '/app' || pathname.startsWith('/app/');
      if (development && application) return next();
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      if (pathname === '/galaxy-web-config.json') {
        try {
          const config = await publicConfiguration();
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(request.method === 'HEAD' ? undefined : JSON.stringify(config));
        } catch {
          response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ error: 'website_configuration_required', message: 'Set GALAXY_WEB_CONFIG_FILE to the selected API public configuration and allow this website origin in that API browser policy.' }));
        }
        return;
      }
      if (development && (pathname.startsWith('/@') || pathname.startsWith('/node_modules/'))) return next();
      const directory = application ? web : website;
      const relative = application ? pathname.startsWith('/app/assets/') ? pathname.slice(5) : 'index.html'
        : '.' + pathname + (pathname.endsWith('/') ? 'index.html' : '');
      const target = path.resolve(directory, relative);
      if (target !== directory && !target.startsWith(directory + path.sep)) { response.writeHead(404); response.end(); return; }
      let content;
      try { content = await readFile(target); }
      catch {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        response.end(await readFile(path.join(website, '404.html')).catch(() => Buffer.from('Run npm run build before starting the product preview.')));
        return;
      }
      response.writeHead(200, { 'content-type': (mime[path.extname(target)] ?? 'application/octet-stream') + (target.endsWith('.tgz') ? '' : '; charset=utf-8'), 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { response.writeHead(400); response.end('Invalid preview request.'); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.GALAXY_PREVIEW_PORT ?? 5179);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid GALAXY_PREVIEW_PORT');
  const server = createServer(productMiddleware());
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Galaxy product preview: http://127.0.0.1:${port}/\n`);
    if (!process.env.GALAXY_WEB_CONFIG_FILE) process.stdout.write('Public pages are available. Set GALAXY_WEB_CONFIG_FILE for API-backed product flows.\n');
  });
}
