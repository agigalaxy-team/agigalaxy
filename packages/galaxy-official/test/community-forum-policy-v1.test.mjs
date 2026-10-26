import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,unlink,rmdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {defaultForumPolicy,forumPolicyHash,forumPolicySchema,loadForumPolicy} from "../src/community/community-forum-policy-v1.mjs";
import {cleanupProductV2Retention} from '../src/operations/lifecycle-retention-v2.mjs';
import {recordRuntimeConfig,runtimeConfigSnapshot} from '../src/operations/runtime-config-audit.mjs';

test('strict default/configured loader feeds actual API and retention runtime observations with identical policy hash',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-forum-policy-')),path=join(directory,'forum.json'),policy={...defaultForumPolicy,maxReportEvents:4,maxAppeals:3,dailyUsageDays:1,auditDays:1};
 try{
  const defaultApi=await loadForumPolicy(),defaultWorker=await loadForumPolicy();assert.deepEqual(defaultApi,defaultWorker);assert.equal(forumPolicyHash(defaultApi),'9efaa3fb2a4a80438642e8b4384f09e03099e8c2d0820fda52c37df0ac83fdd7');
  await writeFile(path,JSON.stringify(policy));const apiPolicy=await loadForumPolicy(path),workerPolicy=await loadForumPolicy(path),f=await communityForumFixture({policy:apiPolicy});
  try{
   await f.login(f.owner,'policy-author');assert.equal((await f.write(f.owner,'create-post',await f.post())).status,200);
   const apiView=await f.ok('/v2/community/quotas'),cleanup=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:workerPolicy,endpoint:f.owner.access.endpoint});assert.equal(apiView.policyHash,forumPolicyHash(workerPolicy));assert.equal(cleanup.removed.forumPolicyHash,apiView.policyHash);
   for(const component of ['api','worker'])await recordRuntimeConfig(f.db,{id:randomUUID(),endpoint:f.owner.access.endpoint,component,operatorRef:'isolated-forum-policy',snapshot:runtimeConfigSnapshot({forumPolicyHash:forumPolicyHash(component==='api'?apiPolicy:workerPolicy)})},{now:()=>f.clock.now});
   const observations=(await f.db.query('SELECT component,payload FROM runtime_config_events ORDER BY sequence')).rows;assert.equal(observations.length,2);assert.ok(observations.every(row=>row.payload.snapshot.forumPolicyHash===f.forum.policyHash));
   // The entry files pass the exact loaded object, not a second policy read.
   for(const entry of ['server','worker']){const source=await readFile(new URL(`../src/${entry}.mjs`,import.meta.url),'utf8');assert.match(source,/loadForumPolicy\(process\.env\.GALAXY_FORUM_POLICY_FILE\)/);assert.match(source,/forumPolicyHash:forumPolicyHash\(forumPolicy\)/);}
  }finally{await f.close();}
  await writeFile(path,JSON.stringify({...policy,unrecognized:true}));await assert.rejects(loadForumPolicy(path));
  await assert.rejects(loadForumPolicy('relative-forum.json'));assert.equal(forumPolicySchema.safeParse({...policy,maxAppeals:4}).success,false);
 }finally{await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(directory);}
});

test('forum UTF-8 payload accepts its explicit bounded envelope while legacy nonforum request parser retains32768 bytes',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'wire-author');const p=await f.post({body:'🙂'.repeat(8000)}),input=await f.authorize(f.owner,'create-post',p);assert.ok(Buffer.byteLength(JSON.stringify(input))>32768);assert.ok(Buffer.byteLength(input.payloadJson)<=49152);
  const written=await f.request('/v2/community/posts',{input});assert.equal(written.status,200,JSON.stringify(written.body));assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).payload.body,p.body);
  assert.equal((await f.request('/v1/consents',{input:{signedIntent:'A'.repeat(40000)}})).status,413);
  const oversized=await f.request('/v2/community/posts',{input:{signedIntent:input.signedIntent,payloadJson:'A'.repeat(49153)}});assert.equal(oversized.status,413);
  assert.equal((await f.request('/v2/community/posts',{input:{signedIntent:input.signedIntent,payloadJson:'A'.repeat(130000)}})).status,413);
 }finally{await f.close();}
});
