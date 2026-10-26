import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { digest } from "../shared/digest.mjs";
import { ProsodyChatTransport } from "../infrastructure/prosody-chat.mjs";
const schema = z.strictObject({ version: z.literal(1), service: z.string().min(1), domain: z.string().min(1), roomsDomain: z.string().min(1), secretFile: z.string().min(1) });
export async function loadChatTransport(path) {
  if (!path) return { transport: null, configurationHash: null };
  if (!isAbsolute(path)) throw new Error('Absolute chat configuration path required.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid chat configuration.');
  const config = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (!isAbsolute(config.secretFile)) throw new Error('Absolute component credential file required.');
  const secretInfo = await lstat(config.secretFile);
  if (!secretInfo.isFile() || secretInfo.isSymbolicLink() || secretInfo.size > 4096 || process.platform !== 'win32' && secretInfo.mode & 0o077)
    throw new Error('Unsafe component credential file.');
  const secret = (await readFile(config.secretFile, 'utf8')).trim();
  return { transport: new ProsodyChatTransport({ ...config, secret }), configurationHash: digest(JSON.stringify(config)) };
}
