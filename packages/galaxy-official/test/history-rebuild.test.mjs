import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { createHistoryRebuild } from '../src/domain/history-rebuild.mjs';
import { historyContentHash,compareHistoryRebuilds } from '../src/shared/history-rebuild.mjs';
import { createHistoryClient } from '../src/history-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';

const endpoint='https://official.example.org';
function fixture(){
  const caseId=randomUUID(),proofId=randomUUID(),resultId=randomUUID();
  const rows=[{id:caseId,kind:'case',version:1},{id:randomUUID(),kind:'attempt',version:2},{id:resultId,kind:'result',version:3}];
  const item={caseId,sourceVersion:3,title:'Compiler',summary:'Synthetic',state:'resolution-proposed',attempts:[],
    results:[{id:resultId,outcome:'failed',summary:'Failed'}],corrections:[],reviews:[],capabilityVerified:false,matchReasons:['case ID order'],
    proofs:[{proofId,status:'active',signed:'unchanged synthetic assertion',caseContext:{checkedAt:1000,status:'has-corrections',sourceVersion:3}}]};
  return {item,rows,receipt:()=>createHistoryRebuild(item,rows,{endpoint,view:'authorized'})};
}
test('rebuild fingerprints ignore observation clocks and object order, retain fact changes, and do not mutate sources',()=>{
  const f=fixture(),before={rows:structuredClone(f.rows)},one=f.receipt();
  f.item.proofs[0].caseContext.checkedAt=1001;
  assert.equal(f.receipt().contentHash,one.contentHash);
  assert.equal(historyContentHash(Object.fromEntries(Object.entries(f.item).reverse())),one.contentHash);
  assert.equal(compareHistoryRebuilds(one,f.receipt()).state,'unchanged');
  f.item.results[0].summary='Corrected report';
  assert.equal(compareHistoryRebuilds(one,f.receipt()).state,'changed');
  const source=JSON.stringify(f.rows);
  assert.throws(()=>createHistoryRebuild(f.item,f.rows.slice(1),{endpoint,view:'authorized'}),/inconsistent/);
  assert.equal(JSON.stringify(f.rows),source);assert.deepEqual(f.rows,before.rows);
  assert.equal(compareHistoryRebuilds(one,{...one,view:'owner'}).state,'incomparable');
  assert.equal(compareHistoryRebuilds(one,{...one,rule:{id:'case-history',version:2}}).state,'incomparable');
});
test('history client compares validated same-session records and reports removal without inventing a revocation cause',async()=>{
  const f=fixture(),sessions=createSessionMemory({now:()=>1000,isCurrent:async()=>true});
  const adopt=()=>sessions.adopt({endpoint,subjectId:'GUID'+'0'.repeat(28),bindingId:randomUUID(),scopes:['binding','history'],expiresAt:1500,bindingExpiresAt:2000,takeCredential:()=>randomBytes(32).toString('base64url')});
  adopt();let tamper=false;
  const client=createHistoryClient({endpoint,sessions,send:async()=>({projectionVersion:1,derived:true,capabilityVerified:false,subjectId:null,checkedAt:1000,view:'authorized',nextCursor:null,
    items:[{...structuredClone(f.item),rebuild:{...f.receipt(),...(tamper?{contentHash:'0'.repeat(64)}:{})}}]})});
  try{
    assert.equal((await client.query()).items[0].rebuildComparison.state,'incomparable');
    assert.equal((await client.query()).items[0].rebuildComparison.state,'unchanged');
    const proofId=f.item.proofs[0].proofId;f.item.proofs=[];
    const changed=(await client.query()).items[0].rebuildComparison;
    assert.equal(changed.state,'changed');assert.deepEqual(changed.changes.proofs.removed,[proofId]);
    tamper=true;await assert.rejects(client.query(),/rebuild receipt/);tamper=false;
    assert.equal((await client.query()).items[0].rebuildComparison.state,'unchanged');
    f.item.collaborationContext={version:1,capabilityIds:[],items:[],capabilityVerified:false};
    const upgrade=await client.query();
    assert.equal(upgrade.items[0].rebuild.rule.version,2);
    assert.ok(upgrade.items[0].rebuildComparison.reasons.includes('different-projection-rule'));
    assert.equal((await client.query()).items[0].rebuildComparison.state,'unchanged');
    f.item.collaborationContext.items.push({assistanceId:randomUUID(),requestedScope:'Inspect'});
    assert.equal((await client.query()).items[0].rebuildComparison.state,'changed');
    f.item.fieldPolicy={id:'history-fields',version:1,view:'authorized'};
    f.item.reportedProgress={version:1,authority:'case-owner-reported',latestResultId:f.item.results[0].id,
      timeline:[{resultId:f.item.results[0].id,attemptId:f.rows[1].id,outcome:'failed',sourceEventVersion:3,corrected:false}],
      subsequentReports:[],capabilityVerified:false,attemptCountIsCapability:false};
    const third=await client.query();assert.equal(third.items[0].rebuild.rule.version,3);
    assert.ok(third.items[0].rebuildComparison.reasons.includes('different-projection-rule'));
    assert.equal((await client.query()).items[0].rebuildComparison.state,'unchanged');
    f.item.reportedProgress.capabilityVerified=true;await assert.rejects(client.query());f.item.reportedProgress.capabilityVerified=false;
    f.item.moderationContext={version:1,items:[]};
    const fourth=await client.query();assert.equal(fourth.items[0].rebuild.rule.version,4);
    assert.ok(fourth.items[0].rebuildComparison.reasons.includes('different-projection-rule'));
    f.item.moderationContext.items.push({reportId:randomUUID(),state:'resolved'});
    assert.equal((await client.query()).items[0].rebuildComparison.state,'changed');
    adopt();assert.equal((await client.query()).items[0].rebuildComparison.state,'incomparable');
  }finally{sessions.close();}
});
