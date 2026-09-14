import {ConsentReader} from './consent-reader.mjs';
import {workerReads} from './infrastructure/worker-reads.mjs';
import {CiObservationV2Service} from './ci-observation-v2.mjs';
import {CaseService} from './cases.mjs';
import {VerificationRecordService} from './verification-records.mjs';
export function createCiWorkerV2({db,endpoint,now,resourceBudgetPolicy,source}){
  const consents=new ConsentReader({now,readGrant:workerReads.readGrant});
  return new CiObservationV2Service(null,consents,{db,endpoint,now,resourceBudgetPolicy,source,
    sourceReader:request=>{
      const descriptor={endpoint,now};const cases=new CaseService(descriptor,consents);
      const records=new VerificationRecordService(descriptor,consents,{cases,
        lockCaseRead:async(tx,id)=>(await tx.query('SELECT * FROM public.galaxy_worker_lock_ci_case($1,$2)',[request.id,id])).rows[0],
        lockRecordRead:async(tx,id)=>(await tx.query('SELECT * FROM public.galaxy_worker_lock_ci_record($1,$2)',[request.id,id])).rows[0]});
      cases.sources=records;cases.verifications=records;return records;
    }});
}
