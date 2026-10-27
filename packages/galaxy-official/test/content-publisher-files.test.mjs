import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFilesystemContentPublisher, loadContentPublisherConfiguration} from "../src/publishing/content-publisher-files.mjs";
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

test('prepare retains active content, stores only selected snapshot and media, and atomically activates the candidate', {timeout: 60000}, async t => {
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
  const snapshot=await json(join(artifact.directory,'cms-snapshot.json'));
  assert.deepEqual(snapshot.media.map(item=>item.filename),['selected.png']);
  assert.equal(snapshot.media[0].url,'/media/cms/selected-image/selected.png');
  assert.deepEqual(await readFile(join(artifact.directory,'media/selected.png')),selected);
  assert.equal(await exists(join(artifact.directory,'index.html')),false);
  assert.equal(await exists(join(artifact.directory,'app')),false);
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

test('invalid media and aborted preparation leave the previous pointer unchanged', {timeout: 60000}, async t => {
  const fixture = await filesFixture(t); if (!fixture) return;
  const {config, previous, priorDirectory} = fixture;
  const publisher = await createFilesystemContentPublisher(config);
  const bytes = Buffer.from('chosen image'); await writeFile(join(config.mediaDirectory, 'selected.png'), bytes);
  const input = imageSnapshot([mediaItem({size: bytes.length+1})]);
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
  const unsafeConfig = join(fixture.directory, 'unsafe-publisher.json');
  await writeFile(unsafeConfig, JSON.stringify({...config, mediaDirectory: '../media'}), {mode: 0o600});
  await assert.rejects(loadContentPublisherConfiguration(unsafeConfig), /Absolute publisher paths required/);
});

test('first publication can activate an absent pointer without fabricating a baseline publication',async t=>{
 const fixture=await filesFixture(t);if(!fixture)return;const {config}=fixture;await unlink(config.currentLink);
 const publisher=await createFilesystemContentPublisher(config);assert.equal(await publisher.current(),null);
 const artifact=await publisher.prepare({publicationId:randomUUID(),snapshot:publicSnapshot()});await publisher.activate(artifact);
 assert.equal((await publisher.current()).publicationId,artifact.publicationId);
});
