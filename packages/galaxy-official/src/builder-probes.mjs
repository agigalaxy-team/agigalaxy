import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { liveBuilderProbe } from './domain/builder-probe-source.mjs';
import { observeBuilderEndpoint } from './builder-probe-observer.mjs';
import { defaultResourceBudgetPolicy,resourceBudgetPolicySchema } from './infrastructure/resource-budgets.mjs';

const iso=value=>new Date(value*1000).toISOString();
export class BuilderProbeWorker{
  constructor({db,consents,endpoint,now=()=>Math.floor(Date.now()/1000),readBuilder,resourceBudgetPolicy=defaultResourceBudgetPolicy,observe=observeBuilderEndpoint}){
    Object.assign(this,{db,consents,endpoint,now,readBuilder,observe});this.budget=resourceBudgetPolicySchema.parse(resourceBudgetPolicy);
  }
  live(db,job){return liveBuilderProbe(db,{builderId:job.payload.builderId,requestId:job.payload.requestId,consents:this.consents,endpoint:this.endpoint,now:this.now(),readBuilder:this.readBuilder});}
  async processNext(){
    const now=this.now(),job=await transaction(this.db,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(734912310)');
      await db.query(`UPDATE jobs SET state='failed',lease_id=NULL,locked_until=NULL WHERE id IN
        (SELECT id FROM jobs WHERE kind='builder-probe' AND attempts>=3 AND (state='pending' OR state='running' AND locked_until<=$1) ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)`,[iso(now)]);
      if(Number((await db.query("SELECT count(*) FROM jobs WHERE state='running' AND locked_until>$1",[iso(now)])).rows[0].count)>=this.budget.maxActiveJobsGlobal)return null;
      const selected=(await db.query(`SELECT j.* FROM jobs j WHERE j.kind='builder-probe' AND j.attempts<3 AND
        j.available_at<=$1 AND (j.state='pending' OR j.state='running' AND j.locked_until<=$1) AND
        NOT EXISTS (SELECT 1 FROM jobs recent WHERE recent.kind='builder-probe' AND recent.attempts>0 AND recent.available_at>$1
          AND (recent.payload->'origins') ?| ARRAY(SELECT jsonb_array_elements_text(j.payload->'origins'))) AND
        (SELECT count(*) FROM jobs a LEFT JOIN evidence_submissions e ON a.payload->>'evidenceId'=e.id::text
          LEFT JOIN ci_requests_v2 ci ON a.payload->>'ciRequestId'=ci.id::text
          WHERE a.state='running' AND a.locked_until>$1 AND (e.subject_id=j.payload->>'subjectId' OR ci.subject_id=j.payload->>'subjectId' OR a.kind='builder-probe' AND a.payload->>'subjectId'=j.payload->>'subjectId'))<$2
        ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[iso(now),this.budget.maxActiveJobsPerSubject])).rows[0];
      if(!selected)return null;const lease=randomUUID();
      await db.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3,available_at=$4 WHERE id=$1",[selected.id,lease,iso(now+30),iso(now+60)]);
      return {...selected,lease_id:lease,attempts:selected.attempts+1};
    });
    if(!job)return {processed:false};
    const unavailable=()=>({version:1,status:'revoked',reason:'probe-source-unavailable',checkedAt:this.now(),validUntil:this.now()+300,stage:'none',
      cardRetrieved:false,endpointReachable:null,protocolResponded:false,authenticationRequired:false,authority:'registry-worker-public-observation',endpointControlVerified:false,capabilityVerified:false});
    let observation;
    try{
      const source=await transaction(this.db,db=>this.live(db,job));
      observation=await this.observe(source.target,{now:this.now});
    }catch(error){if(!(error instanceof ServiceError))throw error;observation=unavailable();}
    return transaction(this.db,async db=>{
      const current=(await db.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
      if(!current||current.lease_id!==job.lease_id||current.state!=='running')return {processed:false,leaseLost:true};
      try{await this.live(db,job);}catch(error){if(!(error instanceof ServiceError))throw error;observation=unavailable();}
      await db.query('INSERT INTO builder_probes(id,request_id,job_id,attempt,observation) VALUES($1,$2,$3,$4,$5)',[randomUUID(),job.payload.requestId,job.id,job.attempts,JSON.stringify(observation)]);
      const retry=observation.status==='unavailable'&&job.attempts<3;
      await db.query('UPDATE jobs SET state=$2,lease_id=NULL,locked_until=NULL,available_at=$3 WHERE id=$1',
        [job.id,retry?'pending':observation.status==='unavailable'?'failed':'completed',iso(this.now()+60)]);
      const audit=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,idempotency_key,binding_scopes)
        SELECT 'galaxy-builder-probe','builder.probe.observe',r.id::text,$2::text,$3,1,'galaxy-evidence-worker',b.audience,'builders',c.id,b.id,$2::text||':'||$4::integer::text,b.scopes
        FROM builder_events r JOIN consents c ON c.id=r.consent_id JOIN bindings b ON b.id=c.binding_id WHERE r.id=$1 RETURNING 1`,[job.payload.requestId,job.id,observation.status,job.attempts]);
      if(audit.rows.length!==1)throw new Error('Probe audit context unavailable');
      return {processed:true,state:observation.status};
    });
  }
}
