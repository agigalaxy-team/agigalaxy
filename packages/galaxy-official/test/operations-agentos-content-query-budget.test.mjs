import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsAgentOsQueryTools} from '../src/operations-agentos-query-tools.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('content tool pages are bounded before the current source read and retain a gap-free real continuation without source bodies',async()=>{
 const now=2000000000,actor={operatorId:'synthetic-current-owner',endpoint:'https://official.invalid'},calls=[];let allowed=true;
 const rows=Array.from({length:100},(_,i)=>({kind:'post',id:randomUUID(),postId:randomUUID(),versionId:randomUUID(),version:1,state:'published',sourceState:'available',createdAt:new Date((now-i)*1000).toISOString(),updatedAt:new Date(now*1000).toISOString(),
  title:'沿着河边记录每一段不同的光线'.repeat(5),excerpt:'记录街角和公共空间中的日常变化'.repeat(12).slice(0,180),topic:'technology',originalTopic:'technology',body:'PRIVATE_BODY_MUST_NOT_APPEAR',publishedUntil:now+600,
  author:{accountId:randomUUID(),uid:'GU00000000000000',displayName:'普通公开作者'},visibility:{version:6,hidden:false,ownHidden:false,inheritedHidden:false,caseHidden:false,until:null},curation:{revision:0,sourceVersion:1,appliesToCurrent:true,topic:null,pinned:false,featured:false,tags:[]}})).map(row=>({...row,postId:row.id}));
 const authority={now:()=>now,async human(value){assert.equal(value,actor);if(!allowed)throw new ServiceError('operations_permission_denied',403);return actor;}};
 const query=new OperationsAgentOsQueryTools({authority,services:{content:{async list(current,q){assert.equal(current,actor);calls.push({...q});const selected=q.targetId?rows.filter(row=>row.id===q.targetId):rows,start=q.after?selected.findIndex(row=>'post:'+row.id===q.after)+1:0,items=selected.slice(start,start+q.limit);return{items,nextAfter:start+items.length<selected.length?'post:'+items.at(-1).id:null,scanTruncated:false,summary:{available:true,total:selected.length,visible:selected.length,pendingReview:null,daily:[]},checkedAt:now,readExpiresAt:now+30};},async get(current,kind,id){assert.equal(current,actor);assert.equal(kind,'post');const content=rows.find(row=>row.id===id);assert.ok(content);return{content,checkedAt:now,readExpiresAt:now+30};}}}});
 const input={actor,domain:'governance',tool:'query-operations',arguments:{module:'content',view:'list',filters:{days:'all',limit:100}}};
 const first=await query.execute(input);
 assert.equal(calls[0].limit,20,'source receives a smaller page, not a discarded large result');assert.equal(first.data.items.length,20);
 assert.equal(first.pagination.requestedLimit,100);assert.equal(first.pagination.appliedLimit,20);assert.equal(first.pagination.complete,false);
 assert.equal(first.pagination.next.filters.after,'post:'+rows[19].id);assert.equal(first.pagination.next.filters.limit,20);
 const all=[...first.data.items];let next=first.pagination.next;
 while(next){const page=await query.execute({...input,arguments:next});all.push(...page.data.items);next=page.pagination.next;}
 assert.deepEqual(all.map(row=>row.id),rows.map(row=>row.id),'no row is skipped when the requested page is reduced');
 assert.equal(JSON.stringify(first).includes('PRIVATE_BODY_MUST_NOT_APPEAR'),false);assert.ok(Buffer.byteLength(JSON.stringify(first))<=180000);
 assert.equal(first.data.coverage,'returned-page');assert.equal(first.data.summary.total,100,'actual source aggregate is not replaced by page length');
 const exact=await query.execute({...input,arguments:{module:'content',view:'list',filters:{targetId:rows[0].id,limit:1}}});
 assert.equal(calls.at(-1).targetId,rows[0].id,'Node keeps the already-supported exact object filter');assert.equal(exact.pagination.appliedLimit,1);
 const detail=await query.execute({...input,tool:'read-operation-object',arguments:{kind:'post',id:rows[0].id,filters:{}}});
 assert.equal(detail.data.originalTopic,'technology');assert.equal(detail.data.curation.revision,0);
 allowed=false;const count=calls.length;await assert.rejects(query.execute(input),{code:'operations_permission_denied'});assert.equal(calls.length,count,'no source read without current permission');
});
