import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeLocalGalaxyId} from '../src/application/local-operations.mjs';
import {createLocalWorkHistory} from '../src/work-history/index.mjs';

async function fixture(t,{initialize=true}={}) {
  const directory=await mkdtemp(join(tmpdir(),'galaxy-local-work-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const local=initialize?await initializeLocalGalaxyId(directory):null;
  const history=createLocalWorkHistory({dataDirectory:directory});
  return {directory,history,id:local?.identity.id};
}
const observation = extra => ({host:'opencode',sessionId:'work-session',sourceId:'tool-call',revision:2,kind:'tool',
  source:{kind:'tool-report',messageId:'message',partId:'part'},details:{tool:'test',status:'completed',workOutcome:'unknown'},...extra});

test('local recording does not create an identity, account or model requirement',async t=>{
  const {directory,history}=await fixture(t,{initialize:false});
  assert.deepEqual((await history.list()).items,[]);
  await assert.rejects(history.observe(observation()),{code:'local_work_identity_required'});
  await assert.rejects(stat(join(directory,'galaxy-id.json')),{code:'ENOENT'});
});

test('replay is idempotent, late revisions remain sourced, and tool completion is not whole-work success',async t=>{
  const {directory,history}=await fixture(t);
  const first=await history.observe(observation());
  assert.equal((await history.observe(observation())).duplicate,true);
  const late=await history.observe(observation({revision:1,details:{tool:'test',status:'running',workOutcome:'unknown'}}));
  assert.equal(late.late,true);
  const restarted=createLocalWorkHistory({dataDirectory:directory});
  assert.equal((await restarted.observe(observation())).duplicate,true);
  const detail=await restarted.get({workId:first.workId});
  assert.equal(detail.observations.length,2);
  assert.equal(detail.work.outcome,'unknown');
  assert.equal(detail.work.pending,true);
  assert.deepEqual(detail.observations.map(x=>x.revision),[2,1]);
  assert.equal(detail.observations[1].superseded,true);
  assert.equal(detail.observations[1].latestRevision,2);
});

test('environment versions contain actual selected facts and preserve earlier associations',async t=>{
  const {history}=await fixture(t);
  const a=await history.observeEnvironment({host:'opencode',sessionId:'work-session',facts:{host:'opencode',selectedModel:'local/a',tools:['b','a'],apiKey:'do-not-retain'}});
  const unchanged=await history.observeEnvironment({host:'opencode',sessionId:'work-session',facts:{host:'opencode',selectedModel:'local/a',tools:['a','b']}});
  assert.equal(unchanged.id,a.id);
  const first=await history.observe(observation());
  const b=await history.observeEnvironment({host:'opencode',sessionId:'work-session',facts:{host:'opencode',selectedModel:'local/b'}});
  await history.observe(observation({sourceId:'second',revision:0}));
  const detail=await history.get({workId:first.workId});
  assert.equal(b.version,2);
  assert.equal(detail.observations[0].environmentId,a.id);
  assert.equal(detail.observations[1].environmentId,b.id);
  assert.equal(Object.hasOwn(detail.environments[0].facts,'apiKey'),false);
  assert.ok(detail.environments[0].exclusions.some(item=>item.kind==='credential'));
});

test('credentials are excluded from observations and model summaries without retaining removed values',async t=>{
  const {history}=await fixture(t);
  const first=await history.recordNote({host:'opencode',sessionId:'work-session',text:'The service password=fixture-private-input was changed.'});
  await history.observe(observation({details:{tool:'fixture',apiKey:'fixture-private-tool-input'}}));
  const pending=await history.pending({workId:first.workId});
  await history.submitSummary({workId:first.workId,expectedRevision:0,throughSequence:pending.throughSequence,
    sourceObservationIds:pending.observations.map(item=>item.id),title:'A local change',summary:'The participant reports password=fixture-private-summary.'});
  const exported=await history.exportWork({workId:first.workId}),encoded=JSON.stringify(exported);
  for(const secret of ['fixture-private-input','fixture-private-tool-input','fixture-private-summary'])assert.equal(encoded.includes(secret),false);
  assert.ok(exported.observations.every(item=>item.exclusions.some(exclusion=>exclusion.kind==='credential')));
  assert.notEqual(exported.observations[0].content.retained,'full');
  assert.ok(exported.summaries[0].exclusions.length);
});

test('AI summaries require real source coverage and keep revision/model-report semantics',async t=>{
  const {history}=await fixture(t);
  const first=await history.observe(observation());
  await history.recordNote({host:'opencode',sessionId:'work-session',sourceId:'note',text:'The result is incomplete.'});
  const pending=await history.pending({workId:first.workId});
  const input={workId:first.workId,expectedRevision:0,throughSequence:pending.throughSequence,
    sourceObservationIds:pending.observations.map(x=>x.id),title:'A partial result',summary:'The tool completed, but the participant reports an incomplete result.',outcome:'partial',model:'test/user-model'};
  await assert.rejects(history.submitSummary({...input,sourceObservationIds:[input.sourceObservationIds[0]]}),{code:'local_work_summary_sources_invalid'});
  await history.submitSummary(input);
  assert.equal((await history.pending({workId:first.workId})).observations.length,0);
  assert.equal((await history.get({workId:first.workId})).summaries[0].sourceKind,'user-model');
  await assert.rejects(history.submitSummary(input),{code:'local_work_summary_revision_conflict'});
  await history.recordNote({host:'opencode',sessionId:'work-session',sourceId:'later',text:'A later correction.'});
  assert.equal((await history.pending({workId:first.workId})).observations.length,1);
});

test('a trusted current identity switch cannot read, export, delete or sign another local history',async t=>{
  const {directory,id}=await fixture(t);let current=id;
  const history=createLocalWorkHistory({dataDirectory:directory,getIdentity:async()=>({id:current})});
  const capture=await history.beginCapture({host:'opencode',sessionId:'work-session'});
  const first=await history.observe(observation());
  current='another-controlled-id';
  assert.deepEqual((await history.list()).items,[]);
  assert.equal(await history.get({workId:first.workId}),null);
  await assert.rejects(history.observe(observation({galaxyId:id})),{code:'local_work_identity_changed'});
  await assert.rejects(history.exportWork({workId:first.workId}),{code:'local_work_unavailable'});
  await assert.rejects(history.deleteWork({workId:first.workId}),{code:'local_work_unavailable'});
  const changed=await history.beginCapture({host:'opencode',sessionId:'work-session'});
  assert.equal(changed.resumed,false);
  assert.notEqual(changed.galaxyId,capture.galaxyId);
  current=id;
  const exported=await history.exportWork({workId:first.workId});
  assert.equal(exported.completeConversation,false);
  assert.equal(exported.observations.length,1);
  await history.deleteWork({workId:first.workId});
  assert.deepEqual((await history.list()).items,[]);
});
