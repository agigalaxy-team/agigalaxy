import pg from 'pg';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migrate} from "../src/infrastructure/database.mjs";
import {createOperationsJobs} from "../src/operations/jobs/service.mjs";
import {ContentPublications} from "../src/publishing/content-publications.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {CommunityAccountRegistry} from "../src/accounts/community-accounts.mjs";
import {PublicWriteService,defaultCommunityPolicy} from "../src/publishing/public-writes.mjs";
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {CommunityForumGovernanceV1} from "../src/community/community-forum-governance-v1.mjs";
import {ForumAttachmentsV1Service} from "../src/community/forum-attachments-v1.mjs";
import {OperationsCommunityService} from "../src/operations/community/service.mjs";
import {OperationsFilesService} from "../src/operations/files/service.mjs";
import {OperationsProductRules,createOperationsPolicyRuntime} from "../src/operations/rules/product-rules.mjs";
import {apiOperationsPolicyConsumers} from "../src/operations/rules/policy-consumers.mjs";
import {OperationsNotices,createOperationsNoticeWorker} from "../src/operations/messaging/notices.mjs";
import {OperationsRetention,createOperationsRetentionWorker} from "../src/operations/retention/service.mjs";
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';

// Default: the original publication/role scenario. --business: schema 96/97
// business grants and bounded domain workers, without repeating publication.
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--business')||args.length>1)throw Error('Usage: check-operations-postgres.mjs [--business]');
const business=args.includes('--business');
const connectionString=process.env.GALAXY_OPERATIONS_STAGE_DATABASE_URL;
let target;
try{target=new URL(connectionString);}catch{throw Error('Dedicated operations stage database URL required');}
if(!['postgres:','postgresql:'].includes(target.protocol)||target.pathname!=='/galaxy_business_stage')throw Error('Dedicated operations stage database required');
const pool=new pg.Pool({connectionString,max:2});
try{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'galaxy_business_stage');
  const version=await migrate(pool,{roles:['api','worker','content-publisher']});
  const client=await pool.connect();
  const db={query:(...args)=>client.query(...args),connect:async()=>({query:(...args)=>client.query(...args),release(){}})};
  let queue;
  try{
    await asRole(db,'galaxy_api');
    queue=createOperationsJobs({db,supervise:false});await queue.start();
    const result=business?await checkBusiness(db,queue):await checkPublication(db,queue);
    process.stdout.write(JSON.stringify({nativePostgres:true,schema:version,mode:business?'business':'publication',...result})+'\n');
  }finally{
    try{await queue?.stop();}finally{
      try{await client.query('RESET ROLE');}finally{client.release();}
    }
  }
}finally{await pool.end();}

async function asRole(db,role){
  assert.ok(['galaxy_api','galaxy_evidence_worker','galaxy_content_publisher'].includes(role));
  await db.query('RESET ROLE');await db.query('SET ROLE '+role);
  assert.equal((await db.query('SELECT current_user AS name')).rows[0].name,role);
}

async function checkPublication(db,queue){
  await asRole(db,'galaxy_api');
  const actor={kind:'business-operator',role:'administrator',operatorId:'integration-operator',endpoint:'https://operations-stage.invalid'};
  const publications=new ContentPublications({db,endpoint:actor.endpoint,jobs:queue});
  const operationId=randomUUID(),snapshot={version:1,settings:{siteTitle:'Integration',description:'',footerLinks:[]},pages:[],media:[]};
  const result=await publications.request(actor,{operationId,snapshot});assert.equal(result.publication.id,operationId);
  assert.equal((await publications.list(actor)).items.some(row=>row.id===operationId),true);
  await db.query('SELECT 1 FROM operations_operator_principals_v1 LIMIT 1');
  await db.query('SELECT 1 FROM account_chat_reports_v1 LIMIT 1');
  await asRole(db,'galaxy_evidence_worker');await db.query('SELECT 1 FROM galaxy_jobs.job LIMIT 1');
  await asRole(db,'galaxy_content_publisher');await db.query('SELECT 1 FROM site_publications_v1 LIMIT 1');
  await assert.rejects(async()=>db.query('SELECT 1 FROM community_accounts LIMIT 1'),error=>error.code==='42501');
  return {apiQueueAndPublication:true,workerQueue:true,publisherCannotReadBusinessAccounts:true};
}

async function checkBusiness(db,jobs){
  const runId=randomUUID(),endpoint='https://'+runId+'.operations-stage.invalid',issuer='https://management-stage.invalid/realms/galaxy-operations';
  const clock=Math.floor(Date.now()/1000),now=()=>clock,stamp=seconds=>new Date(seconds*1000).toISOString();
  const actor={kind:'business-operator',operatorId:'stage-'+runId,role:'administrator',endpoint,httpRequestId:randomUUID()};
  const people=Array.from({length:101},()=>({kind:'official-account',accountId:randomUUID(),endpoint}));
  const archiveIds=Array.from({length:102},()=>randomUUID());
  let currentRole='administrator',authorizationChecks=0;
  const businessAdmin=new BusinessAdminService({db,endpoint,now,operatorAuthorization:async(operator,{db:within})=>{
    // Actual worker-role SQL, followed by a controlled current management
    // directory. This is deliberately not a live Keycloak login assertion.
    assert.equal((await within.query('SELECT current_user AS name')).rows[0].name,'galaxy_evidence_worker');
    authorizationChecks++;
    const principal=(await within.query(`SELECT issuer,external_subject FROM operations_operator_principals_v1
      WHERE operator_id=$1 AND endpoint=$2`,[operator.operatorId,endpoint])).rows[0];
    return principal?.issuer===issuer&&principal.external_subject===runId?currentRole:null;
  }});
  const access={db,endpoint,now},accounts=new CommunityAccountRegistry(access),publicWrites=new PublicWriteService(access,accounts);
  const forum=new CommunityForumV1(access,null,{accounts,publicWrites}),governance=new CommunityForumGovernanceV1(access,null,forum,{accounts});
  // The normal service constructor enables the actual per-case disclosure.
  new OperationsCommunityService({businessAdmin,forum,governance,now});
  const noStorage=()=>{throw Error('No storage or scanner I/O belongs to this SQL role fixture');};
  const forumFiles=new ForumAttachmentsV1Service({forum,store:{keyId:'stage-only',put:noStorage,get:noStorage,erase:noStorage},scanner:{scan:noStorage}});
  const files=new OperationsFilesService({businessAdmin,forumAttachments:forumFiles,now});
  const rules=new OperationsProductRules({db,endpoint,businessAdmin,now});
  const notices=new OperationsNotices({db,endpoint,businessAdmin,accounts,jobs,now});
  const retention=new OperationsRetention({db,endpoint,businessAdmin,jobs,now});
  const noticeWorker=createOperationsNoticeWorker({notices}),retentionWorker=createOperationsRetentionWorker({retention});
  const addAccounts=async ids=>db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    SELECT id,$2,'https://business-stage.invalid/realms/galaxy',id::text,'email',$3,$3 FROM unnest($1::uuid[]) id`,[ids,endpoint,stamp(clock)]);
  const delivered=async noticeId=>Number((await db.query('SELECT count(*) AS n FROM account_operations_notices_v1 WHERE notice_id=$1 AND delivered_at IS NOT NULL',[noticeId])).rows[0].n);
  const archivesRemaining=async()=>Number((await db.query('SELECT count(id) AS n FROM private_conversation_archives_v1 WHERE id=ANY($1::uuid[])',[archiveIds])).rows[0].n);
  try{
    await db.query('RESET ROLE');
    // This cleanup command is database-wide by design. Do not let a stage run
    // erase another fixture's previously expired archive copies.
    assert.equal(Number((await db.query('SELECT count(id) AS n FROM private_conversation_archives_v1 WHERE expires_at<=$1',[stamp(clock)])).rows[0].n),0,
      'Business stage requires no pre-existing expired archives');
    await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
      VALUES($1,$2,$3,$4,'Synthetic stage operator',$5,$5)`,[actor.operatorId,endpoint,issuer,runId,stamp(clock)]);
    await addAccounts(people.map(person=>person.accountId));
    // Owner-only synthetic setup; it is not evidence of API or worker grants.
    await db.query(`INSERT INTO private_conversation_archives_v1(id,account_id,title,selection,state,byte_length,chunk_count,created_at,updated_at,expires_at)
      SELECT id,$2,'Synthetic retained copy',jsonb_build_object('scopeId',id,'workspaceId',NULL,'sessionIds',jsonb_build_array('stage-session')),
        'ready',1,1,$3,$3,CASE WHEN ordinal<=101 THEN $4::timestamptz ELSE $5::timestamptz END
      FROM unnest($1::uuid[]) WITH ORDINALITY AS records(id,ordinal)`,[archiveIds,people[0].accountId,stamp(clock),stamp(clock-60),stamp(clock+86400)]);
    await db.query(`INSERT INTO private_conversation_chunks_v1(archive_id,sequence,content,byte_length)
      SELECT id,0,'x',1 FROM unnest($1::uuid[]) id`,[archiveIds]);

    await asRole(db,'galaxy_api');
    await rules.bootstrap({'community-quota':defaultCommunityPolicy});
    const policy=structuredClone(defaultCommunityPolicy);policy.new.comment++;
    const ruleInput={operationId:randomUUID(),expectedVersion:1,policy};
    assert.equal((await rules.save(actor,'community-quota',ruleInput)).rule.version,2);
    assert.equal((await rules.save(actor,'community-quota',ruleInput)).replayed,true);
    const policyRuntime=createOperationsPolicyRuntime({rules,component:'api',consumers:{
      'community-quota':apiOperationsPolicyConsumers({publicWrites})['community-quota'],
    }});
    assert.equal((await policyRuntime.refresh()).items[0].adoptedVersion,2);
    assert.equal((await publicWrites.status(people[0])).quotas.find(quota=>quota.category==='comment').limit,policy.new.comment);

    const post=await bindForumIds('create-post','account:'+people[1].accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),accountId:people[1].accountId,
      expectedHeadVersion:0,title:'Synthetic stage source',body:'Synthetic public source',links:[],publishedUntil:clock+3600,
      audience:{read:{kind:'everyone'},participate:{kind:'accounts'}}});
    await forum.publish(people[1],{payloadJson:JSON.stringify(post)});
    const report=await bindForumIds('create-report','account:'+people[0].accountId,{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),accountId:people[0].accountId,
      target:{kind:'post-version',postId:post.postId,versionId:post.versionId},category:'other',summary:'Synthetic selected report narrative'});
    await governance.report(people[0],{payloadJson:JSON.stringify(report)});
    assert.equal((await db.query('SELECT operations_disclosed FROM forum_reports_v1 WHERE id=$1',[report.reportId])).rows[0].operations_disclosed,true);

    const fileId=randomUUID();
    await forumFiles.prepare(people[0],{attachmentId:fileId,name:'synthetic.txt',mediaType:'text/plain',size:1,sha256:'0'.repeat(64)});
    await db.query('RESET ROLE');
    // No bytes or scanner are involved: seed only this fixture's pending state.
    await db.query("UPDATE forum_attachments_v1 SET state='scan-pending',uploaded_at=$2,expires_at=$3,last_error='attachment_scan_failed' WHERE id=$1",[fileId,stamp(clock),stamp(clock+3600)]);
    await asRole(db,'galaxy_api');
    const before=await files.get(actor,'forum',fileId),retry={operationId:randomUUID(),kind:'scan',expectedVersion:before.version,reason:'Synthetic bounded retry'};
    assert.equal(before.canRetryScan,true);
    assert.equal((await files.retry(actor,'forum',fileId,retry)).state,'scheduled');
    assert.equal((await files.retry(actor,'forum',fileId,retry)).replayed,true);
    assert.equal((await db.query('SELECT operations_retry_revision FROM forum_attachments_v1 WHERE id=$1',[fileId])).rows[0].operations_retry_revision,1);
    // The second attachment table has the same new column grant. No unrelated
    // chat/file fixture or private body is needed to exercise that statement.
    await db.query('UPDATE chat_attachments SET operations_retry_revision=operations_retry_revision+1 WHERE false');

    const created=await notices.create(actor,{operationId:randomUUID(),content:{purpose:'service-update',title:'Synthetic stage notice',body:'A synthetic service notice',href:'/status/',
      audience:{kind:'all-accounts'},expiresAt:stamp(clock+3600)}});
    const published=await notices.publish(actor,created.notice.id,{operationId:randomUUID(),expectedVersion:created.notice.version});
    assert.equal(published.notice.delivery.audienceCount,101);
    assert.equal((await jobs.get('account-notice',published.notice.jobId)).resourceId,published.notice.id);
    const requested=await retention.request(actor,{operationId:randomUUID(),target:'private-conversation-archives'});
    assert.equal((await jobs.get('retention-cleanup',requested.run.jobId)).resourceId,requested.run.id);
    const lateAccount=randomUUID();await addAccounts([lateAccount]);

    await asRole(db,'galaxy_evidence_worker');
    assert.equal((await rules.currentWithin(db,'community-quota')).version,2);
    currentRole='reader';
    await assert.rejects(async()=>noticeWorker.execute({noticeId:published.notice.id}),error=>error.code==='business_admin_denied');
    assert.equal(await delivered(published.notice.id),0);
    await assert.rejects(async()=>retentionWorker.execute({runId:requested.run.id}),error=>error.code==='business_admin_denied');
    assert.equal(await archivesRemaining(),102);
    currentRole='administrator';
    const firstDelivery=await noticeWorker.execute({noticeId:published.notice.id});
    assert.deepEqual(firstDelivery,{state:'delivering',deliveredCount:100});
    assert.equal(await delivered(published.notice.id),100);
    assert.deepEqual(await noticeWorker.execute({noticeId:published.notice.id}),{state:'delivered',deliveredCount:1});
    assert.equal(await delivered(published.notice.id),101);
    assert.equal((await db.query('SELECT 1 FROM account_operations_notices_v1 WHERE notice_id=$1 AND account_id=$2',[published.notice.id,lateAccount])).rows.length,0);
    assert.deepEqual(await noticeWorker.execute({noticeId:published.notice.id}),{state:'delivered'});
    const cleaned=await retentionWorker.execute({runId:requested.run.id});
    assert.deepEqual(cleaned,{state:'completed',result:{privateConversationArchives:100}});
    assert.equal(await archivesRemaining(),2);
    assert.deepEqual(await retentionWorker.execute({runId:requested.run.id}),{state:'completed'});
    assert.equal(await archivesRemaining(),2);
    assert.ok(authorizationChecks>=5);

    const denied=async sql=>assert.rejects(async()=>db.query(sql),error=>error.code==='42501');
    await denied('INSERT INTO consents SELECT * FROM consents WHERE false');
    await denied('INSERT INTO proofs SELECT * FROM proofs WHERE false');
    await denied("UPDATE project_events_v2 SET payload_text='' WHERE false");
    await denied("UPDATE capsule_events SET payload_text='' WHERE false");
    await denied("UPDATE operations_operator_principals_v1 SET display_name='Not permitted' WHERE false");
    await denied('INSERT INTO operations_operator_principals_v1 SELECT * FROM operations_operator_principals_v1 WHERE false');
    await denied('SELECT content FROM private_conversation_chunks_v1 LIMIT 1');

    await db.query('RESET ROLE');
    const remaining=(await db.query('SELECT id FROM private_conversation_archives_v1 WHERE id=ANY($1::uuid[])',[archiveIds])).rows;
    assert.equal(remaining.some(row=>row.id===archiveIds.at(-1)),true);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM private_conversation_deletions_v1 WHERE archive_id=ANY($1::uuid[]) AND reason=\'expired\'',[archiveIds])).rows[0].n),100);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM private_conversation_chunks_v1 WHERE archive_id=ANY($1::uuid[])',[archiveIds])).rows[0].n),2);
    return {apiVersionedRulesAndAdoption:true,apiReportDisclosure:true,apiForumFileRetry:true,apiChatRetryColumnGrant:true,
      apiNoticeAndRetentionEnqueued:true,workerStoredPrincipalAndCurrentDirectoryRechecked:true,workerNoticeBatchLimit:100,workerRetentionBatchLimit:100,
      workerCannotWriteSigningRecords:true,workerCannotRewriteAuthorContent:true,workerCannotWriteOperatorPrincipals:true,workerCannotReadPrivateArchiveBody:true,
      directory:'controlled-stage-fixture',storageAndScannerExercised:false,queuePollingExercised:false};
  }finally{
    // Only this run's synthetic archive copies/tombstones are removed by the
    // fixture owner; other stage rows and the earlier publication proof remain.
    await db.query('RESET ROLE');
    await db.query('DELETE FROM private_conversation_archives_v1 WHERE id=ANY($1::uuid[])',[archiveIds]);
    await db.query('DELETE FROM private_conversation_deletions_v1 WHERE archive_id=ANY($1::uuid[])',[archiveIds]);
  }
}
