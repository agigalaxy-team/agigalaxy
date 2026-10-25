import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {businessAuditQuerySchema} from '../src/shared/business-admin-schema.mjs';
import {operationsProxyPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// The registered HTTP dispatcher and both URL guards are real. Identity and
// service effects are explicit doubles; the paged SQL service has a separate
// real PG leaf. This never creates records or performs external requests.
test('audit snapshot pages cross both exact HTTP routes and BFF with typed closed queries',async t=>{
 const origin='https://admin.example.invalid',accountId=randomUUID(),snapshot=randomUUID();
 const actor={kind:'business-operator',operatorId:'synthetic-manager',endpoint:'https://api.example.invalid'};
 const calls=[];let denied=false;
 const businessAdmin={require(who){assert.equal(who,actor);},async audit(who,input){
  assert.equal(who,actor);const parsed=businessAuditQuerySchema.safeParse(input);
  if(!parsed.success)throw new ServiceError('invalid_business_admin_request',400);
  calls.push(parsed.data);return {items:[],metadataOnly:true};
 }};
 const server=createApi({bindings:{endpoint:actor.endpoint},browserOrigins:[origin],rateLimit:100,businessAdmin,operations:{portal:{authorizeOperator:async(request,options)=>{
  assert.equal(options.write,false);assert.equal(options.action,'audit.read');if(denied)throw new ServiceError('operations_permission_denied',403);return actor;
 }}}});
 t.after(()=>new Promise(resolve=>server.close(resolve)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,headers={origin};
 for(const path of ['/v1/operations/audit','/v1/operations/users/'+accountId+'/audit']){
  const good=path+'?page=2&pageSize=50&snapshot='+snapshot+'&sort=oldest&kind=business';
  assert.equal(operationsReadPath(good),true);assert.equal(operationsProxyPolicy({url:origin+good,method:'GET',headers:new Headers(headers),publicOrigin:origin}).allowed,true);
  let response=await fetch(base+good,{headers});assert.equal(response.status,200);await response.json();
  const latest=calls.at(-1);assert.equal(latest.page,2);assert.equal(latest.pageSize,50);assert.equal(latest.snapshot,snapshot);assert.equal(latest.sort,'oldest');
  if(path.includes('/users/'))assert.equal(latest.accountId,accountId);
  response=await fetch(base+path+'?after=10&limit=30',{headers});assert.equal(response.status,200);await response.json();assert.equal(calls.at(-1).limit,30);
  for(const suffix of ['?page=0','?pageSize=31','?snapshot=invalid','?sort=operator','?page=1&limit=30','?page=1&after=10']){
   response=await fetch(base+path+suffix,{headers});assert.equal(response.status,400,suffix);await response.text();
  }
  for(const suffix of ['?page=1&page=2','?operatorId=other','?configuration=raw']){
   assert.equal(operationsReadPath(path+suffix),false);response=await fetch(base+path+suffix,{headers});assert([400,404].includes(response.status));await response.text();
  }
  denied=true;response=await fetch(base+good,{headers});assert.equal(response.status,403);await response.text();denied=false;
 }
 assert.equal(calls.length,4);
});
