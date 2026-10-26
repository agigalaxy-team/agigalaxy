import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,randomBytes} from 'node:crypto';
import {CompactSign} from 'jose';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BindingService,digest} from "../src/identity/bindings.mjs";
import {AccessService} from "../src/security/access.mjs";
import {ChatService} from '../src/chat/service.mjs';
import {createGalaxyGenesis} from '../../galaxy-core/src/galaxy-guid.mjs';
const pem=k=>k.export({format:'pem',type:'spki'});
export async function chatFixture({database=null,runtimeDb=null,transport=null,migrateDatabase=true,scopes=['binding']}={}){
 const db=database??new PGlite();if(migrateDatabase)await migrate(db);let now=Math.floor(Date.now()/1000);const server=generateKeyPairSync('ed25519');
 const access=new AccessService(new BindingService({db:runtimeDb??db,endpoint:'https://chat.example.org',signingKey:server.privateKey,kid:'test',allowedScopes:scopes,now:()=>now,
  trustedKeys:new Map([['test',{publicKeyPem:pem(server.publicKey),notBefore:now-1,notAfter:now+86400*100,revoked:false}]])}));
 const bindings=new BindingService({db:runtimeDb??db,endpoint:access.endpoint,signingKey:server.privateKey,kid:'test',allowedScopes:scopes,now:()=>now,trustedKeys:access.trustedKeys});
 const credentials=new Map();
 async function actor(){const keys=generateKeyPairSync('ed25519'),genesis=createGalaxyGenesis({publicKeyPem:pem(keys.publicKey),originCode:'5'});
  const sign=(text,typ)=>new CompactSign(Buffer.from(text)).setProtectedHeader({alg:'Ed25519',typ}).sign(keys.privateKey);
  const c=await bindings.challenge({subjectId:genesis.id,genesisProof:genesis.genesisProof,installationId:randomUUID(),scopes});
  const b=await bindings.bind({challenge:c.challenge,clientSession:c.clientSession,signature:await sign(c.challenge,'galaxy-binding-response+jws')});const token=randomBytes(32).toString('base64url');
  const sc=await access.challenge({bindingId:b.bindingId,credentialHash:digest(token)});await access.activate({...sc,signature:await sign(sc.challenge,'galaxy-session-response+jws')});
  const current=await access.authenticate(token);credentials.set(current.subjectId,token);return current;
 }
 const people=await Promise.all([actor(),actor(),actor()]);const chat=new ChatService({db:runtimeDb??db,access,transport,now:()=>now,
  // Explicit internal fixtures isolate room semantics; the account-registry
  // rejection path and full signed OIDC/quotas are separate integration tests.
  requireAccountWithin:async()=>{},consumeInviteWithin:async()=>{},markInviteRespondedWithin:async()=>{}});
 return{db,chat,people,credentials,now:()=>now,advance:n=>{now+=n;},close:()=>database?Promise.resolve():db.close()};
}
export async function invite(chat,who,roomId,target,others=[]){const r=await chat.get(who,roomId),id=randomUUID();
 let d=await chat.proposeDecision(who,roomId,{decisionId:id,expectedRevision:r.revision,action:'invite',targetSubjectId:target.subjectId});
 for(const a of others)d=await chat.voteDecision(a,roomId,{decisionId:id,choice:'approve'});
 assert.equal(d.state,'approved');return chat.acceptInvite(target,roomId,{decisionId:id});
}
export async function verifyGovernance(options={}){
 const f=await chatFixture(options);try{const {chat,people:[a,b,c]}=f,roomId=randomUUID(),operationId=randomUUID();
  const room=await chat.create(a,{roomId,operationId,title:'Ordinary conversation'});assert.equal(room.state,'waiting-members');assert.equal(room.decisionRequired,false);assert.deepEqual(room.taskRefs,[]);
  assert.equal((await chat.create(a,{roomId,operationId,title:'Ordinary conversation'})).roomId,roomId);
  await assert.rejects(chat.get(b,roomId),/chat_access_denied/);
  await invite(chat,a,roomId,b);assert.equal((await chat.get(a,roomId)).independentMemberCount,2);
  const acceptedByB=(await chat.decisions(a,roomId)).decisions.find(d=>d.payload.targetSubjectId===b.subjectId).decisionId;
  await assert.rejects(chat.proposeDecision(a,roomId,{decisionId:randomUUID(),expectedRevision:2,action:'remove',targetSubjectId:b.subjectId}),/two_party_removal/);
  const invitation=randomUUID();await chat.proposeDecision(a,roomId,{decisionId:invitation,expectedRevision:2,action:'invite',targetSubjectId:c.subjectId});
  await assert.rejects(chat.acceptInvite(c,roomId,{decisionId:invitation}),/decision_unavailable/);
  await chat.voteDecision(b,roomId,{decisionId:invitation,choice:'reject'});await assert.rejects(chat.acceptInvite(c,roomId,{decisionId:invitation}),/decision_unavailable/);
  await invite(chat,a,roomId,c,[b]);assert.equal((await chat.get(a,roomId)).independentMemberCount,3);
  const retention=randomUUID(),before=await chat.get(a,roomId);await chat.proposeDecision(a,roomId,{decisionId:retention,expectedRevision:before.revision,action:'retention',retentionDays:7});
  await chat.voteDecision(b,roomId,{decisionId:retention,choice:'approve'});assert.equal((await chat.get(a,roomId)).retentionDays,90);
  await chat.voteDecision(c,roomId,{decisionId:retention,choice:'approve'});assert.equal((await chat.get(a,roomId)).retentionDays,7);
  await chat.leave(c,roomId);await chat.leave(b,roomId);const last=await chat.get(a,roomId);assert.equal(last.state,'single-member-decision');
  const oldAcceptance=await chat.acceptInvite(b,roomId,{decisionId:acceptedByB});assert.equal(oldAcceptance.membershipActive,false);assert.equal(oldAcceptance.room,undefined,'Old accepted invite does not reveal new members or rejoin');
  await assert.rejects(chat.get(b,roomId),/chat_access_denied/);await chat.dismissDecision(a,roomId);
  const ownership=randomUUID();await chat.proposeDecision(a,roomId,{decisionId:ownership,expectedRevision:last.revision,action:'become-owner',targetSubjectId:a.subjectId});
  await chat.acceptInvite(a,roomId,{decisionId:ownership});const owned=await chat.get(a,roomId);assert.equal(owned.mode,'owned');assert.equal(owned.retentionDays,7);assert.equal(owned.persistent,false);
  return{ordinaryRoom:true,commonGovernance:true,explicitMembership:true,ownershipDoesNotExtendTTL:true};
 }finally{await f.close();}
}
