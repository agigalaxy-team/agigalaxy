import {canReadProjection} from "../domain/consent-policy.mjs";
import {factAt,latestFact} from "../domain/intervention.mjs";
import {rule} from './helpers.mjs';

// Original Access/Consent identity and exact registered fact/source qualifications. Historical readability and currentness remain distinct.
export class CaseAuthority{
  constructor(access, consents) { this.access = access; this.consents = consents; this.endpoint = access.endpoint; }

  async requireEventVisibleWithin(db,actor,row) {
    rule(row,'case_event_unavailable',404);
    rule(typeof row.payload_text==='string'&&row.payload_text.length>0,'case_event_unavailable',404);
    const intent=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'case.teaser.publish',
      objectId:row.id,recipient:this.endpoint,payloadJson:row.payload_text});
    rule(canReadProjection(intent,{viewerId:actor.subjectId,now:this.consents.now(),hubEndpoint:this.endpoint}),
      'origin_not_authorized',403);
    return intent;
  }

  async requireFactWithin(db,actor,rows,facts,kind,ref,{own=false,latest=false,visited=new Set(),readEventWithin=null}={}) {
    const found=factAt(facts,kind,ref);
    rule(found,'invalid_result_origin',422);
    if(own)rule(found.actorId===actor.subjectId,'origin_not_authorized',403);
    if(latest){
      rule(latestFact(facts,kind,ref.id)?.version===ref.version,'fact_version_conflict');
      // Retained changes without their body cannot identify an object/version.
      // They make this author's earlier currentness unknown, never a license
      // to reuse an erased version. Nonlatest historical reads stay separate.
      const changes={attempt:['attempt-end','attempt-correct'],intervention:['intervention'],result:['result-recorded']}[kind]??[];
      rule(!rows.some(row=>changes.includes(row.kind)&&!row.payload_text
        &&row.subject_id===found.actorId&&row.version>found.caseVersion),'fact_currentness_unavailable');
    }
    const key=`${kind}:${ref.id}:${ref.version}`;
    if(visited.has(key))return found;
    visited.add(key);
    for(const id of new Set(found.recordEventIds)){
      const row=rows.find(item=>item.id===id);rule(row,'invalid_result_origin',422);
      if(readEventWithin)await readEventWithin(row);else await this.requireEventVisibleWithin(db,actor,row);
      for(const source of [...(row.payload.sourceRefs??[]),...(row.payload.deliverableRefs??[])])
        await this.requireSourceWithin(db,actor,rows,facts,source,visited,readEventWithin);
    }
    return found;
  }

  async requireSourceWithin(db,actor,rows,facts,ref,visited=new Set(),readEventWithin=null) {
    if(['attempt','intervention','result'].includes(ref.kind))
      return this.requireFactWithin(db,actor,rows,facts,ref.kind,ref,{visited,readEventWithin});
    // Context/chat/evidence access is delegated to its owning module. No caller
    // field or syntactically valid UUID can substitute for actual read permission.
    rule(this.sources?.requireReferenceWithin,'source_access_unavailable',503);
    return this.sources.requireReferenceWithin(db,actor,ref,{caseId:facts.caseId,visited});
  }
}
