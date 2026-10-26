import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {ContentPublications, createContentPublicationWorker} from "../src/publishing/content-publications.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';
import {endpoint, operator, publicSnapshot, publicPage, deferred} from './operations-management-fixture.mjs';

const hasCode = code => error => error.code === code;

async function publicationsFixture(t) {
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
  const db = new PGlite(); let queue;
  t.after(async () => {await queue?.jobs.stop(); await db.close();});
  await migrate(db);
  const administrator=operator(),reader=operator('reader','publication-reader'),other=operator('administrator','another-operator');
  for(const actor of [administrator,reader,other])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
    VALUES($1,$2,'https://publication-fixture.invalid',$1,'合成发布检查人员',now(),now())`,[actor.operatorId,endpoint]);
  const businessAdmin=new BusinessAdminService({db,endpoint});
  const authority=await attachOperationsFixtureAuthority({businessAdmin,admin:administrator,reader,permissions:['cms.read']});
  authority.roles.set(other.operatorId,'administrator');
  queue = queueFixture(db); await queue.jobs.start();
  const publications = new ContentPublications({db, endpoint, jobs: queue.jobs,businessAdmin});
  return {db, queue, publications,businessAdmin,administrator,reader,other};
}

test('operator publication requests persist one immutable snapshot and queue job, atomically and with endpoint/role isolation', {timeout: 60000}, async t => {
  const {db, queue, publications,businessAdmin,administrator,reader,other} = await publicationsFixture(t);
  const id = randomUUID(), snapshot = publicSnapshot({pages: [publicPage()]});
  const initial = await publications.request(administrator, {operationId: id, snapshot});
  assert.equal(initial.publication.id, id);
  assert.equal(initial.publication.state, 'queued');
  assert.equal(initial.replayed, false);
  const replacement = new ContentPublications({db, endpoint, jobs: queue.jobs,businessAdmin});
  const replay = await replacement.request(administrator, {operationId: id, snapshot: structuredClone(snapshot)});
  assert.equal(replay.replayed, true);
  const jobs = (await db.query("SELECT data FROM galaxy_jobs.job WHERE name='content-publication'")).rows;
  assert.deepEqual(jobs.map(job => job.data), [{publicationId: id}], 'the durable queue holds a reference, not CMS bodies or a browser credential');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM site_publications_v1')).rows[0].n, 1);
  const changed = structuredClone(snapshot); changed.pages[0].title = 'Different content';
  await assert.rejects(replacement.request(administrator, {operationId: id, snapshot: changed}), hasCode('site_publication_operation_changed'));
  await assert.rejects(replacement.request(other, {operationId: id, snapshot}), hasCode('site_publication_operation_changed'));
  await assert.rejects(replacement.request(reader, {operationId: randomUUID(), snapshot}), hasCode('operations_permission_denied'));
  await assert.rejects(replacement.get({...administrator, endpoint: 'https://another.example.invalid'}, id), hasCode('business_admin_denied'));
  await assert.rejects(replacement.request({kind: 'official-account', endpoint}, {operationId: randomUUID(), snapshot}), hasCode('business_admin_denied'));
  assert.equal((await replacement.get(reader, id)).publication.id, id);
  const invalid = publicSnapshot({pages: [publicPage({path: '/assets/'})]});
  await assert.rejects(replacement.request(administrator, {operationId: randomUUID(), snapshot: invalid}), hasCode('invalid_site_publication'));
  const failedOperation = randomUUID();
  const enqueue=queue.jobs.enqueue;
  queue.jobs.enqueue=async(...args)=>{await enqueue(...args);throw Error('synthetic failure before transaction commit');};
  try{
    const failing = new ContentPublications({db, endpoint, jobs:queue.jobs,businessAdmin});
    await assert.rejects(failing.request(administrator, {operationId: failedOperation, snapshot}), /before transaction commit/);
  }finally{queue.jobs.enqueue=enqueue;}
  assert.equal((await db.query('SELECT count(*)::int AS n FROM site_publications_v1 WHERE id=$1', [failedOperation])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM galaxy_jobs.job WHERE name='content-publication' AND data->>'publicationId'=$1", [failedOperation])).rows[0].n, 0,
    'business and queue rows roll back together, even after enqueue succeeded');
  const second = await replacement.request(administrator, {operationId: randomUUID(), snapshot});
  const firstPage = await replacement.list(reader, {limit: 1});
  assert.equal(firstPage.items[0].id, second.publication.id);
  assert.ok(firstPage.nextAfter);
  const next = await replacement.list(reader, {limit: 1, after: firstPage.nextAfter});
  assert.deepEqual(next.items.map(item => item.id), [id]);
  assert.equal(next.nextAfter, null);
});

test('failed preparation keeps the valid website; retry reconciles an unknown activation acknowledgement without rebuilding', {timeout: 60000}, async t => {
  const {db, queue, publications,businessAdmin,administrator} = await publicationsFixture(t);
  let pointer = {publicationId: randomUUID(), siteVersion: 'existing-software'}, shouldFail = true;
  const original = {...pointer}, preparations = [], activations = [];
  const publisher = {
    current: async () => ({...pointer}),
    async prepare({publicationId, snapshot}) {
      preparations.push({publicationId, title: snapshot.pages[0].title});
      if (shouldFail) throw Error('synthetic renderer failure');
      return {publicationId, siteVersion: 'same-software', directory: 'isolated-candidate'};
    },
    async activate(artifact) {activations.push(artifact.publicationId); pointer = artifact;},
  };
  const worker = createContentPublicationWorker({db, endpoint, publicOrigin:'https://website.example.invalid', jobs: queue.jobs, publisher,businessAdmin});
  const operationId = randomUUID(), snapshot = publicSnapshot({pages: [publicPage({title: 'Published snapshot'})]});
  await publications.request(administrator, {operationId, snapshot});
  snapshot.pages[0].title = 'A later browser edit is not the requested version';
  await assert.rejects(worker.execute({publicationId: operationId}), hasCode('site_publication_failed'));
  assert.deepEqual(pointer, original);
  const failed = (await publications.get(administrator, operationId)).publication;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.retryable, true);
  assert.equal(activations.length, 0);
  shouldFail = false;
  assert.deepEqual(await worker.execute({publicationId: operationId}), {state: 'published'});
  assert.equal(pointer.publicationId, operationId);
  const completedJob=(await db.query('SELECT job_id FROM site_publications_v1 WHERE id=$1',[operationId])).rows[0].job_id;
  assert.equal((await publications.get(administrator, operationId)).publication.result.publicUrl,'https://website.example.invalid/');
  await assert.rejects(queue.jobs.cancel('content-publication',completedJob),hasCode('site_publication_not_cancellable'));
  assert.deepEqual(preparations.map(item => item.title), ['Published snapshot', 'Published snapshot']);
  await worker.execute({publicationId: operationId});
  assert.equal(activations.length, 1, 'completed job replay does not activate again');
  const uncertainId = randomUUID();
  await publications.request(administrator, {operationId: uncertainId, snapshot: publicSnapshot({pages: [publicPage()]})});
  const normalActivate = publisher.activate.bind(publisher);
  publisher.activate = async artifact => {await normalActivate(artifact); throw Error('synthetic lost activation acknowledgement');};
  await assert.rejects(worker.execute({publicationId: uncertainId}), hasCode('site_publication_failed'));
  assert.equal(pointer.publicationId, uncertainId, 'the lost acknowledgement happened after the actual switch');
  const uncertainJob=(await db.query('SELECT job_id FROM site_publications_v1 WHERE id=$1',[uncertainId])).rows[0].job_id;
  await assert.rejects(queue.jobs.cancel('content-publication',uncertainJob),hasCode('site_publication_not_cancellable'));
  const before = preparations.length;
  publisher.activate = normalActivate;
  assert.deepEqual(await worker.execute({publicationId: uncertainId}), {state: 'published'});
  assert.equal(preparations.length, before, 'the durable marker is reconciled before any rebuild or second switch');
  assert.equal((await publications.get(administrator, uncertainId)).publication.state, 'published');
});

test('a delayed old publication and a cancelled task cannot replace newer live content', {timeout: 60000}, async t => {
  const {db, queue, publications,businessAdmin,administrator} = await publicationsFixture(t);
  const oldId = randomUUID(), newId = randomUUID(), entered = deferred(), release = deferred(), activated = [];
  let pointer = {publicationId: randomUUID(), siteVersion: 'baseline'};
  const publisher = {
    current: async () => ({...pointer}),
    async prepare({publicationId}) {
      if (publicationId === oldId) {entered.resolve(); await release.promise;}
      return {publicationId, siteVersion: 'same-software', directory: 'isolated-' + publicationId};
    },
    async activate(artifact) {activated.push(artifact.publicationId); pointer = artifact;},
  };
  const worker = createContentPublicationWorker({db, endpoint, jobs: queue.jobs, publisher,businessAdmin});
  await publications.request(administrator, {operationId: oldId, snapshot: publicSnapshot({title: 'Older'})});
  const delayed = worker.execute({publicationId: oldId});
  try {
    await entered.promise;
    await publications.request(administrator, {operationId: newId, snapshot: publicSnapshot({title: 'Newer'})});
    assert.deepEqual(await worker.execute({publicationId: newId}), {state: 'published'});
  } finally {release.resolve();}
  assert.deepEqual(await delayed, {state: 'superseded'});
  assert.equal(pointer.publicationId, newId);
  assert.deepEqual(activated, [newId]);
  const old = (await publications.get(administrator, oldId)).publication;
  assert.equal(old.error.code, 'site_publication_superseded');
  assert.equal(old.error.retryable, false);
  assert.deepEqual(await worker.execute({publicationId: oldId}), {state: 'failed'});
  const cancelledId = randomUUID();
  await publications.request(administrator, {operationId: cancelledId, snapshot: publicSnapshot()});
  const jobId = (await db.query('SELECT job_id FROM site_publications_v1 WHERE id=$1', [cancelledId])).rows[0].job_id;
  await queue.jobs.cancel('content-publication', jobId);
  assert.deepEqual(await worker.execute({publicationId: cancelledId}), {state: 'failed'});
  assert.equal(pointer.publicationId, newId);
  assert.equal((await publications.get(administrator, cancelledId)).publication.error.code, 'site_publication_cancelled');
});
