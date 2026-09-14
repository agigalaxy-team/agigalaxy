import { officialRoutes } from './caddy-routes.mjs';

// Input is Caddy's adapted current configuration, not a reconstructed website.
// Keep listeners, existing routes, TLS and admin settings exactly as supplied.
export function officialProxyCandidate(base, { serverName, endpoint, apiPort }) {
  const routes = officialRoutes({ endpoint, apiPort });
  const hostname = new URL(endpoint).hostname;
  const server = base?.apps?.http?.servers?.[serverName];
  if (!server || !Array.isArray(server.routes) || !Array.isArray(server.listen)
    || !server.listen.some(value => value === ':443' || value.endsWith(':443'))
    || server.automatic_https?.disable || server.automatic_https?.disable_certificates
    || server.automatic_https?.skip?.includes(hostname)
    || server.automatic_https?.skip_certificates?.includes(hostname))
    throw new Error('Explicit HTTPS server with certificate automation required');
  function occupied(value) {
    if (Array.isArray(value)) return value.some(occupied);
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value.host) && value.host.some(host => {
      const name = host.toLowerCase();
      return name === hostname || name.startsWith('*.') && hostname.endsWith(name.slice(1));
    })) return true;
    return Object.values(value).some(occupied);
  }
  if (occupied(base.apps.http.servers)) throw new Error('Official host is already owned by existing routes');
  const candidate = structuredClone(base);
  candidate.apps.http.servers[serverName].routes.unshift(...routes);
  return candidate;
}
