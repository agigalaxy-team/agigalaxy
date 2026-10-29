import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {contentSnapshotSchema} from '../../../../packages/galaxy-contracts/src/content-snapshot.mjs';
import {readSiteContent} from '../../../../apps/galaxy-site/src/lib/site-content.ts';

const [mode, path] = process.argv.slice(2);
if (mode === 'validate') {
  const values = JSON.parse(await readFile(path, 'utf8'));
  console.log(JSON.stringify(values.map(value => contentSnapshotSchema.safeParse(value).success)));
} else if (mode === 'read-files') {
  process.env.GALAXY_SITE_CONTENT_ROOT = path;
  const content = await readSiteContent();
  if (content.mode !== 'published') throw Error('Expected a prepared synthetic publication');
  const media = {};
  for (const name of await readdir(join(path, 'media'))) media[name] = (await readFile(join(path, 'media', name))).toString('base64');
  console.log(JSON.stringify({snapshot: content.snapshot, marker: JSON.parse(await readFile(join(path, 'cms-publication.json'), 'utf8')), media, current: {publicationId: content.publicationId}, files: await readdir(path)}));
} else {
  throw Error('Current site contract mode required');
}
