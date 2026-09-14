import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { officialProxyCandidate } from '../deploy/caddy-candidate.mjs';

try {
  const [source, serverName, endpoint, port, output, ...extra] = process.argv.slice(2);
  if (extra.length || !source || !output || !isAbsolute(source) || !isAbsolute(output)) throw new Error();
  const bytes = await readFile(source);
  const candidate = officialProxyCandidate(JSON.parse(bytes), { serverName, endpoint, apiPort: Number(port) });
  const rendered = JSON.stringify(candidate, null, 2) + '\n';
  await writeFile(output, rendered, { flag: 'wx', mode: 0o600 });
  const sha = input => createHash('sha256').update(input).digest('hex');
  console.log(JSON.stringify({ event: 'official_proxy_candidate_prepared', sourceSha256: sha(bytes), candidateSha256: sha(rendered),
    endpoint, apiPort: Number(port), serverName, addedRoutes: 2, applied: false }));
} catch {
  console.error(JSON.stringify({ event: 'official_proxy_candidate_failed' }));process.exitCode = 1;
}
