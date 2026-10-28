// Only an ephemeral loopback test database is accepted. No user config is read.
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {CommunityForumV1} from '../../packages/galaxy-official/src/community/community-forum-v1.mjs';
import {PublicWriteService} from '../../packages/galaxy-official/src/publishing/public-writes.mjs';
import {bindForumIds} from '../../packages/galaxy-official/src/shared/community-forum-ids-v1.mjs';
import {p14EmptyControls} from '../../packages/galaxy-official/src/shared/p14-rules-schema.mjs';
import {p14Evaluate} from '../../packages/galaxy-official/src/operations/rules/evaluator.mjs';
import {ForumAttachmentsV1Service} from '../../packages/galaxy-official/src/community/forum-attachments-v1.mjs';
import {CommunityForumGovernanceV1} from '../../packages/galaxy-official/src/community/community-forum-governance-v1.mjs';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {governanceConfigSchema} from '../../packages/galaxy-official/src/governance/governance-config.mjs';
import {governanceConfigurationHash,signGovernanceChange,verifyGovernanceReview} from '../../packages/galaxy-official/src/operations/governance-review.mjs';
import {CompactSign} from '../../packages/galaxy-official/node_modules/jose/dist/webapi/index.js';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
import {cleanupForumWithin,prepareForumDeletionWithin,minimizeForumDeletionWithin} from '../../packages/galaxy-official/src/operations/community-forum-retention-v1.mjs';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.protocol!=='postgres:'||address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const pool=new pg.Pool({connectionString:address.href,max:2}),endpoint='https://go-community.example.invalid',now=()=>2000000000;
const accounts={async runAuthorized(actor,scope,operation){const db=await pool.connect();try{await db.query('BEGIN');const result=await operation(db,{kind:'official-account',accountId:actor.accountId},actor);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}},async availableWithin(db,actor){return(await db.query(`SELECT a.*,p.display_name,p.avatar_key,p.subject_type FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`,[actor.accountId,endpoint])).rows;},async resolveWithin(db,actor){const r=(await this.availableWithin(db,actor))[0];if(!r)throw Error('fixture account unavailable');return r;}};
const access={db:pool,endpoint,now},forum=new CommunityForumV1(access,null,{accounts,publicWrites:new PublicWriteService(access,accounts)});
forum.attachments=new ForumAttachmentsV1Service({forum});
const governance=new CommunityForumGovernanceV1(access,null,forum,{accounts});
try{
 const command=process.argv[2];
 if(command==='governance-astral-fixture'){
  const cases=[];
  for(const count of [100,101])for(const suffix of ['', '\ud800']){
   const configuration={conformanceSuitePins:[{name:' 🚀'.trim().repeat(count)+suffix,version:'1',sha256:'a'.repeat(64),source:'https://docs.example.invalid/'+ '🚀'.repeat(200),notBefore:1,notAfter:2,revoked:false}]};
   let accepted=true,normalized=null,hash=null;try{normalized=governanceConfigSchema.parse(configuration);hash=governanceConfigurationHash(configuration);}catch{accepted=false;}cases.push({configuration,accepted,normalized,hash});
  }
  console.log(JSON.stringify(cases));
 }else if(command==='community-policy-fixture'){
  const custom={invitationCooldownDays:11,promotionDays:23,normal:{invitation:19,comment:99,task:9},new:{comment:7,task:3,invitation:2},version:'自定community\u2028/2'};const defaults=new PublicWriteService(access,accounts).policy,parsed=new PublicWriteService(access,accounts,custom).policy;console.log(JSON.stringify({defaults,defaultHash:digest(JSON.stringify(defaults)),custom,normalized:parsed,customHash:digest(JSON.stringify(parsed))}));
 }else if(command==='governance-fixture'){
  const at=2000000000,a='GUID'+'A'.repeat(28),b='GUID'+'B'.repeat(28),c='GUID'+'C'.repeat(28);
  const configuration={experienceReviewers:[{subjectId:a,capabilityIds:['code/review'],kinds:['external-work','challenge'],scope:'\uFEFF  原核验范围  \uFEFF',notBefore:at-20,notAfter:at+10000,authorityReference:' 原核验来源 '}],auditReaderIds:[a,b],auditReviewerIds:[c],builderAssessorIds:[b],moderatorIds:[a,c],conformanceSuitePins:[{name:' 原符合性 ',version:' 1.0 ',sha256:'a'.repeat(64),source:'https://docs.example.invalid/suite?',notBefore:at-20,notAfter:at+10000,revoked:false}],honorRules:[{sourceProfile:'facts-v2',id:'contributors',version:'1.2',title:' 原荣誉\u2028🚀\ud800 ',capabilityId:'code/review',communityId:'galaxy',kind:'open-contributor',members:[a,b],notBefore:at-20,notAfter:at+10000,windowFrom:at-1000,windowUntil:at+1000,minAcceptedCases:2,minProofs:0,repositories:[]}],qualificationPolicies:[{id:'code-review',version:'1.0',capabilityId:'code/review',title:' 原资格 ',collaboration:'basic-bounty',notBefore:at-20,notAfter:at+10000,minProofs:1,minAcceptedCollaborations:1,historyWindowSeconds:31536000,requireCiSuccess:true,repositories:[{owner:'galaxy-team',repository:'core.go'}]}]};
  const request=generateKeyPairSync('ed25519'),review=generateKeyPairSync('ed25519'),pin=(kid,key)=>({kid,publicKeyPem:key.export({format:'pem',type:'spki'}),notBefore:at-100,notAfter:at+10000,revoked:false}),authorities={version:1,endpoint,requesters:[pin('request',request.publicKey)],reviewers:[pin('review',review.publicKey)]};
  const change={version:1,changeId:randomUUID(),endpoint,revision:7,previousConfigurationSha256:'0'.repeat(64),configurationSha256:governanceConfigurationHash(configuration),requesterKid:'request',reviewerKid:'review',issuedAt:at-10,expiresAt:at+3600},envelope={version:1,requestSignature:await signGovernanceChange(change,{privateKey:request.privateKey,kid:'request'}),reviewSignature:await signGovernanceChange(change,{privateKey:review.privateKey,kid:'review'})};
  const checked=await verifyGovernanceReview(configuration,envelope,authorities,{endpoint,now:at}),variants=[];
  async function variant(name,config,envelopeInput,authorityInput,now=at,target=endpoint){let accepted=true;try{await verifyGovernanceReview(config,envelopeInput,authorityInput,{endpoint:target,now});}catch{accepted=false;}variants.push({name,configuration:config,envelope:envelopeInput,authorities:authorityInput,now,endpoint:target,accepted});}
  const sameAuthorities=structuredClone(authorities);sameAuthorities.reviewers[0].publicKeyPem=authorities.requesters[0].publicKeyPem;
  await variant('same-independent-key',configuration,{...envelope,reviewSignature:await signGovernanceChange(change,{privateKey:request.privateKey,kid:'review'})},sameAuthorities);
  await variant('different-signed-document',configuration,{...envelope,reviewSignature:await signGovernanceChange({...change,revision:8},{privateKey:review.privateKey,kid:'review'})},authorities);
  await variant('current-config-changed',{...configuration,moderatorIds:[b]},envelope,authorities);
  await variant('expired-change',configuration,envelope,authorities,at+3600);
  const revoked=structuredClone(authorities);revoked.reviewers[0].revoked=true;await variant('revoked-review-pin',configuration,envelope,revoked);
  const duplicate=structuredClone(authorities);duplicate.reviewers.push(duplicate.reviewers[0]);await variant('duplicate-pin-id',configuration,envelope,duplicate);
  await variant('foreign-endpoint',configuration,envelope,authorities,at,'https://foreign.example.invalid');
  const extra=await new CompactSign(new TextEncoder().encode(JSON.stringify(change))).setProtectedHeader({alg:'EdDSA',typ:'galaxy-governance-change+jws',kid:'review',extra:true}).sign(review.privateKey);await variant('extra-protected-header',configuration,{...envelope,reviewSignature:extra},authorities);
  const tooLong={...change,expiresAt:at+10001};await variant('change-beyond-pin',configuration,{...envelope,requestSignature:await signGovernanceChange(tooLong,{privateKey:request.privateKey,kid:'request'}),reviewSignature:await signGovernanceChange(tooLong,{privateKey:review.privateKey,kid:'review'})},authorities);
  const malformed=structuredClone(configuration);malformed.honorRules[0].rankingEnabled=true;await variant('ranking-without-privacy-approval',malformed,envelope,authorities);
  for(const changeId of ['00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff']){const special={...change,changeId};await variant('original-special-uuid-'+changeId,configuration,{...envelope,requestSignature:await signGovernanceChange(special,{privateKey:request.privateKey,kid:'request'}),reviewSignature:await signGovernanceChange(special,{privateKey:review.privateKey,kid:'review'})},authorities);}
  console.log(JSON.stringify({endpoint,now:at,configuration,normalized:governanceConfigSchema.parse(configuration),configurationHash:change.configurationSha256,envelope,authorities,review:checked,variants,emptyHash:governanceConfigurationHash({}),explicitExperienceHash:governanceConfigurationHash({experienceReviewers:[]})}));
 }else if(command==='retention'){
  const input=JSON.parse(process.argv[3]);await migrate(pool,{roles:['api','worker']});const db=await pool.connect();try{await db.query('BEGIN');if(input.kind==='cleanup')await db.query('SET LOCAL ROLE galaxy_evidence_worker');let result;
   if(input.kind==='cleanup')result=await cleanupForumWithin(db,input.at,{endpoint});else if(input.kind==='prepare')result=await prepareForumDeletionWithin(db,{subjectId:input.subjectId,at:input.at,retainedUntil:input.retainedUntil});else result=await minimizeForumDeletionWithin(db,{subjectId:input.subjectId,at:input.at,retainedUntil:input.retainedUntil});
   const snapshot=(await db.query(`SELECT jsonb_build_object('events',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'payload',payload_text,'erased',extract(epoch from erased_at)::bigint) ORDER BY id) FROM forum_events_v1),'posts',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'state',state,'current',current_version_id) ORDER BY id) FROM forum_posts_v1),'replies',(SELECT jsonb_agg(jsonb_build_object('id',id,'subject',subject_id,'account',account_id,'state',state) ORDER BY id) FROM forum_replies_v1),'erasures',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'key',object_key,'subject',subject_id,'account',account_id,'hash',original_payload_hash,'reason',reason,'policy',policy_version,'at',extract(epoch from erased_at)::bigint,'until',extract(epoch from retained_until)::bigint) ORDER BY table_name,object_key) FROM lifecycle_erasure_records)) snapshot`)).rows[0].snapshot;
   console.log(JSON.stringify({result,snapshot}));await db.query('ROLLBACK');}finally{db.release();}
 }else if(command==='identity-server'){
  const {communityForumFixture}=await import('../../packages/galaxy-official/test/community-forum-fixture.mjs');
  const f=await communityForumFixture({database:pool,endpoint});
  try{
   await f.login(f.owner,'go-community-owner');await f.login(f.responder,'go-community-reporter');
   if(process.argv[3]){const {join,isAbsolute}=await import('node:path'),{readFile,writeFile,unlink}=await import('node:fs/promises');const dir=process.argv[3];if(!isAbsolute(dir))throw Error('absolute isolated store required');const name=key=>join(dir,Buffer.from(key).toString('base64url'));f.owner.forumAttachments.store={keyId:'isolated-forum-key',put:async({key,bytes})=>writeFile(name(key),bytes),get:async({key})=>readFile(name(key)),erase:async({key})=>unlink(name(key))};f.owner.forumAttachments.scanner={scan:async()=>({state:'clean',checkedAt:f.clock.now})};}
   await pool.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3) ON CONFLICT DO NOTHING`,[endpoint,JSON.stringify(p14EmptyControls),new Date(f.clock.now*1000)]);
   const post=await f.post({publishedUntil:f.clock.now+3600}),reply=await f.reply(post,{publishedUntil:f.clock.now+1800});
   const envelope=async(who,kind,p,overrides={})=>{const payload=await f.prepare(who,kind,p);return{payload,...await f.authorize(who,kind,payload,overrides)}};
   const report=await envelope(f.responder,'create-report',{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:post.postId,versionId:post.versionId},category:'privacy',summary:'原私有举报陈述。'},{viewers:[f.moderator.actor.subjectId]});
   const event=(version,kind,extra={})=>({schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:report.payload.reportId,expectedReportVersion:version,kind,...extra});
   const supplement=await envelope(f.responder,'supplement',event(1,'supplement',{summary:'补充原举报材料。'}),{viewers:[f.moderator.actor.subjectId]});
   const recipients=[f.owner.actor.subjectId,f.responder.actor.subjectId];
   const resolve=await envelope(f.moderator,'resolve',event(2,'resolve',{resolution:'accepted',reason:'独立处理决定。',effect:{kind:'hide-version',until:f.clock.now+1200}}),{viewers:recipients});
   const appeal=await envelope(f.owner,'appeal',event(3,'appeal',{summary:'原受影响作者提出申诉。'}),{viewers:[f.moderator.actor.subjectId]});
   const dismiss=await envelope(f.moderator,'resolve',event(4,'resolve',{resolution:'dismissed',reason:'独立复查解除原处理。',effect:null}),{viewers:recipients});
   const withdrawReport=await envelope(f.responder,'withdraw-report',event(5,'withdraw'));
   const section=await envelope(f.owner,'create-section',{schemaVersion:1,operationId:randomUUID(),sectionId:randomUUID(),expectedVersion:0,title:'签名分区',theme:'原本人维护分区',description:'原范围。',audience:{read:{kind:'everyone'},participate:{kind:'everyone'}}});
   const classify=await envelope(f.moderator,'classify-section',{schemaVersion:1,operationId:randomUUID(),sectionId:section.payload.sectionId,expectedVersion:1,category:'technology'});
   const version=await envelope(f.owner,'publish-version',{...post,operationId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:1,title:'原ID第二版'});
   const withdrawVersion=await envelope(f.owner,'withdraw-version',{schemaVersion:1,operationId:randomUUID(),postId:post.postId,versionId:version.payload.versionId,expectedHeadVersion:2});
   const withdrawReply=await envelope(f.responder,'withdraw-reply',{schemaVersion:1,operationId:randomUUID(),replyId:reply.replyId,expectedRevision:1});
   const withdrawPost=await envelope(f.owner,'withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:post.postId,expectedHeadVersion:3});
   const ownerAccount=(await f.owner.communityAccounts.resolveWithin(pool,f.owner.actor)).id,reporterAccount=(await f.owner.communityAccounts.resolveWithin(pool,f.responder.actor)).id;
   const fileText='原论坛附件字节\n',fileId=randomUUID(),fileHash=createHash('sha256').update(fileText).digest('hex'),filePost=await envelope(f.owner,'create-post',{...post,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,attachments:[{id:fileId,sha256:fileHash}]}),fileWithdraw=await envelope(f.owner,'withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:filePost.payload.postId,expectedHeadVersion:1});
   console.log(JSON.stringify({origin:f.origin,endpoint,now:f.clock.now,issuer:f.issuer.issuer,owner:{subjectId:f.owner.actor.subjectId,token:f.owner.credential,accountId:ownerAccount},reporter:{subjectId:f.responder.actor.subjectId,token:f.responder.credential,accountId:reporterAccount},moderator:{subjectId:f.moderator.actor.subjectId,token:f.moderator.credential},file:{id:fileId,hash:fileHash,text:fileText,post:filePost,withdraw:fileWithdraw},post:await envelope(f.owner,'create-post',post),reply:await envelope(f.responder,'create-reply',reply),report,supplement,resolve,appeal,dismiss,withdrawReport,section,classify,version,withdrawVersion,withdrawReply,withdrawPost}));
   await new Promise(resolve=>process.stdin.once('data',resolve));
  }finally{await f.close();}
 }else if(command==='setup'){
  await migrate(pool);await pool.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`,[endpoint,JSON.stringify(p14EmptyControls),new Date(now()*1000)]);const ids=[];
  for(const name of ['社区甲','社区乙']){const id=randomUUID();ids.push(id);await pool.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,$2,'https://login.example.invalid',$1::text,'external-account',$3,$3)`,[id,endpoint,new Date(now()*1000)]);await pool.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,query_enabled,updated_at) VALUES($1,'person',$2,false,$3)`,[id,name,new Date(now()*1000)]);}
  const accountId=ids[0],attachmentId=randomUUID(),sha256='f'.repeat(64);await pool.query(`INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_result) VALUES($1,$2,$3,'原附件.txt','text/plain',18,$3,$4,'fixture-key','available',$5,$6,$5,$6,'{"state":"clean"}')`,[attachmentId,accountId,sha256,'forum-attachments/'+attachmentId,new Date(now()*1000),new Date((now()+3600)*1000)]);
  const payload=await bindForumIds('create-post','account:'+accountId,{schemaVersion:1,operationId:randomUUID(),accountId,postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,title:'银河社区迁移',body:'原帖文字与权限保持。',links:[],attachments:[{id:attachmentId,sha256}],topic:'technology',publishedUntil:now()+3600});
  console.log(JSON.stringify({endpoint,accounts:ids,payload,policyHash:forum.policyHash}));
 }else if(command==='read'){
  const [post,version,reply,account]=process.argv.slice(3),actor={kind:'official-account',accountId:account,endpoint};
  console.log(JSON.stringify({post:await forum.getPost(post,actor),version:await forum.getVersion(post,version,actor),reply:reply==='-'?null:await forum.getReply(reply,actor),query:await forum.query({},actor),replies:await forum.replies({postId:post,postVersionId:version},actor),owned:await forum.ownedPost(actor,post),ownedList:await forum.owned(actor,{}),publicAccount:await forum.publicForAccount(account,{}),quotas:await forum.budget.status(actor),notifications:await forum.notifications(actor),sections:await forum.sections.query(actor),topics:forum.topics(),accessOptions:await forum.accessRules.options()}));
 }else if(command==='task-source'){
  const {TaskMaterialServiceV1}=await import('../../packages/galaxy-official/src/tasks/v2/material-v1.mjs');const state=await new TaskMaterialServiceV1(access,null,{forum}).sourceWithin(pool,JSON.parse(process.argv[3]),{ownerId:process.argv[4]||null,lock:process.argv[5]!=='false'});if(state.row)for(const [key,value]of Object.entries(state.row))if(value instanceof Date)state.row[key]=value.toISOString();console.log(JSON.stringify(state));
 }else if(command==='permission-export'){
  const [id,viewerId,payloadHash,visibility]=process.argv.slice(3);const state=await forum.permissions.statusWithin(pool,id,{viewerId,payloadHash,...(visibility?{visibility}:{})});console.log(JSON.stringify({allowed:state.allowed}));
 }else if(command==='bind'){
  const [kind,account,payload]=process.argv.slice(3);console.log(JSON.stringify(await bindForumIds(kind,'account:'+account,JSON.parse(payload))));
 }else if(command==='reports-read'){
  const [accountId,reportId]=process.argv.slice(3),actor={kind:'official-account',accountId,endpoint};console.log(JSON.stringify({detail:await governance.get(actor,reportId),query:await governance.query(actor,{}),affected:await governance.affected(actor,{}),config:await governance.config(actor,{})}));
 }else if(command==='rules'){
  const [policy,facts]=process.argv.slice(3);console.log(JSON.stringify(p14Evaluate(JSON.parse(policy),JSON.parse(facts))));
 }else if(command==='publish'){
  const [account,payloadJson]=process.argv.slice(3);console.log(JSON.stringify(await forum.publish({kind:'official-account',accountId:account},{payloadJson})));
 }else throw Error('fixture command required');
}finally{await pool.end();}


