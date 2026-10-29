import test from 'node:test';
import assert from 'node:assert/strict';
import {auditActionLabel,auditAvailableActions,auditFilterHref,auditHref,auditKind,auditMetadata,auditOutcome,auditPageHref,auditPageNumbers,auditReadPath,normalizeAuditFilters} from '../src/lib/audit-view-model.ts';
import {readFileSync} from 'node:fs';
const {businessAuditActionCodes,businessAuditReadActions}=JSON.parse(readFileSync(new URL('./original-ui-contract.json',import.meta.url),'utf8'));

test('audit result pages preserve the exact snapshot and filters, and every closed action has an honest display category',()=>{
 const id='11111111-1111-4111-8111-111111111111',snapshot='22222222-2222-4222-8222-222222222222';
 const source=normalizeAuditFilters({account:id,resource:id,selected:id,query:' metadata ',kind:'reads',action:'smtp-query',day:'2026-10-24',page:3,pageSize:50,snapshot,sort:'oldest'});
 const read=new URL(auditReadPath(source),'https://example.invalid');
 assert.equal(read.searchParams.get('page'),'3');assert.equal(read.searchParams.get('pageSize'),'50');assert.equal(read.searchParams.get('snapshot'),snapshot);assert.equal(read.searchParams.get('sort'),'oldest');
 assert.equal(read.searchParams.get('accountId'),id);assert.equal(read.searchParams.get('resourceId'),id);assert.equal(read.searchParams.get('query'),'metadata');
 for(const key of ['id','trail','after','limit'])assert.equal(read.searchParams.has(key),false);
 const next=new URL(auditPageHref(source,4,snapshot),'https://example.invalid');
 assert.equal(next.searchParams.get('page'),'4');assert.equal(next.searchParams.get('snapshot'),snapshot);assert.equal(next.searchParams.get('id'),null);assert.equal(next.searchParams.get('sort'),'oldest');
 for(const change of [{query:'next'},{kind:'business'},{action:'smtp-config-save'},{day:'2026-10-23'},{pageSize:100},{sort:'newest'},{resource:''},{account:''}]){
  const changed=new URL(auditFilterHref(source,change),'https://example.invalid');assert.equal(changed.searchParams.get('page'),null);assert.equal(changed.searchParams.get('snapshot'),null);assert.equal(changed.searchParams.get('id'),null);
 }
 const refresh=new URL(auditHref(source,{snapshot:''}),'https://example.invalid');assert.equal(refresh.searchParams.get('page'),'3');assert.equal(refresh.searchParams.get('snapshot'),null);
 assert.equal(auditReadPath(normalizeAuditFilters({after:'123'})),'/v1/operations/audit?limit=30&after=123','old cursor links remain readable without mixing protocols');
 assert.equal(normalizeAuditFilters({page:1000001,pageSize:999,snapshot:'private-invalid',sort:'arbitrary'}).page,1);
 assert.equal(normalizeAuditFilters({pageSize:999}).pageSize,30);
 assert.deepEqual(auditPageNumbers(4,0),[]);assert.deepEqual(auditPageNumbers(2,3),[1,2,3]);assert.deepEqual(auditPageNumbers(50,100),[1,null,49,50,51,null,100]);
 const event=action=>({id,sequence:'1',operatorId:'synthetic-principal',operatorRole:'reader',action,accountId:null,operationId:null,httpRequestId:null,selection:{},result:{},createdAt:'2026-10-24T00:00:00Z'});
 const reads=new Set(businessAuditReadActions),actions=auditAvailableActions([...businessAuditActionCodes,'unknown-private-action']);
 assert.equal(actions.length,businessAuditActionCodes.length);
 for(const action of businessAuditActionCodes){assert.notEqual(auditActionLabel(action),'其他业务记录',action);assert.equal(auditKind(event(action)),reads.has(action)?'reads':'business',action);}
 assert.equal(actions.includes('unknown-private-action'),false);
 assert.equal(auditOutcome({...event('smtp-delivery-test'),result:{state:'submitted'}}).label,'已提交');
 assert.equal(auditOutcome({...event('smtp-delivery-test'),result:{state:'unknown'}}).tone,'warning');
 assert.equal(auditOutcome({...event('file-access-stop'),result:{stopped:true}}).label,'访问已停止');
 assert.equal(auditOutcome({...event('file-access-restore'),result:{stopped:false}}).label,'已解除访问停止');
 assert.equal(auditMetadata({kind:'pause'},'notice-withdraw')[0].value,'暂停计划');
 assert.equal(auditMetadata({until:1793000000})[0].label,'截止时间');
 const projected=JSON.stringify(auditMetadata({changedFields:['host','credentialRef','unknown-secret-field'],reason:'private prose',query:'private words',password:'private password',state:'unapproved-private-state'}));
 assert.equal(projected.includes('SMTP服务器'),true);assert.equal(projected.includes('凭据引用'),true);assert.equal(projected.includes('private'),false);
});
