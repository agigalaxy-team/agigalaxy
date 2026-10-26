import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {AccessService} from "../src/security/access.mjs";
import {ChatService} from "../src/chat/service.mjs";
import {ChatAttachmentsService} from "../src/chat/chat-attachments.mjs";
import {CommunityAccountRegistry} from "../src/accounts/community-accounts.mjs";
import {PublicWriteService} from "../src/publishing/public-writes.mjs";
import {chatActorRef,isAccountChatRef} from "../src/chat/chat-actors.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';

// SQL authorization, quota and chat logic are real. This transport/store/scanner
// are explicit in-memory contracts; they do not stand in for Prosody/AV evidence.
export async function accountChatFixture({identityFixture=null,transport:providedTransport=null}={}){
 const db=identityFixture?.db??new PGlite();if(!identityFixture)await migrate(db);
 let clock=2000000000;
 const now=identityFixture?.now??(()=>clock),endpoint=identityFixture?.chat.access.endpoint??'https://chat.example.org';
 const access=identityFixture?.chat.access??new AccessService({db,endpoint,now,trustedKeys:new Map()});
 const provider={describe:()=>({issuer:'https://login.example.org',clientId:'synthetic-chat'})};
 const accounts=new CommunityAccountRegistry(access,[provider]),publicWrites=new PublicWriteService(access,accounts);
 const people=[];
 for(const [index,displayName]of ['甲','乙','丙'].entries()){
  const accountId=randomUUID(),stamp=new Date(now()*1000).toISOString();
  await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
   VALUES($1,$2,'https://login.example.org',$3,'external-account',$4,$4)`,[accountId,endpoint,'synthetic-'+index,stamp]);
  await db.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,query_enabled,updated_at) VALUES($1,'person',$2,$3,$4)`,[accountId,displayName,index!==1,stamp]);
  people.push({kind:'official-account',accountId,endpoint});
 }
 const messages=new Map(),rooms=new Map(),erased=new Set();
 const transport=providedTransport??{available:true,
  async project(input){rooms.set(input.roomId,input);},
  async send(input){if(!rooms.get(input.roomId)?.members.includes(input.subjectId)||erased.has(input.messageId))throw new ServiceError('chat_access_denied',403);messages.set(input.messageId,{...input,archiveId:input.messageId,revision:1});return{archiveId:input.messageId};},
  async read(input){if(!rooms.get(input.roomId)?.members.includes(input.subjectId))throw new ServiceError('chat_access_denied',403);return input.ids.map(id=>messages.get(id)).filter(Boolean);},
  async edit(input){const old=messages.get(input.messageId);if(!old||old.subjectId!==input.subjectId)throw new ServiceError('chat_access_denied',403);messages.set(input.messageId,{...old,text:input.text,revision:old.revision+1});return{revision:old.revision+1};},
  async exportOwn(input){return input.ids.map(id=>messages.get(id)).filter(row=>row?.subjectId===input.subjectId);},
  async erase(input){messages.delete(input.messageId);erased.add(input.messageId);return{archiveDeleted:true};}
 };
 const chat=new ChatService({db,access,accounts,transport,now,
  resolveControlParty:async(tx,ref)=>{if(isAccountChatRef(ref))return ref;try{return'account:'+(await accounts.resolveWithin(tx,{subjectId:ref})).id;}catch(error){if(error.code==='account_verification_required')return'subject:'+ref;throw error;}},
  requireAccountWithin:async(tx,actor)=>{const row=await accounts.resolveWithin(tx,actor);if(row.restricted_until&&Date.parse(row.restricted_until)>now()*1000)throw new ServiceError('community_restricted',403);return row;},
  consumeInviteWithin:(tx,actor,input)=>publicWrites.consumeWithin(tx,actor,{kind:'invitation',operationId:input.eventId,payloadHash:input.payloadHash,roomId:input.roomId,recipientId:input.recipientId}),
  markInviteRespondedWithin:(tx,input)=>publicWrites.markInvitationRespondedWithin(tx,input)});
 const objects=new Map(),files=new ChatAttachmentsService({chat,store:{keyId:'synthetic-only',put:async({key,bytes})=>{objects.set(key,Buffer.from(bytes));},get:async({key})=>objects.get(key),erase:async({key})=>{objects.delete(key);}},scanner:{scan:async()=>({state:'clean',engine:'explicit-contract',guaranteedSafe:false})}});chat.attachments=files;
 return{db,access,accounts,publicWrites,chat,files,transport,people,endpoint,now,advance:seconds=>{if(identityFixture)identityFixture.advance(seconds);else clock+=seconds;},close:()=>identityFixture?identityFixture.close():db.close(),digest:value=>createHash('sha256').update(value).digest('hex')};
}
export async function joinAccountConversation(f,creator,recipient,title='一段对话'){
 const roomId=randomUUID();await f.chat.create(creator,{roomId,operationId:randomUUID(),title});
 const decisionId=randomUUID();await f.chat.proposeDecision(creator,roomId,{decisionId,expectedRevision:1,action:'invite',targetSubjectId:chatActorRef(recipient)});
 await f.chat.acceptInvite(recipient,roomId,{decisionId});return roomId;
}
