import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { defaultRequestQuotaPolicy } from '../src/adapters/http/request-quotas.mjs';
export async function verifyRequestQuotaWorkflow(database=null,options={}){
  const f=await serviceFixture(['binding','consent','case-teaser'],database,options),policy=structuredClone(defaultRequestQuotaPolicy);
  policy.categories.submission={ip:100,subject:1,credential:1};
  const server=createApi({...f,requestQuotaPolicy:policy});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const post=async(path,body)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{Authorization:'Bearer '+f.credential,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json(),category:response.headers.get('x-galaxy-quota-category')};};
  try{
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Quota fixture',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const payload=await f.authorize(root);assert.equal((await post('/v1/cases',payload)).status,200);
    const limited=await post('/v1/cases',payload);assert.equal(limited.status,429);assert.equal(limited.category,'submission');
    assert.equal((await post('/v1/bindings/'+f.actor.bindingId+'/revoke',{})).status,200);
    assert.equal((await post('/v1/cases',payload)).status,401);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM cases WHERE id=$1',[root.id])).rows[0].count),1);
    return {verifiedSubjectQuota:true,excessSubmissionRejected:true,revocationIndependent:true,revokedCredentialDenied:true,oneCaseStored:true};
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!database)await f.db.close();}
}
