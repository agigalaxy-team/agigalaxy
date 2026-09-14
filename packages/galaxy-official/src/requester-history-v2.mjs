import {requesterHistoryV2Schema,requesterHistoryFactsV2Schema} from './shared/requester-history-v2-schema.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {transaction} from './database.mjs';
import {digest} from './shared/digest.mjs';
const rule=(ok,code,status=404)=>{if(!ok)throw new ServiceError(code,status);};
const absent=e=>e instanceof ServiceError&&[403,404,409,422].includes(e.status);
const factKinds=new Set(['participation-proposed','confirm','propose-scope','confirm-scope','decline-scope','deliver','accept','cancel','close','withdraw',
  'dispute','propose-resolution','confirm-resolution','requester-feedback']);
export class RequesterHistoryV2Service{
  constructor(access,assistance,sharing){Object.assign(this,{access,assistance,sharing});}
  async projectWithin(db,actor,id){
    const task=await this.assistance.taskRepository.get(db,id);rule(task&&!task.snapshot.contentDeleted,'requester_history_unavailable');
    const root=await this.assistance.taskRepository.event(db,task.root_event_id);
    const rootPermission=await this.sharing.authorizeWithin(db,actor,'task-event',root,{purpose:'requester-history'});
    const rows=await this.assistance.taskRepository.events(db,id),state=task.snapshot,allowed=[];
    for(const row of rows){if(row.id===task.root_event_id)continue;
      try{const permission=await this.sharing.authorizeWithin(db,actor,'task-event',row,{purpose:'requester-history'});
        const event=state.events.find(e=>e.event.eventId===row.id);if(!event)continue;
        allowed.push({row,event,permission});
      }catch(error){if(!absent(error))throw error;}
    }
    const facts=[];
    for(const item of allowed.filter(x=>factKinds.has(x.row.kind))){
      let feedbackState;
      if(item.row.kind==='requester-feedback'){
        const p=await this.assistance.taskRepository.getParticipation(db,item.row.participation_id);
        if(!p||p.snapshot.contentDeleted)continue;
        feedbackState=p.snapshot.feedback?.eventId===item.row.id?'current':'superseded';
      }
      facts.push({source:{kind:'task-event',id:item.row.id,eventVersion:1,payloadHash:item.row.payload_hash},
        projection:this.sharing.project(item.row,item.permission.fields),publicationIds:item.permission.publicationIds,
        authority:item.row.kind==='requester-feedback'?'provider-reported':'signed-participant-event',
        ...(feedbackState?{feedbackState}:{}),independentQualityRating:false});
    }
    const offer=allowed.find(i=>i.row.kind==='apply');
    const response=offer&&allowed.find(i=>i.row.subject_id===task.requester_id&&i.event.at>=offer.event.at&&['participation-proposed','cancel','propose-scope'].includes(i.row.kind));
    const acceptances=allowed.filter(i=>i.row.kind==='accept'),acceptanceIntervals=[];
    for(const accepted of acceptances){const payload=JSON.parse(accepted.row.payload_text),delivery=allowed.find(i=>i.row.id===(payload.event??payload).deliveryId);
      if(delivery)acceptanceIntervals.push({seconds:accepted.event.at-delivery.event.at,deliverySourceId:delivery.row.id,acceptanceSourceId:accepted.row.id});}
    return{schemaVersion:2,id:digest(JSON.stringify([this.access.endpoint,'requester-history',id])),requesterId:task.requester_id,
      source:{kind:'task-event',id:root.id,eventVersion:1,payloadHash:root.payload_hash},projection:this.sharing.project(root,rootPermission.fields),
      facts,counts:{acceptances:acceptances.length,cancellations:allowed.filter(i=>i.row.kind==='cancel').length,disputes:allowed.filter(i=>i.row.kind==='dispute').length,
        currentFeedback:facts.filter(f=>f.feedbackState==='current').length},
      responseSeconds:response?response.event.at-offer.event.at:null,
      responseSources:response?{offerSourceId:offer.row.id,responseSourceId:response.row.id}:null,acceptanceIntervals,
      responseBasis:'first visible application and later visible requester response; missing is unknown, not unresponsive',
      countsMeaning:'currently authorized events in this request; repeat acceptance is not a second request',
      settlementCoverage:'not-recorded-by-this-source-profile',globalScore:null,independentQualityRating:false,maliciousnessConclusion:null};
  }
  query(actor,input={}){const parsed=requesterHistoryV2Schema.safeParse(input);rule(parsed.success,'invalid_requester_history_query',400);
    const q=parsed.data,subjectId=q.subjectId??actor?.subjectId;rule(subjectId,'requester_subject_required',400);
    const read=async db=>{
      const candidates=(await db.query('SELECT id,root_event_id FROM task_requests WHERE requester_id=$1 AND ($2::uuid IS NULL OR root_event_id>$2) ORDER BY root_event_id LIMIT $3',[subjectId,q.after??null,q.limit+1])).rows;
      const items=[];for(const row of candidates.slice(0,q.limit))try{const p=await this.projectWithin(db,actor,row.id),preview=p.facts.slice(0,8);
        items.push({...p,facts:preview,nextFactsAfter:p.facts.length>preview.length?preview.at(-1).source.id:null});
      }catch(error){if(!absent(error))throw error;}
      return{schemaVersion:2,subjectId,items,nextAfter:candidates.length>q.limit?candidates[q.limit-1].root_event_id:null,
        coverage:'visible-page-only; empty page may still have a next cursor',counts:{requests:items.length,acceptances:items.reduce((s,i)=>s+i.counts.acceptances,0),
          cancellations:items.reduce((s,i)=>s+i.counts.cancellations,0),disputes:items.reduce((s,i)=>s+i.counts.disputes,0)},globalScore:null};
    };return actor?this.access.runAuthorized(actor,'assistance',read):transaction(this.access.db,read);
  }
  facts(actor,input){const parsed=requesterHistoryFactsV2Schema.safeParse(input);rule(parsed.success,'invalid_requester_history_query',400);const q=parsed.data;
    const read=async db=>{const root=await this.assistance.taskRepository.event(db,q.rootEventId);rule(root?.kind==='task-created','requester_history_unavailable');
      const p=await this.projectWithin(db,actor,root.task_id),start=q.after?p.facts.findIndex(f=>f.source.id===q.after)+1:0;
      rule(!q.after||start>0,'requester_history_cursor_unavailable',409);const facts=p.facts.slice(start,start+q.limit);
      return{...p,facts,nextAfter:start+facts.length<p.facts.length?facts.at(-1).source.id:null,coverage:'current permitted request sources; no original-text grant'};
    };return actor?this.access.runAuthorized(actor,'assistance',read):transaction(this.access.db,read);
  }
}
