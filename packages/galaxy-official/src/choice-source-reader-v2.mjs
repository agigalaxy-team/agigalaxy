import {historyV2Repository} from './infrastructure/history-v2-repository.mjs';
import {historyRelevance,historyVisibleValue,sourceFingerprint} from './domain/history-v2.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {searchV2Scope} from './shared/search-v2-schema.mjs';
import {builderSearchFields} from './shared/builders-schema.mjs';

const fail=()=>{throw new ServiceError('choice_source_unavailable',409);};
const unavailable=e=>e instanceof ServiceError&&[403,404,409,422].includes(e.status);
// Query explanations are kept locally. Cloud dependency hashes concern actual
// currently permitted data, not a stored query, a semantic score or model text.
function factual(value){
 const v=structuredClone(historyVisibleValue(value));delete v.matchReasons;delete v.ranking;delete v.match;delete v.checkedAt;
 if(v.help){delete v.help.functions;delete v.help.purposes;}return v;
}
function visibleAuthors(value,ids=new Set()){
 if(Array.isArray(value))for(const item of value)visibleAuthors(item,ids);
 else if(value&&typeof value==='object')for(const [field,item] of Object.entries(value)){
  if(['subjectId','actorId','authorId','ownerId','requesterId','reportedBy','publisherId','contactSubjectId'].includes(field)&&typeof item==='string'&&/^GUID[0-9A-Z]{28}$/.test(item))ids.add(item);
  else if(item&&typeof item==='object')visibleAuthors(item,ids);
 }return [...ids];
}
function capsuleList(v){if(!v.version||v.sourceStatus==='source-unavailable')fail();return{capsuleId:v.capsuleId,versionId:v.versionId,sourceVersion:v.version.version,
 authorId:v.authorId,publicationClass:v.version.publicationClass,synthetic:v.version.synthetic,title:v.version.title,problemPattern:v.version.problemPattern,
 capabilityId:v.version.capabilityId,sourceStatus:v.sourceStatus,deprecated:v.deprecated,securityIssue:v.securityIssue,newApplicationAllowed:v.newApplicationAllowed,capabilityVerified:false};}
function builderList(v,query=''){
 if(v.delisted)fail();const fields=builderSearchFields(v.declaration),terms=[...new Set(query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean))];
 const matches=terms.map(term=>({term,fields:Object.keys(fields).filter(k=>fields[k].toLocaleLowerCase('en-US').includes(term))}));if(matches.some(v=>!v.fields.length))fail();
 return{builderId:v.builderId,ownerId:v.ownerId,type:v.type,name:v.declaration.name,version:v.declaration.release.version,registration:v.registration,nodeControl:v.nodeControl,
 compatibility:v.compatibility,reachability:v.reachability,evidence:v.evidence.state,securityIssue:v.securityIssue,revision:v.revision,declarationId:v.declarationId,declarationHash:v.declarationHash,scope:v.declaration.scope,
 matchReasons:matches.length?matches.map(m=>`${m.term} → ${m.fields.join(', ')}`):['current public declaration; source ID order']};
}
export class ChoiceSourceReaderV2 {
 constructor(search){this.search=search;}
 async historyWithin(db,actor,locator){
  const history=this.search.history,repo=historyV2Repository(db);if(locator.kind==='task-history')return history.taskWithin(db,actor,locator.id,locator.subjectId,repo);
  const tasks=[],rows=(await db.query('SELECT id FROM task_requests WHERE case_id=$1 ORDER BY id FOR SHARE',[locator.id])).rows;
  for(const row of rows)try{const task=await history.taskWithin(db,actor,row.id,locator.subjectId,repo);if(task)tasks.push(task);}catch(e){if(!unavailable(e))throw e;}
  return history.caseWithin(db,actor,{id:locator.id},locator.subjectId,tasks,repo);
 }
 async opportunityWithin(db,actor,locator,query=null){
  const d=this.search.discovery,ref=locator.source;let context;
  if(query)context=await d.contextWithin(db,actor,query);
  else{
   let project;if(ref.sourceKind==='recruitment')project=(await d.recruitment.readWithin(db,actor,ref.recruitmentId,{requireOpen:true})).document;
   else if(ref.sourceKind==='project')project=(await d.projects.readWithin(db,actor,ref.projectId)).document;
   else project=(await d.profiles.readWithin(db,actor,ref.subjectId)).selfDeclared.projects?.find(p=>p.id===ref.projectId);
   if(!project)fail();context={source:project,wish:{enabled:true,purposes:locator.purposes,functions:[]}};
  }
  const candidates=await d.opportunityWithin(db,actor,{subject_id:ref.subjectId},context);return candidates.find(v=>v.id===locator.id)??null;
 }
 async readWithin(db,actor,locator,query=null){
  if(!actor.scopes?.includes(searchV2Scope(locator.type)))throw new ServiceError('access_denied',403);
  let record;
  if(['history','case'].includes(locator.type))record=await this.historyWithin(db,actor,locator);
  else if(locator.type==='capsule')record=capsuleList(await this.search.capsules.readWithin(db,actor,{capsuleId:locator.id,versionId:locator.versionId}));
  else if(locator.type==='task'){record=await this.search.assistance.readTaskWithin(db,actor,locator.id);delete record.version;delete record.contacts;delete record.participations;}
  else if(locator.type==='proof')record=await this.search.ciV2.proofWithin(db,actor,locator.id);
  else if(locator.type==='opportunity')record=await this.opportunityWithin(db,actor,locator,query);
  else record=builderList(await this.search.legacy.builders.readWithin(db,null,{builderId:locator.id}),query?.query??'');
  if(!record)fail();return record;
 }
 async witnessWithin(db,actor,witness){
  const {search:{type,query},ref}=witness;let locator={type,id:ref.id},record,source,version;
  if(!actor.scopes?.includes(searchV2Scope(type)))throw new ServiceError('access_denied',403);
  if(type!=='opportunity'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.id))throw new ServiceError('invalid_choice_source',400);
  if(type==='history'||type==='case'){
   // Actual IDs may identify an active Task without any fabricated failed Case.
   const isCase=(await db.query('SELECT id FROM cases WHERE id=$1',[ref.id])).rows.length>0;
   locator={...locator,kind:isCase?'case-history':'task-history',subjectId:query.subjectId??null};if(type==='case'&&!isCase)fail();
   record=await this.readWithin(db,actor,locator);const matched=historyRelevance(record,query);if(!matched)fail();version=sourceFingerprint(matched);
  }else if(type==='capsule'){
   const current=await this.search.capsules.readWithin(db,actor,{capsuleId:ref.id});locator.versionId=current.versionId;record=capsuleList(current);
   source={id:ref.id,versionId:record.versionId,version:record.sourceVersion};
  }else if(type==='task'){
   record=await this.readWithin(db,actor,locator);source={taskId:ref.id,operationId:record.request.operationId};
  }else if(type==='proof'){record=await this.readWithin(db,actor,locator);source={id:ref.id,schemaVersion:2};
  }else if(type==='opportunity'){
   // Resolve the selected opaque opportunity through the current bounded
   // discovery query. Only its typed reference and enum purposes persist.
   let after=null;const seen=new Set();for(;;){const page=await this.search.discovery.queryWithin(db,actor,{...query,after});record=page.items.find(v=>v.id===ref.id);
    if(record)break;if(!page.nextAfter||seen.has(page.nextAfter))fail();seen.add(page.nextAfter);after=page.nextAfter;}
   source=record.opportunityRef;locator={...locator,source,purposes:record.help.purposes};
  }else{
   record=await this.readWithin(db,actor,locator,query);source={kind:type,id:ref.id,ownerId:record.ownerId,declarationId:record.declarationId,declarationHash:record.declarationHash,revision:record.revision,version:record.version};
  }
  version??=sourceFingerprint({record:historyVisibleValue(record),source});if(version!==ref.version)throw new ServiceError('choice_source_changed',409);
  // Read the dependency again with its durable minimal locator; never retain
  // the original search terms/title/environment/context in cloud JSON.
  const durable=await this.readWithin(db,actor,locator);
  if(sourceFingerprint(factual(record))!==sourceFingerprint(factual(durable)))throw new ServiceError('choice_source_changed',409);
  return {ref:{type,...ref},locator,fingerprint:sourceFingerprint(factual(durable)),sourceAuthors:visibleAuthors(durable)};
 }
 async statusWithin(db,actor,dependency){
  let state;try{const current=await this.readWithin(db,actor,dependency.locator);state=sourceFingerprint(factual(current))===dependency.fingerprint?'current':'changed';}
  catch(e){if(!unavailable(e))throw e;state='unavailable';}
  if(state!=='current'){
   const pending=(await db.query("SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=ANY($1::text[]) AND state IN ('requested','review-needed','approved','partial','primary-erased')) AS pending",[dependency.sourceAuthors??[]])).rows[0].pending;
   if(pending)state='temporarily-unavailable';
  }
  return {ref:dependency.ref,state};
 }
 async resultWithin(db,actor,ref){
  if(!actor.scopes?.includes('history'))throw new ServiceError('access_denied',403);
  const history=await this.historyWithin(db,actor,{id:ref.caseId,kind:'case-history',subjectId:null});
  const result=history?.results.find(r=>r.id===ref.id&&r.version===ref.version);if(!result)fail();return result;
 }
}
