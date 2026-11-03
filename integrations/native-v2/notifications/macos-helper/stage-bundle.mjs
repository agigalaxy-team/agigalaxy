import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
};

/** Stage a prebuilt app as part of a new Native candidate.
 * This copies every regular bundle file without rewriting its bytes. The
 * signature resource is evidence of a signature container only; this helper
 * does not verify signer identity, notarization, or runtime notification use.
 * Source and destination must be separate absolute paths. The caller adds the
 * returned relative file hashes to its existing release manifest.
 */
export async function stageMacOSNotificationBundle({ source, destination } = {}) {
  if (typeof source !== 'string' || !isAbsolute(source) || basename(resolve(source)) !== 'GalaxyNotifications.app'
      || typeof destination !== 'string' || !isAbsolute(destination)) throw Error('macos_helper_absolute_app_and_candidate_required');
  const app = resolve(source), root = resolve(destination);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('macos_helper_candidate_invalid');
  const target = join(root, 'notifications', 'GalaxyNotifications.app');
  if (inside(app, root) || inside(root, app)) throw Error('macos_helper_source_destination_overlap');
  const sourceInfo = await lstat(app);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw Error('macos_helper_app_invalid');
  for (const name of ['Contents/Info.plist', 'Contents/MacOS/GalaxyNotifications']) {
    const info = await lstat(join(app, ...name.split('/')));
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw Error('macos_helper_bundle_incomplete');
  }
  // Reserve the final app exclusively; a failed build never replaces a
  // previously staged or installed bundle.
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target);
  const artifacts = {};
  async function copy(directory, out, prefix) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const src = join(directory, name), dst = join(out, name), info = await lstat(src);
      if (info.isSymbolicLink()) throw Error('macos_helper_symlink_unsupported');
      if (info.isDirectory()) { await mkdir(dst); await copy(src, dst, prefix + '/' + name); continue; }
      if (!info.isFile()) throw Error('macos_helper_nonregular_resource');
      const bytes = await readFile(src), rel = prefix + '/' + name;
      // Preserve the helper entry's executable bit even on a cross-build host.
      const mode = rel.endsWith('/Contents/MacOS/GalaxyNotifications') ? 0o755 : info.mode & 0o777;
      await writeFile(dst, bytes, { flag: 'wx', mode });
      artifacts[rel] = digest(bytes);
    }
  }
  await copy(app, target, 'notifications/GalaxyNotifications.app');
  return { app: 'notifications/GalaxyNotifications.app', command: 'notifications/GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications', artifacts,
    signature: Object.hasOwn(artifacts, 'notifications/GalaxyNotifications.app/Contents/_CodeSignature/CodeResources') ? 'resource-present-unverified' : 'not-provided',
    notarization: 'unverified', platformAcceptance: 'pending' };
}
