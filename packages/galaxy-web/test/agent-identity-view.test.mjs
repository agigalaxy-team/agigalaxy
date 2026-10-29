import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-contracts/src/identity/identity-material.mjs';
import {browserScopes} from '../../galaxy-client/src/browser-client.mjs';
import {createAgentIdentityView} from "../src/features/agent-identity/agent-identity-view.ts";

const endpoint='https://official.example.org',website='https://galaxy.example.org',bridgeOrigin='http://127.0.0.1:39841';
const subjectId='GUID10'+'0'.repeat(26),protocol='galaxy-web-identity-handoff';
const scopes=['binding','assistance'];
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let attempt=0;attempt<300;attempt++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(check(),'handoff reached the expected observable state');}
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};}

// Synthetic browser transport with real possession signatures. The runtime
// retains the exact preview object and rejects use after an identity change.
async function fixture(t,{changeGate=null,adoptGate=null}={}){
 const native=await createDeviceMaterial(),browser=await createDeviceMaterial();
 const nativeKey=await identityKeyId(native.publicKeyPem),browserKey=await identityKeyId(browser.publicKeyPem);
 const node=(material,keyId)=>({device_id:material.deviceId,key_id:keyId,public_key:material.publicKeyPem,epoch:1,status:'active',scopes:['manage-identity',...browserScopes]});
 const control={authority:endpoint,subjectId,epoch:1,chainHead:'a'.repeat(64),devices:[node(native,nativeKey),node(browser,browserKey)]};
 const state={identity:{subjectId,deviceId:browser.deviceId},connection:{subjectId,endpoint,bindingId:crypto.randomUUID(),generation:1,control:{deviceId:browser.deviceId,epoch:1},scopes}};
 const preview={subjectId,visitorDraft:{title:'Visitor draft',description:'Original unpublished content'},existingDraft:{title:'Existing identity draft',description:'Keep this until explicitly replaced'}};
 const calls={changed:0,preview:0,adopt:0,navigate:[]},packets=[],messageListeners=new Set(),visibilityListeners=new Set(),intervals=new Set();
 const opener={closed:false,postMessage:(packet)=>packets.push(structuredClone(packet))};
 const host={opener,addEventListener:(name,listener)=>{if(name==='message')messageListeners.add(listener);},removeEventListener:(_name,listener)=>messageListeners.delete(listener),setInterval:(callback,delay)=>{const id=setInterval(()=>callback(),delay);intervals.add(id);return id;},clearInterval:(id)=>{clearInterval(id);intervals.delete(id);}};
 const previous=new Map(['window','document','location'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 for(const [name,value] of Object.entries({window:host,document:{addEventListener:(_name,listener)=>visibilityListeners.add(listener),removeEventListener:(_name,listener)=>visibilityListeners.delete(listener)},location:{origin:website}}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
 const runtime={api:{endpoint},status:async()=>structuredClone({...state,endpoint}),publicControl:async()=>structuredClone(control),deviceHandoff:{pending:async()=>null},
  receiptStatus:{captureLease:()=>{const identity=state.identity,connection=state.connection;return{subjectId:identity.subjectId,deviceId:identity.deviceId,assertCurrent:()=>{if(identity!==state.identity||connection!==state.connection)throw Object.assign(new Error('changed'),{code:'receipt_status_authority_changed'});}};}},
  agentContinuity:{retainHandoff:async()=>{},requireCurrent:async()=>{}},
  visitorDrafts:{preview:async()=>{calls.preview++;return preview;},adopt:async(value,{confirmed})=>{calls.adopt++;assert.equal(value,preview);assert.equal(confirmed,true);if(adoptGate)await adoptGate.promise;return{currentIdentityChanged:false};}}};
 const entry={valid:true,handoffId:crypto.randomUUID(),navigationId:crypto.randomUUID(),bridgeOrigin,targetPath:'/app/publish?sourceTask=original#draft',website};
 const view=createAgentIdentityView(runtime,entry,reason=>reason.code??'unknown');
 view.setCallbacks({navigate:path=>calls.navigate.push(path),onChange:async()=>{calls.changed++;if(changeGate)await changeGate.promise;},onManual:()=>{}});
 t.after(()=>{view.close();for(const id of intervals)clearInterval(id);for(const [name,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}});
 view.start();await until(()=>packets.some(packet=>packet.kind==='ready'));
 const {nonce,existingDevice}=packets.find(packet=>packet.kind==='ready').payload;
 const context={endpoint,website,subjectId,controller:{deviceId:native.deviceId,keyId:nativeKey,epoch:1,chainHead:control.chainHead},scopes,expiresAt:Math.floor(Date.now()/1000)+120,targetPath:entry.targetPath,existingDevice};
 const payloadJson=JSON.stringify({protocol,version:1,handoffId:entry.handoffId,navigationId:entry.navigationId,nonce,bridgeOrigin,context});
 const payload={...context,nonce,bridgeOrigin,proof:{payloadJson,signature:await signIdentityPayload(payloadJson,native.privateKey,{type:'galaxy-web-identity-handoff-v1+jws'})}};
 const event={origin:bridgeOrigin,source:opener,data:{protocol,version:1,handoffId:entry.handoffId,navigationId:entry.navigationId,kind:'context',payload}};
 for(const listener of messageListeners)listener(event);
 return{view,state,calls,entry,preview,visibilityListeners};
}

test('leaving during identity refresh prevents a late draft choice or navigation',async t=>{
 const paused=gate(),f=await fixture(t,{changeGate:paused});await until(()=>f.calls.changed===1);
 f.view.close();paused.release();await turn();await turn();
 assert.equal(f.calls.preview,0);assert.deepEqual(f.calls.navigate,[]);assert.equal(f.view.snapshot().draft,null);assert.equal(f.visibilityListeners.size,0);
});

test('a completed handoff keeps both drafts until the explicit keep choice',async t=>{
 const f=await fixture(t);await until(()=>f.view.snapshot().draft!==null);
 assert.equal(f.view.snapshot().draft.preview,f.preview);assert.equal(f.calls.adopt,0);assert.deepEqual(f.calls.navigate,[]);
 f.view.keep();assert.deepEqual(f.calls.navigate,[f.entry.targetPath]);assert.equal(f.calls.adopt,0);
});

test('a changed identity clears an offered draft and cannot adopt it',async t=>{
 const f=await fixture(t);await until(()=>f.view.snapshot().draft!==null);
 f.state.identity={subjectId:'GUID10'+'1'.repeat(26),deviceId:crypto.randomUUID()};
 for(const listener of f.visibilityListeners)listener();
 assert.equal(f.view.snapshot().draft,null);assert.equal(f.view.snapshot().handoff.phase,'stopped');
 await f.view.adopt();f.view.keep();assert.equal(f.calls.adopt,0);assert.deepEqual(f.calls.navigate,[]);
});

test('one explicit adoption uses the exact preview and a late binding change prevents return',async t=>{
 const paused=gate(),f=await fixture(t,{adoptGate:paused});await until(()=>f.view.snapshot().draft!==null);
 const first=f.view.adopt();await f.view.adopt();assert.equal(f.calls.adopt,1);
 f.state.connection={...f.state.connection,generation:2};paused.release();await first;
 assert.deepEqual(f.calls.navigate,[]);assert.equal(f.view.snapshot().draft,null);assert.equal(f.view.snapshot().error,'receipt_status_authority_changed');
});
