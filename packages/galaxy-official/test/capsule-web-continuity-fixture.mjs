import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {createCapsuleWebClient} from '../../galaxy-web/src/capsule-workspace-client.mjs';
import {createCapsuleVisibilityClient} from '../../galaxy-web/src/capsule-visibility-client.mjs';
import {digest} from '../src/shared/digest.mjs';

// HTTP, identity/OIDC, Ed25519 Consent, source permission and database behavior
// are real. Local storage and the chat archive are explicitly contained doubles.
export async function capsuleWebContinuityFixture(){
  const f=await communityForumFixture(),allScopes=['manage-identity',...browserScopes],requests=[],messages=new Map(),hooks={};
  let offset=0;const now=()=>Math.floor(Date.now()/1000)+offset;
  f.owner.bindings.allowedScopes=new Set(browserScopes);f.owner.identityControl.allowedScopes=new Set(allScopes);
  f.owner.chat.transport={available:true,project:async()=>{},send:async item=>{messages.set(item.messageId,{archiveId:item.messageId,text:item.text,revision:1});return{archiveId:item.messageId};},
    read:async({ids})=>{if(hooks.beforeArchiveRead)await hooks.beforeArchiveRead();return ids.map(id=>messages.get(id)).filter(Boolean);},
    edit:async item=>{const revision=item.expectedRevision+1;messages.set(item.messageId,{archiveId:item.messageId,text:item.text,revision});return{revision};},
    erase:async({messageId})=>{messages.delete(messageId);return{archiveDeleted:true};},exportOwn:async({ids})=>ids.map(id=>messages.get(id)).filter(Boolean)};
  const people=[];
  async function person(name){
    const values=new Map(),store={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value)),
      update:async(key,change)=>{const next=change(structuredClone(values.get(key)));if(next?.then)throw Error('fixture_sync_update_required');values.set(key,structuredClone(next));return structuredClone(next);}};
    const runtime=await createWebRuntime({endpoint:f.owner.bindings.endpoint,trustedKeys:f.owner.bindings.trustedKeys},{store,now,fetch:async(url,input)=>{
      f.clock.now=now();const path=new URL(url).pathname;
      if(hooks.beforeRequest)await hooks.beforeRequest(path,input);
      const response=await fetch(f.origin+path,input);let locator={};
      if(path==='/v1/consents'&&input?.body){const intent=JSON.parse(Buffer.from(JSON.parse(input.body).signedIntent.split('.')[1],'base64url'));
        locator={operationId:intent.objectId,payloadHash:intent.payloadHash,consentId:intent.id};}
      else if(['/v2/capsules/events','/v2/capsules/permissions'].includes(path)&&input?.body){const envelope=JSON.parse(input.body),payload=JSON.parse(envelope.payloadJson);
        locator={operationId:payload.id,payloadHash:digest(envelope.payloadJson),consentId:envelope.consentId};}
      requests.push({path,status:response.status,...locator});
      if(hooks.afterResponse)await hooks.afterResponse(path,response,input);
      return response;
    }});
    await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
    const identity=(await runtime.status()).identity,material=await store.get(`device:${identity.subjectId}:${identity.deviceId}`);
    f.issuer.setAccount('capsule-continuity-'+randomUUID());const login=await runtime.api.call('/v1/identity/begin',{providerId:'forum-fixture'}),callback=await f.issuer.authorize(login.authorizationUrl),response=await fetch(f.origin+callback.pathname+callback.search);
    if(!response.ok)throw Error('fixture_oidc_callback_failed');await response.arrayBuffer();const preview=await runtime.api.call('/v1/identity/status',{id:login.loginId});
    await runtime.api.call('/v1/identity/confirm',{id:login.loginId,signed:await signIdentityPayload(preview.payloadJson,material.privateKey,{type:'galaxy-identity-link+jws'})});
    const grant=(payload,action,{visibility='Private',viewers=[]}={})=>runtime.api.authorizePayload(payload,{action,objectId:payload.eventId??payload.operationId??payload.id,
      visibility,viewers,expiresAt:now()+7*86400,confirmed:true});
    const write=async(path,payload,action,scope)=>runtime.api.call(path,await grant(payload,action,scope));
    await write('/v1/profiles/statements',{id:randomUUID(),expectedRevision:0,selfDeclared:{displayName:name,about:'明确本地合成的方法和来源，不代表生产执行或认证。',claimedCapabilities:[]}},'profile.publish',{visibility:'Public'});
    const clientOptions={api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,updateLocal:runtime.updateLocal,subjectId:identity.subjectId,now};
    const who={name,identity,runtime,values,store,grant,write,clientOptions,client:createCapsuleWebClient(clientOptions),visibility:createCapsuleVisibilityClient(clientOptions)};
    people.push(who);return who;
  }
  try{
    const author=await person('[本地合成] 方法整理者'),sourceAuthor=await person('[本地合成] 来源作者');
    async function work(who,viewer){
      const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:who.identity.subjectId,
        localRef:randomUUID(),title:who.name+'的有限工作',summary:'只有声明的本地合成文字例子。',source:{kind:'local',reference:randomUUID()},synthetic:true},
        scope={viewers:[viewer.identity.subjectId]};
      await who.write('/v2/cases/events',root,'case.teaser.publish',scope);
      const attempt={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId,expectedVersion:1,actorId:who.identity.subjectId,role:'implementation',
        strategy:'逐项核对合成说明中的对象。',inputScopeSummary:'同一段明确合成文本。',permissionScope:['selected-context'],environment:{name:'synthetic-local',version:'1'}};
      await who.write('/v2/cases/events',attempt,'case.teaser.publish',scope);
      const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,actorId:who.identity.subjectId,
        origin:{kind:'attempt',id:attempt.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'succeeded',summary:'已完成本例中声明的有限合成核对。',limitations:'没有真实项目、外部执行或独立认证。'};
      await who.write('/v2/cases/events',result,'case.teaser.publish',scope);return{caseId,root,attempt,result};
    }
    const own=await work(author,sourceAuthor),other=await work(sourceAuthor,author),otherRef={kind:'attempt',id:other.attempt.eventId,version:1,caseId:other.caseId};
    const permission={schemaVersion:2,kind:'grant',id:randomUUID(),sources:[otherRef],grantees:[author.identity.subjectId],license:'MIT',scope:'准确合成尝试及作者自己的上游背景，仅本次方法材料。',
      basis:'authored-content',attribution:sourceAuthor.name,allowPublic:false,expiresAt:new Date((now()+7*86400)*1000).toISOString()};
    await sourceAuthor.write('/v2/capsules/permissions',permission,'capsule.permission',{viewers:[author.identity.subjectId]});
    const payload={schemaVersion:2,kind:'version',id:randomUUID(),capsuleId:randomUUID(),expectedRevision:0,version:1,publicationClass:'formal-source-success',synthetic:true,
      title:'[本地合成] 有限方法与准确来源',problemPattern:'避免混淆说明中的对象',environment:{name:'synthetic-local',version:'1'},solutionStrategy:'逐项核对具体对象及阅读范围。',
      tools:[],skills:[],mcpRefs:[],verificationMethod:'仅准确引用当前已登记的合成结果，不冒称独立验证。',limitations:['只有本地合成记录。'],capabilityId:'software-debugging',applicableScope:'合成说明',license:'MIT',
      contributors:[sourceAuthor.identity.subjectId],sourceResolution:{caseId:own.caseId,resultId:own.result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},sourceRefs:[otherRef],permissionRefs:[],
      attributionRefs:[{subjectId:sourceAuthor.identity.subjectId,source:otherRef}],externalReferences:[],redactionConfirmed:true};
    const roomId=randomUUID(),path='/v2/chat/rooms/'+roomId;
    await author.runtime.chat.create({roomId,operationId:randomUUID(),title:'[本地合成] 方法来源片段'},{confirmed:true});
    const room=await author.runtime.api.call(path+'/read',{}),invite=await author.runtime.chat.propose(roomId,{decisionId:randomUUID(),expectedRevision:room.revision,action:'invite',targetSubjectId:sourceAuthor.identity.subjectId},{confirmed:true});
    await sourceAuthor.runtime.api.call(path+'/accept',{decisionId:invite.decisionId});
    const message=await sourceAuthor.runtime.chat.send(roomId,'[本地合成] 准确消息片段：逐项写明对象和当前阅读范围。',{confirmed:true});
    return{f,now,advance:seconds=>{offset+=seconds;f.clock.now=now();},requests,hooks,people,author,sourceAuthor,own,other,otherRef,permission,payload,roomId,message,
      close:async()=>{people.forEach(who=>who.runtime.close());await f.close();}};
  }catch(error){people.forEach(who=>who.runtime.close());await f.close();throw error;}
}
