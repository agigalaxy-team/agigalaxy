import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';

// Public operator metadata only. The endpoint, keys and advertised capabilities
// are supplied by the running service, never overridden by this document.
const profileSchema = z.discriminatedUnion('networkType', [
  z.object({ networkType: z.literal('official'), displayName: z.string().min(1).max(240).optional(),
    serviceVersion: z.literal('0.1.0').optional() }).strict(),
  z.object({ networkType: z.literal('hub'), displayName: z.string().min(1).max(240),
    serviceVersion: z.string().min(1).max(80), hub: z.object({ profile: z.literal('galaxy-hub/1'),
      charter: z.string().max(500), scope: z.string().min(1).max(1500),
      exit: z.string().min(1).max(1500), export: z.string().min(1).max(1500) }).strict() }).strict(),
]);
export function parseNetworkProfile(input) { return profileSchema.parse(input); }
export async function loadNetworkProfile(path) {
  if (path === undefined) return { networkType: 'official' };
  const info = await stat(path);
  if (!info.isFile() || info.size > 16384) throw new Error('Invalid network profile file.');
  return parseNetworkProfile(JSON.parse(await readFile(path, 'utf8')));
}
