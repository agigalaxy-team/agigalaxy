import {randomUUID} from 'node:crypto';
import {capsuleWebContinuityFixture} from './capsule-web-continuity-fixture.mjs';

// New database and identities per invocation. All records use the production
// HTTP/signer/permission services. The inherited local store and chat archive
// are contained Map doubles; no production work or external execution occurs.
export async function trustPackagePurposeFixture(){
 const f=await capsuleWebContinuityFixture();
 try{
  for(const [who,name] of [[f.author,'[本地合成] 资料整理者'],[f.sourceAuthor,'[本地合成] 材料作者']]){
   await who.write('/v1/profiles/statements',{id:randomUUID(),expectedRevision:1,selfDeclared:{displayName:name,
    about:'本机合成资料包、准确材料和有限许可，不代表真实项目或能力认证。',claimedCapabilities:[]}},'profile.publish',{visibility:'Public'});who.name=name;
  }
  const owner=f.author,peer=f.sourceAuthor,endpoint=owner.runtime.api.endpoint,
   ref=(work,event,version)=>({endpoint,kind:'case-event',id:event.eventId,caseId:work.caseId,version}),
   ownRef=ref(f.own,f.own.attempt,2),otherRef=ref(f.other,f.other.attempt,2),
   pair={kind:'subjects',subjectIds:[owner.identity.subjectId,peer.identity.subjectId]},
   evidence={id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:f.own.caseId,reportedBy:owner.identity.subjectId,synthetic:true,
    kind:'evidence',evidenceType:'self-assertion',source:{originSystem:'synthetic-local-text',externalStableId:randomUUID(),contentVersion:'1',
     originalAt:new Date(f.now()*1000).toISOString(),issuer:owner.name},observedAt:new Date(f.now()*1000).toISOString(),reportedSourceState:'available',summary:'[本地合成] 本人有限文字核对的来源说明'},
   verification={id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:f.own.caseId,reportedBy:owner.identity.subjectId,synthetic:true,
    kind:'verification',target:{type:'result',id:f.own.result.eventId,version:1},scopeVersion:1,method:'local-test',scope:'只检查声明的合成文字范围',
    conditions:{environment:'synthetic-text-only'},observation:'passed',summary:'[本地合成] 本人报告有限文字核对通过，不代表独立执行',evidenceRefs:[{id:evidence.id,version:1}],relationship:'same-controller',observedAt:new Date(f.now()*1000).toISOString()};
  await owner.write('/v2/verification-records/submit',evidence,'evidence.submit',{viewers:[peer.identity.subjectId]});
  await owner.write('/v2/verification-records/submit',verification,'evidence.submit',{viewers:[peer.identity.subjectId]});
  async function grant(who,source,grantee,audience){
   const input={id:randomUUID(),operationId:randomUUID(),source,grantee,audience,expiresAt:f.now()+7*86400},client=who.runtime.trustPackages;
   const preview=await client.permissionPreview(input),receipt=await client.executePermission(preview,{confirmed:true});return{...input,signatureHash:receipt.signatureHash};
  }
  const ownPermission=await grant(owner,ownRef,owner.identity.subjectId,{kind:'public'}),
   otherPermission=await grant(peer,otherRef,owner.identity.subjectId,pair);
  return{...f,owner,peer,ownRef,otherRef,pair,evidence,verification,ownPermission,otherPermission,grant};
 }catch(error){await f.close();throw error;}
}
