import {z} from 'zod';
import {caseTaskLinkSchema} from './shared/cases-schema.mjs';
import {evidenceStatusQuerySchema} from './shared/verification-record-schema.mjs';
import {historyV2QuerySchema} from './shared/history-v2-schema.mjs';

// OAuth transports exact user-approved payloads; neither this adapter nor the
// data services create the user's signature or choose a resolution for them.
export function factToolDefinitions(services,actor){
  const submission=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(24000)});
  const tool=(scope,inputSchema,description,run,write=false)=>({scope,inputSchema,description,run,write});
  return {
    galaxy_history_v2_query:tool('history',historyV2QuerySchema,
      'Read one subject\'s currently permitted attempts, interventions, reports and contribution history, with all-visible/90/365/custom windows. Self-declarations, delivery acceptance, verification and resolution stay distinct; empty history does not bar open collaboration. A changed source cursor requires restarting the query.',input=>services.history.queryV2(actor,input)),
    galaxy_case_v2_submit:tool('case-teaser',submission,'Append exact authorized Case/Attempt/Intervention/Result/Resolution event bytes. A reported result does not imply acceptance, verification, or resolution.',input=>services.cases.submitV2(actor,input),true),
    galaxy_case_v2_read:tool('case-teaser',z.strictObject({caseId:z.uuid(),taskId:z.uuid().optional()}),
      'Read currently authorized v2 facts and coverage. Revoked dependencies can make a projection incomplete.',input=>services.cases.getV2(actor,input.caseId,{taskId:input.taskId})),
    galaxy_intervention_responses_submit:tool('case-teaser',z.strictObject({requests:z.array(submission).min(1).max(32)}),
      'Submit separately authorized participant responses. Return every accepted/rejected item; one accepted response is not independent verification.',input=>services.cases.respondBatch(actor,input.requests),true),
    galaxy_task_create_link_case:tool('case-teaser',caseTaskLinkSchema,
      'Atomically link a proactive Task to its first actual Case and Attempt/Intervention using two exact Consents. Does not fabricate failures.',input=>services.cases.createAndLinkTask(actor,input),true),
    galaxy_evidence_v2_submit:tool('evidence',submission,
      'Store exact authorized source metadata with declared provenance and versions. Does not fetch arbitrary URLs or certify ownership.',input=>services.evidence.submitV2(actor,input),true),
    galaxy_verification_record_submit:tool('evidence',submission,
      'Append an authorized evidence/verification report, correction or revocation. Consent targets operationId. Local reports retain limited scope and never certify expertise.',input=>services.verificationRecords.submit(actor,input),true),
    galaxy_verification_record_read:tool('evidence',z.strictObject({type:z.enum(['evidence','verification']),id:z.uuid(),version:z.number().int().positive().optional()}),
      'Read a permitted current or historic report with source/version availability. Current and historic checks are distinct.',input=>services.verificationRecords.get(actor,input)),
    galaxy_evidence_status:tool('evidence',evidenceStatusQuerySchema,
      'Read bounded statuses for specified visible evidence, verification and CI Proof references. Unknown upstream status is not valid or fraudulent.',input=>services.verificationRecords.status(actor,input)),
  };
}
