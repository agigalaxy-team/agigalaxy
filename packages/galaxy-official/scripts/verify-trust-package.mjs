import { readFile, stat } from 'node:fs/promises';
import { verifyTrustPackage } from '../src/trust-package.mjs';
const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Usage: node verify-trust-package.mjs <local-package.json>');
if ((await stat(path)).size > 4500000) throw new Error('Local package exceeds 4.5 MB limit.');
try {
  const result = await verifyTrustPackage(await readFile(path, 'utf8'));
  const { summary:_summary, claims, ...report } = result;
  process.stdout.write(JSON.stringify({ ...report, selectedClaimCount: claims.length, networkRequests: 0, businessWrites: 0 }, null, 2) + '\n');
} catch (error) { process.stderr.write('Trust package verification failed: ' + error.message + '\n'); process.exitCode = 1; }
