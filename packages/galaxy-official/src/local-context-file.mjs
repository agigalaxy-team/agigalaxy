import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { selectedTextSchema } from './shared/context-schema.mjs';

export const CONTEXT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const credentialName = /^(?:\.env(?:\..*)?|(?:id_(?:rsa|dsa|ecdsa|ed25519))(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|key|p12|pfx|jks|keystore)$/i;
function localPath(path) {
  if (typeof path !== 'string' || path.length > 2048 || !isAbsolute(path)
    // eslint-disable-next-line no-control-regex -- Local paths must not contain control bytes.
    || /^[\\/]{2}/.test(path) || /[\u0000-\u001f\u007f]/.test(path)
    || process.platform === 'win32' && !/^[a-z]:[\\/][^:]*$/i.test(path))
    throw new Error('Choose an absolute local file path, not a URL, network share or device.');
  if (credentialName.test(basename(path)) || path.split(/[\\/]/).some(part => ['.ssh','.aws','.gnupg'].includes(part.toLowerCase())))
    throw new Error('Credential files cannot be selected as Context materials.');
}

// Explicit host selection only. No directory scan, persistent path or remote fetch.
export async function readLocalContextExcerpt({ path, startLine, endLine }) {
  localPath(path);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine >= 200)
    throw new Error('Choose an inclusive line range of 1 to 200 lines.');
  const entry = await lstat(path);
  if (!entry.isFile()) throw new Error('Choose a regular text file; directories and symbolic links are not supported.');
  const resolved = await realpath(path); localPath(resolved);
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > CONTEXT_FILE_MAX_BYTES) throw new Error('Choose a regular text file of at most 8 MiB.');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || ['size','mtimeMs','ctimeMs'].some(key => before[key] !== after[key]))
      throw new Error('The selected file changed while reading; preview it again.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw new Error('Choose a UTF-8 text or log file.'); }
    // eslint-disable-next-line no-control-regex -- Keep tabs/newlines, reject binary and terminal control bytes.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text))
      throw new Error('Binary or terminal-control content is not supported; choose plain text.');
    const lines = text ? text.split(/\r\n|\r|\n/) : [];
    if (lines.at(-1) === '') lines.pop();
    if (endLine > lines.length) throw new Error(`The selected file has ${lines.length} lines; choose a range within it.`);
    const content = lines.slice(startLine - 1, endLine).join('\n');
    if (!content.length || content.length > 4000) throw new Error('Choose a nonempty excerpt of at most 4000 characters.');
    selectedTextSchema.parse(content);
    return { path: resolved, startLine, endLine, totalLines: lines.length, byteLength: length,
      capturedAt: new Date().toISOString(), sha256: createHash('sha256').update(content).digest('hex'),
      label: `${basename(resolved).slice(0, 100)}:${startLine}-${endLine}`, content };
  } finally { await handle.close(); }
}
