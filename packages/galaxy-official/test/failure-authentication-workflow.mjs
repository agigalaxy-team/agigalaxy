import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createFailureAuditSpool } from '../src/infrastructure/failure-audit-spool.mjs';
import { httpFailureWriter } from '../src/infrastructure/http-failure-audit.mjs';

export async function verifyFailureAuthentication(database=null,options={}){
  const f=await serviceFixture(['binding','consent','case-teaser'],database,options),admin=options.adminDatabase??f.db;
  const directory=await mkdtemp(join(tmpdir(),'galaxy-failure-authentication-')),path=join(directory,'queue.sqlite'),endpoint=f.access.endpoint;
  let spool,api;
  try{
    const legacy={requestId:randomUUID(),status:503,route:'POST /v1/cases',actor:{subjectId:f.actor.subjectId,bindingId:f.actor.bindingId},observedAt:new Date(f.now*1000).toISOString()};
    await writeFile(path,'',{mode:0o600});
    const v1=new DatabaseSync(path);
    v1.exec('CREATE TABLE metadata(endpoint TEXT PRIMARY KEY);CREATE TABLE pending(request_id TEXT PRIMARY KEY,event_json TEXT NOT NULL);PRAGMA user_version=1;');
    v1.prepare('INSERT INTO metadata(endpoint) VALUES (?)').run(endpoint);
    v1.prepare('INSERT INTO pending(request_id,event_json) VALUES (?,?)').run(legacy.requestId,JSON.stringify(legacy));v1.close();
    spool=await createFailureAuditSpool({path,endpoint,intervalMs:60000,write:async()=>{throw new Error('Synthetic database outage');}});
    await spool.flush();assert.equal(spool.status().pending,1);
    await admin.query('UPDATE access_credentials SET scopes=$2::jsonb WHERE token_hash=$1',[f.actor.credentialHash,JSON.stringify(['case-teaser'])]);
    const expected=(await f.access.authenticate(f.credential,'case-teaser')).authentication;
    const capture=await f.access.authenticate(f.credential,'case-teaser');
    capture.scopes.push('untrusted-added-scope');
    assert.deepEqual(capture.authentication.credentialScopes,['case-teaser'],'failure snapshot is detached from mutable actor scopes');
    api=createApi({...f,failureAudit:spool.record,cases:{submit:async()=>{throw new Error('synthetic-private-backend-detail');}}});
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const response=await fetch('http://127.0.0.1:'+api.address().port+'/v1/cases',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.credential},
      body:JSON.stringify({consentId:randomUUID(),payloadJson:'{"kind":"case","note":"synthetic-private-body"}'})});
    assert.equal(response.status,500);await response.arrayBuffer();await spool.flush();
    const requestId=response.headers.get('x-request-id');assert.equal(spool.status().pending,2);
    const queue=new DatabaseSync(path,{readOnly:true});
    assert.equal(queue.prepare('PRAGMA user_version').get().user_version,2);
    const saved=queue.prepare('SELECT event_json FROM pending WHERE request_id=?').get(requestId).event_json;queue.close();
    assert.deepEqual(JSON.parse(saved).actor.authentication,expected);
    for(const value of [f.credential,f.actor.credentialHash,'synthetic-private-body','synthetic-private-backend-detail'])assert.ok(!saved.includes(value));
    api.closeAllConnections();await new Promise(resolve=>api.close(resolve));api=null;await spool.close();
    // Delivery must preserve authentication-time fields even after the binding changes.
    await admin.query('UPDATE access_credentials SET scopes=$2::jsonb WHERE token_hash=$1',[f.actor.credentialHash,JSON.stringify(['binding'])]);
    await admin.query('UPDATE bindings SET scopes=$2::jsonb,revoked_at=$3 WHERE id=$1',[f.actor.bindingId,JSON.stringify(['binding']),new Date(f.now*1000).toISOString()]);
    await admin.query("UPDATE binding_challenges SET payload=jsonb_set(payload,'{installationId}',to_jsonb($2::text)) WHERE id=(SELECT challenge_id FROM bindings WHERE id=$1)",[f.actor.bindingId,randomUUID()]);
    spool=await createFailureAuditSpool({path,endpoint,intervalMs:60000,write:httpFailureWriter(f.db,endpoint)});
    await spool.flush();assert.equal(spool.status().pending,0);
    const rows=(await f.db.query('SELECT * FROM audit_events WHERE http_request_id=ANY($1::uuid[]) ORDER BY sequence',[[legacy.requestId,requestId]])).rows;
    assert.equal(rows.length,2);
    const row=rows.find(item=>item.http_request_id===requestId),old=rows.find(item=>item.http_request_id===legacy.requestId);
    assert.equal(row.context_version,0);assert.equal(row.scope,'case-teaser');assert.equal(row.consent_id,null);assert.equal(row.binding_id,null);
    assert.equal(row.caller_client_id,expected.clientId);assert.equal(row.caller_audience,expected.audience);assert.equal(row.caller_binding_id,f.actor.bindingId);
    assert.deepEqual(row.caller_binding_scopes,['binding','consent','case-teaser']);assert.deepEqual(row.credential_scopes,['case-teaser']);
    assert.equal(old.scope,null);assert.equal(old.credential_scopes,null);assert.equal(old.context_version,0);
    await assert.rejects(f.access.authenticate(f.credential,'case-teaser'),/access_denied/);
    return {authenticationTimeSnapshot:true,narrowCredentialPreserved:true,delayedDeliveryAfterRevocation:true,legacyQueueUpgraded:true,legacyUnknownPreserved:true,noSecretFields:true};
  }finally{
    if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
    await spool?.close();await rm(directory,{recursive:true,force:true});if(!database)await f.db.close();
  }
}
