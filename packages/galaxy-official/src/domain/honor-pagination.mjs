import { ServiceError } from '../shared/service-error.mjs';
const compare=(a,b)=>a<b?-1:a>b?1:0;
const sourceFields=['sourceEvents','proofs','observations','revisionIds'];
const riskFields=['assistanceIds','caseIds','eventIds','evidenceIds','sourceKeys','subjectIds','edges'];
function bounded(value,fields){
  const result={...value},referenceCounts={};let complete=true;
  for(const field of fields)if(Array.isArray(value[field])){
    referenceCounts[field]=value[field].length;result[field]=value[field].slice(0,20);
    if(value[field].length>20)complete=false;
    if(field==='edges')result[field]=result[field].map(edge=>{if(edge.acceptanceEventIds.length>20)complete=false;return boundedEdge(edge);});
  }
  return {...result,referenceCounts,referencesComplete:complete};
}
function referencePage(value,fields,after,limit){
  const items=fields.flatMap(kind=>(value[kind]??[]).flatMap(item=>kind==='edges'?
    [{kind,value:boundedEdge(item)},...item.acceptanceEventIds.map(eventId=>({kind:'edgeAcceptanceEvents',value:{assistanceId:item.assistanceId,eventId}}))]:[{kind,value:item}]));
  return {after,nextAfter:after+limit<items.length?after+limit:null,total:items.length,items:items.slice(after,after+limit)};
}
function boundedEdge(edge){return {...edge,acceptanceEventIds:edge.acceptanceEventIds.slice(0,20),acceptanceEventCount:edge.acceptanceEventIds.length};}
function idPage(items,key,after,limit){
  const ordered=[...items].sort((a,b)=>compare(a[key],b[key])),selected=ordered.filter(item=>!after||item[key]>after).slice(0,limit+1);
  const page=selected.slice(0,limit);return {items:page,after:after??null,nextAfter:selected.length>limit?page.at(-1)[key]:null,total:items.length};
}
export function paginateHonor(view,query){
  if(query.expectedFingerprint&&query.expectedFingerprint!==view.card.sourceFingerprint)throw new ServiceError('honor_projection_changed_refresh',409);
  const limit=query.limit??8,contributions=idPage(view.contributions,'assistanceId',query.after,limit),proofs=idPage(view.card.proofs,'proofId',query.proofAfter,limit);
  const riskAfter=query.riskAfter??0,flags=view.riskAssessment.flags,riskPage=flags.slice(riskAfter,riskAfter+limit);
  const result={...view,card:{...view.card,evidence:view.card.evidence.filter(item=>contributions.items.some(source=>source.assistanceId===item.assistanceId)),
    proofs:proofs.items,evidenceCount:view.card.evidence.length,proofCount:view.card.proofs.length,evidenceComplete:contributions.items.length===view.contributions.length,proofsComplete:proofs.items.length===view.card.proofs.length},
    contributions:contributions.items.map(item=>bounded(item,sourceFields)),riskAssessment:{...view.riskAssessment,flags:riskPage.map(item=>bounded(item,riskFields))},
    pagination:{version:1,limit,consistency:'one-repeatable-read-per-response; refresh rechecks current authorization',
      contributions:{after:contributions.after,nextAfter:contributions.nextAfter,total:contributions.total},proofs:{after:proofs.after,nextAfter:proofs.nextAfter,total:proofs.total},
      risks:{after:riskAfter,nextAfter:riskAfter+limit<flags.length?riskAfter+limit:null,total:flags.length}}};
  // Summary evidence mirrors this contribution page, including bounded event references.
  result.card.evidence=result.card.evidence.map(item=>({...item,sourceEventIds:item.sourceEventIds.slice(0,20),sourceEventCount:item.sourceEventIds.length}));
  if(query.sourceId){
    const source=view.contributions.find(item=>item.assistanceId===query.sourceId);if(!source)throw new ServiceError('honor_source_unavailable',404);
    result.sourceDetail={assistanceId:source.assistanceId,...referencePage(source,sourceFields,query.sourceAfter??0,limit)};
  }
  if(query.riskIndex!==undefined){
    const risk=flags[query.riskIndex];if(!risk)throw new ServiceError('honor_risk_unavailable',404);
    result.riskDetail={index:query.riskIndex,code:risk.code,...referencePage(risk,riskFields,query.riskReferenceAfter??0,limit)};
  }
  return result;
}
