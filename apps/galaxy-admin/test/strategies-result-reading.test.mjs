import test from 'node:test';
import assert from 'node:assert/strict';
import {strategiesRunDetail,strategyRunAuditHref} from "../src/lib/strategies/strategies-view-model.ts";
import {normalizeAuditFilters,auditReadPath} from '../src/lib/audit-view-model.ts';

const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-'+String(n).padStart(12,'0');
const value=visibility=>({checkedAt:1792749600,readExpiresAt:1792749630,metadataOnly:true,run:{id:id(1),strategyId:id(2),versionId:id(3),executionId:id(4),workflow:{id:'galaxy-p13-selected-content-v1',version:1},ruleRefs:[],route:'code',state:'completed',code:null,native:null,effect:{id:id(5),kind:'post',operationId:id(6),visibility},createdAt:'2026-10-23T10:00:00.000Z',updatedAt:'2026-10-23T10:01:00.000Z'}});

test('strategy result reading accepts the actual controlled visibility receipt and carries the exact object and original operation into audit',()=>{
 for(const [raw,expected]of [[{hidden:true,version:2,body:'NOT_FOR_DISPLAY'},'hidden'],[{hidden:false,version:3},'visible'],['hidden','hidden'],['visible','visible'],[{hidden:null},null],[{hidden:'false'},null],[null,null],['success',null]]){
  const detail=strategiesRunDetail(value(raw));assert.ok(detail);assert.equal(detail.run.effect.visibility,expected);assert.ok(!JSON.stringify(detail).includes('NOT_FOR_DISPLAY'));
 }
 const receipt=strategiesRunDetail(value({hidden:false,version:3})).run.effect,url=new URL(strategyRunAuditHref(receipt),'https://local.invalid');
 assert.equal(url.pathname,'/admin/operations/audit');
 const filters=normalizeAuditFilters({resource:url.searchParams.get('resource'),query:url.searchParams.get('q')}),backend=new URL(auditReadPath(filters),'https://local.invalid');
 assert.equal(backend.searchParams.get('resourceId'),id(5));assert.equal(backend.searchParams.get('query'),id(6));assert.equal(url.searchParams.has('resourceId'),false);assert.equal(url.searchParams.has('query'),false);
});
