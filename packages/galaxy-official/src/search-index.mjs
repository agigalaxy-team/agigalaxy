import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { ConsentReader } from './consent-reader.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { EvidenceService } from './evidence.mjs';
import { currentProofSource } from './domain/proof-source.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { builderSearchFields } from './shared/builders-schema.mjs';
import { searchSourceTypes } from './shared/search-schema.mjs';

const iso=seconds=>new Date(seconds*1000).toISOString();
const hiddenSource=error=>error instanceof ServiceError&&[401,403,404,409,410,422].includes(error.status);
const sources=`SELECT 'case' AS type,id,subject_id FROM cases UNION ALL SELECT 'history',id,subject_id FROM cases
  UNION ALL SELECT 'proof',id,subject_id FROM proofs UNION ALL SELECT 'capsule',id,subject_id FROM capsules
  UNION ALL SELECT type,id,owner_id FROM builders WHERE type IN ('worker','hub')`;

// This index supplies public candidates only. A serving API must re-read each
// source with its normal authorization and signature checks before returning it.
export class SearchIndex {
  constructor({db,endpoint,now=()=>Math.floor(Date.now()/1000),readGrant,maxAgeSeconds=60,jobs=null}){
    if(new URL(endpoint).origin!==endpoint||!Number.isInteger(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>60)throw new Error('Invalid search index configuration');
    Object.assign(this,{db,endpoint,now,readGrant,maxAgeSeconds,jobs});
  }
  async configure({enabled,rebuild=false}){
    if(typeof enabled!=='boolean')throw new Error('Explicit index state required');
    return transaction(this.db,async db=>{
      const previous=(await db.query('SELECT * FROM search_index_control WHERE singleton FOR UPDATE')).rows[0];
      if(previous&&previous.endpoint!==this.endpoint)throw new Error('Search index endpoint changed');
      rebuild=rebuild||(enabled&&!previous?.enabled);
      if(!previous)await db.query('INSERT INTO search_index_control(endpoint,enabled) VALUES($1,$2)',[this.endpoint,enabled]);
      else await db.query(`UPDATE search_index_control SET enabled=$1,scan_type=CASE WHEN $2 THEN '' ELSE scan_type END,
        scan_after=CASE WHEN $2 THEN NULL ELSE scan_after END,scan_complete=CASE WHEN $2 THEN false ELSE scan_complete END,updated_at=$3`,[enabled,rebuild,iso(this.now())]);
      if(!enabled)await db.query('DELETE FROM search_documents');
      return {enabled,rebuilding:enabled&&(!previous||rebuild||!previous.scan_complete)};
    });
  }
  async seedBatch(limit=100){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid index seed batch');
    return transaction(this.db,async db=>{
      const state=(await db.query('SELECT * FROM search_index_control WHERE singleton FOR UPDATE')).rows[0];
      if(!state?.enabled||state.endpoint!==this.endpoint||state.scan_complete)return {queued:0,complete:state?.scan_complete??false};
      const rows=(await db.query(`SELECT * FROM (${sources}) s WHERE type>$1 OR type=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY type,id LIMIT $3`,[state.scan_type,state.scan_after,limit])).rows;
      for(const row of rows)await db.query('SELECT public.galaxy_queue_search_source($1,$2,$3)',[row.type,row.id,row.subject_id]);
      const last=rows.at(-1);
      await db.query('UPDATE search_index_control SET scan_type=$1,scan_after=$2,scan_complete=$3,updated_at=$4',
        [last?.type??state.scan_type,last?.id??state.scan_after,rows.length<limit,iso(this.now())]);
      return {queued:rows.length,complete:rows.length<limit};
    });
  }
  async refreshExpired(){
    return transaction(this.db,async db=>{
      const rows=(await db.query('SELECT source_type,source_id,subject_id FROM search_documents WHERE valid_until<=$1 ORDER BY valid_until,source_type,source_id LIMIT 100',[iso(this.now())])).rows;
      for(const row of rows)await db.query('SELECT public.galaxy_queue_search_source($1,$2,$3)',[row.source_type,row.source_id,row.subject_id]);
      return {queued:rows.length};
    });
  }
  // A first-document failure is absent from search_documents, so refreshing
  // expired documents cannot find it. Retry only failed source generations;
  // neither a full rebuild nor deleting a still-valid projection is needed.
  async recoverFailed(limit=50){
    if(!this.jobs)return {queued:0,configured:false};
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid search recovery batch');
    return transaction(this.db,async db=>{
      if(!(await db.query('SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1',[this.endpoint])).rows.length)return {queued:0};
      const rows=(await db.query(`SELECT j.* FROM jobs j WHERE j.kind='search-index' AND j.state='failed' AND j.attempts>=5
        AND (j.search_recovery_generation<>COALESCE((j.payload->>'generation')::int,1) OR j.search_recovery_count<3)
        AND NOT EXISTS(SELECT 1 FROM search_documents d WHERE d.source_type=j.payload->>'sourceType'
          AND d.source_id=(j.payload->>'sourceId')::uuid AND d.valid_until>$1)
        AND NOT EXISTS(SELECT 1 FROM galaxy_jobs.job q WHERE q.name='search-recovery' AND q.state IN ('created','retry','active','cancelled')
          AND q.data->>'jobId'=j.id::text AND q.data->>'generation'=j.payload->>'generation')
        ORDER BY j.available_at,j.id LIMIT $2 FOR UPDATE OF j SKIP LOCKED`,[iso(this.now()),limit])).rows;
      let queued=0;
      for(const job of rows){
        const generation=job.payload.generation??1;
        const attempt=(job.search_recovery_generation===generation?job.search_recovery_count:0)+1;
        const start=Math.max(this.now(),Date.parse(job.available_at)/1000)+Math.min(3600,60*2**(attempt-1));
        const id=await this.jobs.enqueue('search-recovery',{jobId:job.id,subjectId:job.payload.subjectId,generation,recoveryAttempt:attempt},
          {key:`search:${job.id}:${generation}:${attempt}`,startAfter:iso(start),db});
        if(id){
          await db.query('UPDATE jobs SET search_recovery_generation=$2,search_recovery_count=$3,search_recovery_at=$4 WHERE id=$1',
            [job.id,generation,attempt,iso(start)]);
          queued++;
        }
      }
      return {queued};
    });
  }
  async recoverJob({jobId,generation,recoveryAttempt},{signal}={}){
    if(typeof jobId!=='string'||!Number.isInteger(generation)||generation<1||!Number.isInteger(recoveryAttempt)||recoveryAttempt<1||recoveryAttempt>3)
      throw new ServiceError('invalid_search_recovery',400);
    return transaction(this.db,async db=>{
      signal?.throwIfAborted();
      const job=(await db.query("SELECT * FROM jobs WHERE id=$1 AND kind='search-index' FOR UPDATE",[jobId])).rows[0];
      if(!job||job.state!=='failed'||job.attempts<5||job.payload.generation!==generation
        ||job.search_recovery_generation!==generation||job.search_recovery_count!==recoveryAttempt)return {state:'superseded'};
      if(!(await db.query('SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1',[this.endpoint])).rows.length)return {state:'disabled'};
      // Source/consent/binding checks still execute through build() on every
      // actual attempt. The recovery job is never evidence or read authority.
      await db.query("UPDATE jobs SET state='pending',attempts=0,lease_id=NULL,locked_until=NULL,available_at=$2 WHERE id=$1",[job.id,iso(this.now())]);
      return {state:'requeued',jobId:job.id,generation};
    });
  }
  async failures({after,limit=50}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||after!==undefined&&!/^[0-9a-f-]{36}$/i.test(after))throw new ServiceError('invalid_search_recovery',400);
    const rows=(await this.db.query(`SELECT j.id,j.payload,j.attempts,j.available_at,j.search_recovery_count,j.search_recovery_generation,j.search_recovery_at,
      EXISTS(SELECT 1 FROM galaxy_jobs.job q WHERE q.name='search-recovery' AND q.state IN ('created','retry','active')
        AND q.data->>'jobId'=j.id::text AND q.data->>'generation'=j.payload->>'generation') AS recovery_pending
      FROM jobs j WHERE j.kind='search-index' AND j.state='failed' AND ($1::uuid IS NULL OR j.id>$1) ORDER BY j.id LIMIT $2`,[after??null,limit+1])).rows;
    return {items:rows.slice(0,limit).map(j=>({jobId:j.id,sourceType:j.payload.sourceType,sourceId:j.payload.sourceId,
      subjectId:j.payload.subjectId,generation:j.payload.generation,attempts:j.attempts,
      recoveryAttempts:j.search_recovery_generation===j.payload.generation?j.search_recovery_count:0,
      automaticRecoveryPending:j.recovery_pending,
      automaticRecoveryExhausted:j.search_recovery_generation===j.payload.generation&&j.search_recovery_count>=3&&!j.recovery_pending,
      recoveryAt:j.search_recovery_at?new Date(j.search_recovery_at).toISOString():null})),nextAfter:rows.length>limit?rows[limit-1].id:null};
  }
  async failureStatus(jobId){
    if(typeof jobId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId))throw new ServiceError('invalid_search_recovery',400);
    const j=(await this.db.query(`SELECT j.id,j.state,j.payload,j.attempts,j.search_recovery_count,j.search_recovery_generation,j.search_recovery_at,
      EXISTS(SELECT 1 FROM galaxy_jobs.job q WHERE q.name='search-recovery' AND q.state IN ('created','retry','active')
        AND q.data->>'jobId'=j.id::text AND q.data->>'generation'=j.payload->>'generation') AS recovery_pending
      FROM jobs j JOIN search_index_control c ON c.singleton AND c.endpoint=$2 WHERE j.id=$1 AND j.kind='search-index'`,[jobId,this.endpoint])).rows[0];
    if(!j)return null;
    return {jobId:j.id,state:j.state,generation:j.payload.generation,sourceType:j.payload.sourceType,sourceId:j.payload.sourceId,
      subjectId:j.payload.subjectId,attempts:j.attempts,
      recoveryAttempts:j.search_recovery_generation===j.payload.generation?j.search_recovery_count:0,
      automaticRecoveryPending:j.recovery_pending,
      automaticRecoveryExhausted:j.search_recovery_generation===j.payload.generation&&j.search_recovery_count>=3&&!j.recovery_pending,
      recoveryAt:j.search_recovery_at?new Date(j.search_recovery_at).toISOString():null};
  }
  // Only the authenticated operations controller may expose this method. It
  // targets one failed generation; it cannot retry a newer source by accident.
  async retryFailed({jobId,expectedGeneration},{audit,authorize}={}){
    if(typeof jobId!=='string'||!/^[0-9a-f-]{36}$/i.test(jobId)||!Number.isInteger(expectedGeneration)||expectedGeneration<1)
      throw new ServiceError('invalid_search_recovery',400);
    return transaction(this.db,async db=>{
      await authorize?.(db);
      const job=(await db.query("SELECT * FROM jobs WHERE id=$1 AND kind='search-index' FOR UPDATE",[jobId])).rows[0];
      if(!job)throw new ServiceError('search_job_not_found',404);
      if(job.state!=='failed'||job.payload.generation!==expectedGeneration)throw new ServiceError('search_recovery_conflict',409);
      if(!(await db.query('SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1',[this.endpoint])).rows.length)throw new ServiceError('search_index_disabled',409);
      await db.query("DELETE FROM galaxy_jobs.job WHERE name='search-recovery' AND state='cancelled' AND data->>'jobId'=$1 AND data->>'generation'=$2",
        [job.id,String(expectedGeneration)]);
      await db.query(`UPDATE jobs SET state='pending',attempts=0,lease_id=NULL,locked_until=NULL,available_at=$2,
        search_recovery_count=0,search_recovery_generation=$3,search_recovery_at=NULL WHERE id=$1`,[job.id,iso(this.now()),expectedGeneration]);
      const result={jobId:job.id,generation:expectedGeneration,state:'pending'};
      await audit?.(db,result);
      return result;
    });
  }
  async build(db,job){
    const {sourceType:type,sourceId:id,subjectId}=job.payload,dependencies=new Set();let validUntil=this.now()+this.maxAgeSeconds;
    const reader=new ConsentReader({now:this.now,readGrant:this.readGrant});
    const grant=async(row,action,publicOnly=false)=>{
      const intent=await reader.require(db,{id:row.consent_id,subjectId:row.subject_id,objectId:row.id,action,recipient:this.endpoint,payloadJson:row.payload_text});
      if(publicOnly&&!canReadProjection(intent,{viewerId:null,now:this.now()}))throw new ServiceError('index_source_not_public',404);
      dependencies.add('consent:'+intent.id);dependencies.add('binding:'+intent.bindingId);validUntil=Math.min(validUntil,intent.expiresAt);
      return intent;
    };
    const lock=async refs=>{for(const ref of refs)dependencies.add(ref);await db.query('SELECT public.galaxy_search_lock_sources($1::jsonb)',[JSON.stringify(refs)]);};
    const caseSource=async(caseId,ownerId,publicOnly)=>{
      await lock(['case:'+caseId]);
      const parent=(await db.query('SELECT * FROM cases WHERE id=$1 AND subject_id=$2',[caseId,ownerId])).rows[0];
      if(!parent||parent.state==='withdrawn')throw new ServiceError('index_case_unavailable',404);
      const rows=(await db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001',[caseId])).rows;
      if(!rows.length||rows.length>1000||rows.length!==parent.version||rows[0].kind!=='case')throw new ServiceError('index_case_unavailable',404);
      for(const row of rows)await grant(row,'case.teaser.publish',publicOnly);
      return {parent,rows};
    };
    let title,summary,searchText,version,metadata={};
    if(type==='case'||type==='history'){
      const current=await caseSource(id,subjectId,true),root=current.rows[0].payload;
      title=root.title;summary=root.summary;version=String(current.parent.version);searchText=title+' '+summary;
      metadata={sourceType:type,sourceVersion:current.parent.version};
    }else if(type==='proof'){
      const row=(await db.query('SELECT * FROM proofs WHERE id=$1 AND subject_id=$2',[id,subjectId])).rows[0];
      if(!row||row.revoked_at)throw new ServiceError('index_proof_unavailable',404);
      const evidence=(await db.query('SELECT * FROM evidence_submissions WHERE id=$1',[row.evidence_id])).rows[0];
      if(!evidence)throw new ServiceError('index_proof_unavailable',404);
      // Match the source locks used by the serving Proof path. No service key is
      // loaded by this worker; the API still verifies the signed Proof on read.
      await lock(['case:'+evidence.case_id,'evidence:'+evidence.id,'proof:'+id]);
      const collectedReader={require:async(connection,input)=>{
        const intent=await reader.require(connection,input);dependencies.add('consent:'+intent.id);dependencies.add('binding:'+intent.bindingId);
        validUntil=Math.min(validUntil,intent.expiresAt);return intent;
      }};
      const liveEvidence=new EvidenceService(null,collectedReader,{db,endpoint:this.endpoint,now:this.now,readCase:async(connection,caseId,ownerId)=>connection.query('SELECT * FROM cases WHERE id=$1 AND subject_id=$2',[caseId,ownerId])});
      const observation=await currentProofSource(db,row.evidence_id,subjectId,{evidence:liveEvidence,now:this.now});
      if(observation.id!==row.observation_id)throw new ServiceError('index_proof_unavailable',404);
      await grant(row,'proof.publish',true);
      const payload=JSON.parse(row.payload_text);validUntil=Math.min(validUntil,payload.expiresAt);
      title=payload.source.owner+'/'+payload.source.repository+' · run '+payload.source.runId;summary=payload.conclusion;
      searchText=[payload.source.owner+'/'+payload.source.repository,payload.source.commit,payload.source.runId,payload.conclusion,payload.scope].join(' ');
      version=row.observation_id;metadata={sourceType:type,observationId:row.observation_id,conclusion:payload.conclusion,signatureVerified:false};
    }else if(type==='worker'||type==='hub'){
      await lock(['builder:'+id]);
      const parent=(await db.query('SELECT * FROM builders WHERE id=$1 AND owner_id=$2 AND type=$3',[id,subjectId,type])).rows[0];
      if(!parent)throw new ServiceError('index_builder_unavailable',404);
      const rows=(await db.query('SELECT * FROM builder_events WHERE builder_id=$1 ORDER BY revision LIMIT 1001',[id])).rows;
      const declaration=rows.findLast(row=>row.kind==='declare');
      if(!declaration||rows.length>1000||rows.length!==parent.revision)throw new ServiceError('index_builder_unavailable',404);
      let delisted=false;for(const row of rows)if(row.kind==='maintenance'){
        const event=JSON.parse(row.payload_text);if(event.action==='delist')delisted=true;if(event.action==='relist')delisted=false;
      }
      if(delisted)throw new ServiceError('index_builder_delisted',404);
      await grant(declaration,'builder.publish',true);
      const payload=JSON.parse(declaration.payload_text).declaration,fields=builderSearchFields(payload);
      title=payload.name;summary=payload.scope;searchText=Object.values(fields).join(' ');version=declaration.id;
      metadata={sourceType:type,declarationId:declaration.id,declarationHash:declaration.payload_hash,revision:parent.revision,version:payload.release.version};
    }else if(type==='capsule'){
      await lock(['capsule:'+id]);
      const rows=(await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND subject_id=$2 AND kind='version' ORDER BY revision DESC LIMIT 100",[id,subjectId])).rows;
      for(const row of rows){try{
        const payload=JSON.parse(row.payload_text || 'null');
        if (!payload || payload.schemaVersion === 2) continue;
        await grant(row,'capsule.publish',true);
        await caseSource(payload.sourceResolution.caseId,subjectId,false);
        title=payload.title;summary=payload.problemPattern;searchText=title+' '+summary;version=row.id;
        metadata={sourceType:type,versionId:row.id,version:payload.version,capabilityId:payload.capabilityId};break;
      }catch(error){if(!hiddenSource(error))throw error;}}
      if(!version)throw new ServiceError('index_capsule_unavailable',404);
    }else throw new Error('Invalid search job kind');
    if(validUntil<=this.now())throw new ServiceError('index_source_expired',404);
    return {type,id,subjectId,title,summary,searchText,version,metadata,dependencies:[...dependencies].sort((a,b)=>a.localeCompare(b)),validUntil};
  }
  async processNext({signal,afterClaim,beforeCommit}={}){
    signal?.throwIfAborted();const now=this.now();
    const job=await transaction(this.db,async db=>{
      if(!(await db.query('SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1',[this.endpoint])).rows.length)return null;
      await db.query(`UPDATE jobs SET state='failed',lease_id=NULL,locked_until=NULL WHERE id IN
        (SELECT id FROM jobs WHERE kind='search-index' AND attempts>=5 AND (state='pending' OR state='running' AND locked_until<=$1) ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)`,[iso(now)]);
      const row=(await db.query(`SELECT * FROM jobs WHERE kind='search-index' AND attempts<5 AND
        (state='pending' AND available_at<=$1 OR state='running' AND locked_until<=$1) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[iso(now)])).rows[0];
      if(!row)return null;const lease=randomUUID();
      await db.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3 WHERE id=$1",[row.id,lease,iso(now+30)]);
      return {...row,lease_id:lease,attempts:row.attempts+1};
    });
    if(!job)return {processed:false};
    await afterClaim?.(job); // A stopped process leaves a reclaimable lease.
    try{return await transaction(this.db,async db=>{
      signal?.throwIfAborted();let document;
      try{document=await this.build(db,job);}catch(error){if(!hiddenSource(error))throw error;}
      await beforeCommit?.(job,document);signal?.throwIfAborted();
      const current=(await db.query("SELECT * FROM jobs WHERE id=$1 AND kind='search-index' FOR UPDATE",[job.id])).rows[0];
      if(!current||current.state!=='running'||current.lease_id!==job.lease_id||Date.parse(current.locked_until)<=this.now()*1000)return {processed:false,leaseLost:true};
      if(!(await db.query('SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1',[this.endpoint])).rows.length)return {processed:false,disabled:true};
      await db.query('DELETE FROM search_documents WHERE source_type=$1 AND source_id=$2',[job.payload.sourceType,job.payload.sourceId]);
      if(document)await db.query(`INSERT INTO search_documents(source_type,source_id,subject_id,endpoint,title,summary,search_text,source_version,metadata,dependencies,generation,built_at,valid_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,[document.type,document.id,document.subjectId,this.endpoint,document.title,document.summary,document.searchText,document.version,
        JSON.stringify(document.metadata),JSON.stringify(document.dependencies),job.payload.generation,iso(this.now()),iso(document.validUntil)]);
      await db.query("UPDATE jobs SET state='completed',lease_id=NULL,locked_until=NULL WHERE id=$1",[job.id]);
      return {processed:true,state:document?'indexed':'hidden',sourceType:job.payload.sourceType};
    });}catch{
      const state=job.attempts<5?'pending':'failed';
      await this.db.query(`UPDATE jobs SET state=$3,lease_id=NULL,locked_until=NULL,available_at=$4 WHERE id=$1 AND lease_id=$2 AND kind='search-index' AND state='running'`,
        [job.id,job.lease_id,state,iso(this.now()+Math.min(300,10*2**job.attempts))]);
      return {processed:true,state,interrupted:signal?.aborted??false};
    }
  }
  async candidates(type,{after,subjectId,query='',limit=20}={}){
    if(!searchSourceTypes.includes(type)||!Number.isInteger(limit)||limit<1||limit>200||typeof query!=='string'||query.length>200)throw new Error('Invalid index query');
    const active=(await this.db.query('SELECT enabled FROM search_index_control WHERE singleton AND endpoint=$1',[this.endpoint])).rows[0];
    if(!active?.enabled)return {enabled:false,items:[]};
    const terms=[...new Set(query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean))];
    const rows=(await this.db.query(`SELECT source_id,source_version,metadata,built_at,valid_until FROM search_documents d
      WHERE source_type=$1 AND endpoint=$2 AND valid_until>$3 AND built_at>$4 AND ($5::uuid IS NULL OR source_id>$5)
        AND ($6::text IS NULL OR subject_id=$6)
        AND NOT EXISTS(SELECT 1 FROM deletion_requests pending WHERE pending.subject_id=d.subject_id AND pending.state IN ('requested','review-needed','approved','partial','primary-erased')) AND NOT EXISTS(SELECT 1 FROM unnest($7::text[]) term WHERE strpos(lower(d.search_text),term)=0)
      ORDER BY source_id LIMIT $8`,[type,this.endpoint,iso(this.now()),iso(this.now()-this.maxAgeSeconds),after??null,subjectId??null,terms,limit+1])).rows;
    return {enabled:true,truncated:rows.length>limit,items:rows.slice(0,limit).map(row=>({id:row.source_id,sourceVersion:row.source_version,metadata:row.metadata,builtAt:row.built_at,validUntil:row.valid_until})),authority:'candidate-only; current-source-read-required'};
  }
}
