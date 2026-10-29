import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createProfileClient} from '../src/features/profiles/profile-client.mjs';

// The wire fixture controls only current projection responses. It does not
// assert server-side authorization or the provenance of an Honor.
async function fixture(t){
 const subjectId='GUID'+'A'.repeat(28),targetSubjectId='GUID'+'B'.repeat(28),calls=[];
 let generation=1,visible=true,hold=null;
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body||'{}');calls.push({path:req.url,input});
  if(req.url==='/v1/history/query'&&hold){const current=hold;hold=null;current.reached();await current.wait;}
  const result=req.url==='/v1/history/query'?{selfDeclared:visible?{displayName:'当前允许的名字',about:'当前介绍',claimedCapabilities:['自述']}:{},
   selfDeclaredSource:visible?{classification:'self-declared'}:null,selfDeclaredReadExpiresAt:2000000060,checkedAt:2000000000}:
   req.url==='/v1/honor/rules'?{rules:[]}:null;
  if(!result){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin='http://127.0.0.1:'+server.address().port;
 const snapshot=()=>({subjectId,bindingId:'binding',generation});
 const runtime={api:{endpoint:'https://official.example.org',snapshot,async call(path,input){
  const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  if(!response.ok)throw Error('unexpected wire response');return response.json();
 }},status:async()=>({identity:{subjectId}}),receiptStatus:{captureLease(){const current=generation;return{assertCurrent(){if(current!==generation)throw Error('authority_changed');}};}}};
 return{calls,client:()=>createProfileClient(runtime,{subjectId,targetSubjectId,authenticated:true}),targetSubjectId,
  hide(){visible=false;},rebind(){generation++;},hold(){
   let reached,release;const started=new Promise(resolve=>{reached=resolve;}),wait=new Promise(resolve=>{release=resolve;});
   hold={reached,wait};return{started,release};
  }};
}

test('current profile projection and names follow the latest wire response rather than older visible content',async t=>{
 const f=await fixture(t),client=f.client(),first=await client.overview();
 assert.equal(first.displayName,'当前允许的名字');assert.deepEqual(first.tags,['自述']);assert.equal(first.profileSource.classification,'self-declared');
 assert.deepEqual(await client.displayNames([f.targetSubjectId,f.targetSubjectId]),[{subjectId:f.targetSubjectId,displayName:'当前允许的名字',readExpiresAt:2000000060}]);
 f.hide();const current=await client.overview();
 assert.equal(current.displayName,null);assert.equal(current.about,null);assert.deepEqual(current.tags,[]);
 assert.equal((await client.displayNames([f.targetSubjectId]))[0].displayName,null);
 assert.ok(f.calls.every(call=>['/v1/history/query','/v1/honor/rules'].includes(call.path)));client.close();
});

test('a same-identity rebind fences late profile and name wire responses',async t=>{
 const f=await fixture(t),client=f.client(),pending=f.hold(),read=client.overview();
 await pending.started;f.rebind();pending.release();await assert.rejects(read,/authority_changed|profile_identity_changed/);
 const next=f.client(),pendingNames=f.hold(),names=next.displayNames([f.targetSubjectId]);
 await pendingNames.started;f.rebind();pendingNames.release();await assert.rejects(names,/authority_changed|profile_identity_changed/);
});
