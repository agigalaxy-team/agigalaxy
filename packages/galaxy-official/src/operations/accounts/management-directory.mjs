import {randomUUID} from 'node:crypto';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {managementId,managementStamp,managementSafeCode} from './management-schema.mjs';

// Complete bounded observations, not a second identity authority. Only a
// published generation participates in list count/filter/page operations.
export class ManagementDirectory{
 constructor({db,endpoint,directory,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,directory,now});}
 async source(db=this.db){const row=(await db.query('SELECT d.*,g.observed_count FROM operations_management_directory_v1 d LEFT JOIN operations_management_generations_v1 g ON g.id=d.generation_id WHERE d.endpoint=$1',[this.endpoint])).rows[0];
  const configured=!!this.directory,matching=configured&&row?.issuer===this.directory.issuer,ready=matching&&!!row.generation_id;
  return {state:!configured?'not-configured':matching&&row.sync_id&&Date.parse(row.lease_until)>this.now()*1000?'syncing':ready&&!row.last_error?'ready':'unavailable',
   coverage:ready?'complete-generation':'not-ready',generationId:ready?row.generation_id:null,asOf:ready?managementStamp(row.last_completed_at):null,
   lastError:matching?row.last_error??null:null,totalObserved:ready?Number(row.observed_count):null,atomicSourceSnapshot:false};}
 async sync(){if(!this.directory)return {state:'not-configured'};const id=randomUUID(),issuer=this.directory.issuer,at=managementStamp(this.now()*1000);
  const claim=await transaction(this.db,async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912460))',[this.endpoint]);
   const old=(await db.query('SELECT * FROM operations_management_directory_v1 WHERE endpoint=$1 FOR UPDATE',[this.endpoint])).rows[0];if(old?.sync_id&&Date.parse(old.lease_until)>this.now()*1000)return false;
   await db.query(`INSERT INTO operations_management_directory_v1(endpoint,issuer,sync_id,lease_until,last_started_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(endpoint) DO UPDATE SET issuer=$2,generation_id=CASE WHEN operations_management_directory_v1.issuer=$2 THEN operations_management_directory_v1.generation_id ELSE NULL END,
    sync_id=$3,lease_until=$4,last_started_at=$5,last_error=NULL`,[this.endpoint,issuer,id,managementStamp((this.now()+60)*1000),at]);
   await db.query("INSERT INTO operations_management_generations_v1(id,endpoint,issuer,state,started_at) VALUES($1,$2,$3,'building',$4)",[id,this.endpoint,issuer,at]);return true;});
  if(!claim)return {state:'syncing'};let observed=0,raw=0;
  try{const before=await this.directory.count();
   for(let first=0;;first+=20){if(first>before+20)throw new ServiceError('management_directory_source_changed',503);const page=await this.directory.page({first,max:20});raw+=page.rawCount;
    await transaction(this.db,async db=>{const head=(await db.query('SELECT sync_id FROM operations_management_directory_v1 WHERE endpoint=$1 FOR UPDATE',[this.endpoint])).rows[0];if(head?.sync_id!==id)throw new ServiceError('management_directory_source_changed',503);
     for(const user of page.items){const result=await db.query(`INSERT INTO operations_management_entries_v1(generation_id,operator_id,issuer,external_subject,username,first_name,last_name,email,email_verified,enabled,created_at,admission,required_actions)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING operator_id`,[id,managementId(issuer,user.externalSubject),issuer,user.externalSubject,user.username,user.firstName,user.lastName,user.email,user.emailVerified,user.enabled,user.createdAt,user.admission,user.requiredActions]);
      if(!result.rows.length)throw new ServiceError('management_directory_source_changed',503);observed++;}
     await db.query('UPDATE operations_management_directory_v1 SET lease_until=$3 WHERE endpoint=$1 AND sync_id=$2',[this.endpoint,id,managementStamp((this.now()+60)*1000)]);});
    if(page.rawCount<20)break;}
   const after=await this.directory.count();if(after!==before||raw!==before)throw new ServiceError('management_directory_source_changed',503);
   await transaction(this.db,async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912460))',[this.endpoint]);
    const head=(await db.query('SELECT sync_id FROM operations_management_directory_v1 WHERE endpoint=$1 FOR UPDATE',[this.endpoint])).rows[0];if(head?.sync_id!==id)throw new ServiceError('management_directory_source_changed',503);
    const done=managementStamp(this.now()*1000);await db.query("UPDATE operations_management_generations_v1 SET state='complete',completed_at=$2,observed_count=$3,source_count_before=$4,source_count_after=$5 WHERE id=$1",[id,done,observed,before,after]);
    await db.query('UPDATE operations_management_directory_v1 SET generation_id=$2,last_completed_at=$3,sync_id=NULL,lease_until=NULL,last_error=NULL WHERE endpoint=$1',[this.endpoint,id,done]);
    await db.query('DELETE FROM operations_management_generations_v1 WHERE endpoint=$1 AND id<>$2',[this.endpoint,id]);});
   return {state:'complete',generationId:id,observedCount:observed};
  }catch(error){const code=managementSafeCode(error);await transaction(this.db,async db=>{await db.query("UPDATE operations_management_generations_v1 SET state='failed',code=$2 WHERE id=$1",[id,code]);await db.query('UPDATE operations_management_directory_v1 SET sync_id=NULL,lease_until=NULL,last_error=$3 WHERE endpoint=$1 AND sync_id=$2',[this.endpoint,id,code]);});return {state:'failed',code};}
 }
}

