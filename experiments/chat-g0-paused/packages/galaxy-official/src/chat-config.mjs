import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ProsodyChatTransport } from './infrastructure/prosody-chat.mjs';

export const chatConfigurationSchema = z.strictObject({ version: z.literal(1), service: z.string().max(200),
  domain: z.string().min(1).max(253), roomsDomain: z.string().min(1).max(253),
  componentKeyFile: z.string().refine(isAbsolute), timeoutMs: z.number().int().min(500).max(15000).default(5000) });

export async function loadChatTransport(path) {
  if (path === undefined) return null;
  async function read(path, max) {
    if (!isAbsolute(path)) throw new Error('Invalid chat configuration path');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('Invalid chat configuration file');
    return readFile(path, 'utf8');
  }
  try {
    const { componentKeyFile, version: _version, ...configuration } = chatConfigurationSchema.parse(JSON.parse(await read(path, 16384)));
    return new ProsodyChatTransport({ ...configuration, password: (await read(componentKeyFile, 4096)).trim() });
  } catch { throw new Error('Invalid private chat configuration'); }
}
