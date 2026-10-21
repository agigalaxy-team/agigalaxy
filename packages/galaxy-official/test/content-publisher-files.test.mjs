import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFilesystemContentPublisher, loadContentPublisherConfiguration} from '../src/content-publisher-files.mjs';
import {adminOrigin, endpoint, publicPage, publicSnapshot, temporaryDirectory} from './operations-management-fixture.mjs';

const renderer = fileURLToPath(new URL('./content-publisher-renderer-fixture.mjs', import.meta.url));
const marker = 'cms-publication.json';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => lstat(path).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});

async function filesFixture(t) {
  const directory = await temporaryDirectory(t, 'galaxy-content-publisher-');
  const baseDirectory = join(directory, 'baseline'), releaseDirectory = join(directory, 'releases');
  const mediaDirectory = join(directory, 'cms-media'), currentLink = join(directory, 'current');
  for (const path of [baseDirectory, releaseDirectory, mediaDirectory]) await mkdir(path);
  await writeFile(join(baseDirectory, 'release.json'), JSON.stringify({version: 'fixture-software-release'}));
  await writeFile(join(baseDirectory, 'index.html'), 'Authored interactive homepage');
  await mkdir(join(baseDirectory, 'app')); await writeFile(join(baseDirectory, 'app/index.html'), 'Existing business app');
  await mkdir(join(baseDirectory, 'downloads'));
  await writeFile(join(baseDirectory, 'downloads/release.jws'), 'Existing signed release');
  const priorDirectory = join(releaseDirectory, 'previous'), previous = {version: 1, publicationId: randomUUID(), siteVersion: 'fixture-prior-software'};
  await mkdir(priorDirectory); await writeFile(join(priorDirectory, marker), JSON.stringify(previous));
  await writeFile(join(priorDirectory, 'index.html'), 'Current valid website');
  try {
    await symlink(relative(dirname(currentLink), priorDirectory), currentLink, 'dir');
  } catch (error) {
    if (['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) {t.skip('This environment cannot create the symbolic link used by the production publisher'); return null;}
    throw error;
  }
  const config = {version: 1, endpoint, publicOrigin:'https://website.example.invalid', adminOrigin, baseDirectory, releaseDirectory, currentLink,
    mediaDirectory, renderer, python: process.execPath};
  return {directory, config, previous, priorDirectory};
}

function mediaItem({id = 'selected-image', filename = 'selected.png', origin = adminOrigin, size = 12} = {}) {
  return {id, filename, url: origin + '/api/media/file/' + encodeURIComponent(filename),
    alt: '合成配图', mimeType: 'image/png', filesize: size, width: 1, height: 1, credit: '合成来源'};
}

function imageSnapshot(media, title = 'Published help') {
  return publicSnapshot({title, pages: [publicPage({blocks: [{blockType: 'image', mediaId: media[0].id, caption: '配图'}]})], media});
}

test('prepare retains the active site, passes only referenced files privately, and activates the exact recorded candidate', {timeout: 60000}, async t => {
  const fixture = await filesFixture(t); if (!fixture) return;
  const {config, previous, priorDirectory} = fixture;
  const configFile = join(fixture.directory, 'publisher.json');
  await writeFile(configFile, JSON.stringify(config), {mode: 0o600});
  assert.deepEqual(await loadContentPublisherConfiguration(configFile), config);
  const publisher = await createFilesystemContentPublisher(config);
  assert.deepEqual(await publisher.current(), previous);
  const selected = Buffer.from('chosen image');
  await writeFile(join(config.mediaDirectory, 'selected.png'), selected);
  // This metadata is intentionally not referenced and has no local file. A
  // publication must neither read it nor copy it into a public candidate.
  const selectedItem = mediaItem({size: selected.length});
  const unreferenced = mediaItem({id: 'unused-image', filename: 'not-selected.png'});
  const publicationId = randomUUID();
  const artifact = await publisher.prepare({publicationId, snapshot: imageSnapshot([selectedItem, unreferenced])});
  assert.equal(await realpath(config.currentLink), await realpath(priorDirectory));
  assert.equal(await readFile(join(config.currentLink, 'index.html'), 'utf8'), 'Current valid website');
  assert.equal(artifact.publicationId, publicationId);
  assert.equal(artifact.siteVersion, 'fixture-software-release');
  assert.deepEqual(await json(join(artifact.directory, 'renderer-invocation.json')), {
    selectedFiles: ['selected.png'], inputInsideCandidate: false, mediaInsideCandidate: false,
  });
  assert.equal(await exists(join(artifact.directory, '.cms-selected-media')), false);
  assert.equal(await exists(join(artifact.directory, '.cms-snapshot.json')), false);
  assert.equal((await readdir(config.releaseDirectory)).some(name => name.startsWith('.cms-input-')), false,
    'temporary snapshot and media are removed after rendering');
  assert.equal(await readFile(join(artifact.directory, 'app/index.html'), 'utf8'), 'Existing business app');
  assert.equal(await readFile(join(artifact.directory, 'downloads/release.jws'), 'utf8'), 'Existing signed release');
  assert.deepEqual(await publisher.current(), previous);
  try{await publisher.activate(artifact);}catch(error){
    if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows cannot atomically replace a directory symbolic link; run activation on the Linux deployment host');return;}
    throw error;
  }
  assert.equal(await realpath(config.currentLink), await realpath(artifact.directory));
  assert.equal((await publisher.current()).publicationId, publicationId);
  assert.equal(await readFile(join(config.baseDirectory, 'index.html'), 'utf8'), 'Authored interactive homepage');
  await assert.rejects(publisher.activate({...artifact, publicationId: randomUUID()}), /reference changed/);
  const outside = join(fixture.directory, 'outside-candidate');
  await mkdir(outside); await writeFile(join(outside, marker), JSON.stringify({publicationId}));
  await assert.rejects(publisher.activate({...artifact, directory: outside}), /escaped release directory/);
  assert.equal((await publisher.current()).publicationId, publicationId);
});

test('failed rendering and aborted preparation leave the previous pointer and no private staging data', {timeout: 60000}, async t => {
  const fixture = await filesFixture(t); if (!fixture) return;
  const {config, previous, priorDirectory} = fixture;
  const publisher = await createFilesystemContentPublisher(config);
  const bytes = Buffer.from('chosen image'); await writeFile(join(config.mediaDirectory, 'selected.png'), bytes);
  const input = imageSnapshot([mediaItem({size: bytes.length})], '__fixture_renderer_failure__');
  await assert.rejects(publisher.prepare({publicationId: randomUUID(), snapshot: input}));
  assert.deepEqual(await publisher.current(), previous);
  assert.equal(await realpath(config.currentLink), await realpath(priorDirectory));
  assert.equal((await readdir(config.releaseDirectory)).some(name => name.startsWith('.cms-input-')), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(publisher.prepare({publicationId: randomUUID(), snapshot: publicSnapshot(), signal: controller.signal}));
  assert.deepEqual(await publisher.current(), previous);
  assert.equal((await readdir(config.releaseDirectory)).some(name => name.startsWith('.website-next-')), false);
  assert.equal(await readFile(join(priorDirectory, 'index.html'), 'utf8'), 'Current valid website');
});

test('source paths, media origin and changed files cannot escape or broaden publication', {timeout: 60000}, async t => {
  const fixture = await filesFixture(t); if (!fixture) return;
  const {config, previous} = fixture;
  await assert.rejects(createFilesystemContentPublisher({...config, releaseDirectory: config.baseDirectory}), /Separate publisher source and output/);
  const publisher = await createFilesystemContentPublisher(config);
  const outside = join(fixture.directory, 'private.png'); await writeFile(outside, 'outside private file');
  const selected = mediaItem({filename: '../private.png', size: 20});
  await assert.rejects(publisher.prepare({publicationId: randomUUID(), snapshot: imageSnapshot([selected])}));
  const normal = Buffer.from('chosen image'); await writeFile(join(config.mediaDirectory, 'selected.png'), normal);
  const foreign = mediaItem({origin: 'https://unconfigured.example.invalid', size: normal.length});
  await assert.rejects(publisher.prepare({publicationId: randomUUID(), snapshot: imageSnapshot([foreign])}), /media origin changed/);
  const changed = mediaItem({size: normal.length + 1});
  await assert.rejects(publisher.prepare({publicationId: randomUUID(), snapshot: imageSnapshot([changed])}), /no longer matches/);
  await symlink(relative(config.mediaDirectory, outside), join(config.mediaDirectory, 'linked.png'), 'file');
  const linked = mediaItem({filename: 'linked.png', size: 20});
  await assert.rejects(publisher.prepare({publicationId: randomUUID(), snapshot: imageSnapshot([linked])}), /regular file required/);
  assert.deepEqual(await publisher.current(), previous);
  assert.equal((await readdir(config.releaseDirectory)).some(name => name.startsWith('.cms-input-')), false);
  const linkedBuild = join(fixture.directory, 'linked-build');
  await cp(config.baseDirectory, linkedBuild, {recursive: true});
  await symlink(relative(linkedBuild, outside), join(linkedBuild, 'unexpected-link'), 'file');
  const invalidBuild = await createFilesystemContentPublisher({...config, baseDirectory: linkedBuild});
  await assert.rejects(invalidBuild.prepare({publicationId: randomUUID(), snapshot: publicSnapshot()}), /must not contain symbolic links/);
  assert.deepEqual(await publisher.current(), previous);
  const unsafeConfig = join(fixture.directory, 'unsafe-publisher.json');
  await writeFile(unsafeConfig, JSON.stringify({...config, renderer: '../renderer.mjs'}), {mode: 0o600});
  await assert.rejects(loadContentPublisherConfiguration(unsafeConfig), /Absolute publisher paths required/);
});
