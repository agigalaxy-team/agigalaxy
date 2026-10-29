import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createAccountVerificationClient} from '../src/features/accounts/account-verification-client.mjs';

// This fixture implements only the HTTP responses needed by the browser client;
// it is not an assertion about the Go service or real OIDC verification.
async function fixture(t) {
 const endpoint='https://official.example.org',subjectId='GUID'+'A'.repeat(28),deviceId=randomUUID();
 let bindingId=randomUUID(),generation=1,clock=1800000000,dropBefore=false,dropAfter=false,signs=0;
 const rows=new Map(),items=new Map(),writes=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const input=JSON.parse(body||'{}');let value;
  if(req.url==='/v1/identity/query')value={subjectId,endpoint,items:items.has(input.id)?[items.get(input.id)]:[],nextAfter:null};
  else if(req.url==='/v1/identity/status'){
   const record=rows.get(subjectId+':account-verification-operations').operations[input.id];
   const intent={version:1,id:input.id,action:'identity.link',subjectId,bindingId:record.bindingId,endpoint,providerId:'fixture',
    issuer:'https://identity.example.org',externalSubject:'synthetic-user',clientId:'synthetic-client',
    authentication:'oidc-authorization-code-pkce-s256-id-token-signature',verifiedAt:clock,issuedAt:clock,expiresAt:record.expiresAt,galaxyAuthorization:false};
   value={id:input.id,state:'awaiting-local-signature',expiresAt:record.expiresAt,intent,payloadJson:JSON.stringify(intent),galaxyAuthorization:false};
  }else if(req.url==='/v1/identity/confirm'){
   writes.push(structuredClone(input));
   const intent=JSON.parse(input.signed);
   items.set(input.id,{id:input.id,subjectId,bindingId:intent.bindingId,endpoint,providerId:intent.providerId,issuer:intent.issuer,
    externalSubject:intent.externalSubject,clientId:intent.clientId,createdAt:new Date(clock*1000).toISOString(),revokedAt:null,state:'linked',galaxyAuthorization:false});
   value={id:input.id,state:'linked',galaxyAuthorization:false};
  }else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin='http://127.0.0.1:'+server.address().port;
 const snapshot=()=>({endpoint,subjectId,bindingId,generation,scopes:['binding'],expiresAt:clock+600,bindingExpiresAt:clock+900});
 const api={endpoint,snapshot,async call(path,input){
  if(path==='/v1/identity/confirm'&&dropBefore){dropBefore=false;throw Error('before delivery');}
  const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  if(!response.ok)throw Error('unexpected wire response '+response.status);
  const value=await response.json();
  if(path==='/v1/identity/confirm'&&dropAfter){dropAfter=false;throw Error('lost ACK');}
  return value;
 }};
 const client=createAccountVerificationClient({api,endpoint,now:()=>clock,
  captureLease:()=>{const authority={...snapshot(),deviceId};return{...authority,assertCurrent(){if(generation!==authority.generation)throw Error('account_authority_changed');}};},
  sign:async payload=>{signs++;return payload;},
  getLocal:async(name,owner)=>structuredClone(rows.get(owner+':'+name)),
  updateLocal:async(name,update,owner)=>{const key=owner+':'+name,value=update(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);}});
 function seed(){
  const id=randomUUID(),record={version:1,id,subjectId,endpoint,bindingId,providerId:'fixture',issuer:'https://identity.example.org',
   authorizationUrl:'https://identity.example.org/authorize',expiresAt:clock+300,state:'awaiting-login'};
  rows.set(subjectId+':account-verification-operations',{version:1,subjectId,endpoint,activeId:id,operations:{[id]:record}});return id;
 }
 return{client,seed,writes,items,signs:()=>signs,dropBefore:()=>{dropBefore=true;},dropAfter:()=>{dropAfter=true;},
  advance:n=>{clock+=n;},rebind:()=>{bindingId=randomUUID();generation++;}};
}

test('account wire recovery requires initial approval and reuses the saved signature after lost delivery',async t=>{
 const f=await fixture(t),id=f.seed(),preview=await f.client.resumePending();
 assert.equal(preview.state,'awaiting-local-signature');assert.equal(f.signs(),0);assert.equal(f.writes.length,0);
 f.dropBefore();await assert.rejects(f.client.confirm(id,{confirmed:true,preview}),/before delivery/);
 assert.equal(f.signs(),1);assert.equal((await f.client.resumePending()).state,'linked');
 assert.equal(f.writes.length,1);assert.equal(f.signs(),1);assert.equal(await f.client.pending(),null);
});

test('account wire recovery reads an accepted unknown receipt without a second signature or write',async t=>{
 const f=await fixture(t),id=f.seed(),preview=await f.client.status(id);
 f.dropAfter();await assert.rejects(f.client.confirm(id,{confirmed:true,preview}),/lost ACK/);
 const sent=structuredClone(f.writes[0]);assert.equal((await f.client.resumePending()).state,'linked');
 assert.equal(f.writes.length,1);assert.equal(f.signs(),1);assert.deepEqual(f.writes[0],sent);
});

test('expired or changed-binding account choices stay local and never repeat the original write',async t=>{
 const f=await fixture(t),id=f.seed(),preview=await f.client.status(id);
 f.dropBefore();await assert.rejects(f.client.confirm(id,{confirmed:true,preview}),/before delivery/);
 f.advance(301);assert.equal((await f.client.resumePending()).reason,'authorization-expired');
 f.rebind();assert.equal((await f.client.resumePending()).reason,'original-binding-changed');
 assert.equal(f.writes.length,0);assert.equal(f.signs(),1);
});
