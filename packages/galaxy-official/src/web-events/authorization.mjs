import {authenticate} from '../adapters/http/request.mjs';
import {ServiceError} from '../shared/service-error.mjs';
import {webEventSources,webEventSourceAliases,operationsEventPermissions,webModules,operationsModules} from './topics.mjs';

const denied=()=>new ServiceError('web_events_access_denied',403);
const unavailable=()=>new ServiceError('web_events_authority_unavailable',503);
const authFailure=error=>[401,403,404,409,410].includes(error?.status);

// Every source check calls the existing current authority. A source row version
// cannot renew Consent, membership, binding, expiry, role or account authority.
export function createWebEventAuthorization({pool,endpoint,officialAccounts,communityAccounts,access,
 authorizeOperator,businessAdmin,forum,chat,assistance,projects,capsules,inbox,builders,informationWatches,choices,ciV2}) {
 if(!pool||!endpoint)throw new Error('Web event endpoint and database required');
 async function authorizeConnection({request,requestId,surface}) {
  let actor;
  if(surface==='admin'){
   if(!authorizeOperator||!businessAdmin)throw unavailable();
   actor=await authorizeOperator(request,{write:false,requestId});
   if(actor?.endpoint!==endpoint)throw denied();
  } else if(request.headers.authorization!==undefined){
   if(!access)throw unavailable();
   actor=await authenticate(request,access,'binding');
   const accountId=request.headers['x-galaxy-account-id'];
   if(accountId!==undefined){
    if(typeof accountId!=='string'||! /^[0-9a-f-]{36}$/i.test(accountId))throw denied();
    actor={...actor,accountId};
   }
   actor=await access.runAuthorized(actor,'binding',async()=>({...actor,endpoint}));
  }else if(request.headers['x-galaxy-account-id']!==undefined){
   if(!officialAccounts)throw unavailable();
   actor=await officialAccounts.actionActor(request,{write:false});
   if(actor.endpoint!==endpoint)throw denied();
  }else actor=null;
  const identity=surface==='admin'?actor.operatorId??actor.subject:actor?.kind==='official-account'?actor.accountId:actor?.subjectId??'anonymous';
  if(typeof identity!=='string'||!identity)throw denied();
  return {actor,identity,endpoint,surface};
 }
 async function authorizeModule(connection,module){
  if(connection.surface==='admin'){
   const action=operationsEventPermissions[module];if(!action)return false;
   try{await businessAdmin.authorizeAction(connection.actor,action);return true;}catch(error){if(authFailure(error))return false;throw error;}
  }
  return webModules.includes(module);
 }
 async function authorizeSource(connection,event){
  const {actor}=connection,ref=event.source_ref;
  if(connection.endpoint!==endpoint)return false;
  if(webEventSources[event.source_table]!==event.module&&!webEventSourceAliases[event.source_table]?.includes(event.module)||event.endpoint&&event.endpoint!==endpoint)return false;
  if(!await authorizeModule(connection,event.module))return false;
  // Management read permission is scoped to this exact configured endpoint.
  // The event source never enters the browser: no DTO/body/ref is broadcast.
  if(connection.surface==='admin'){
   if(!ref||!Object.keys(ref).length)return false;
   // Table comes exclusively from the fixed producer catalog. Read only its
   // endpoint; never materialize credential/configuration columns in this path.
   const {_operation,_version,...locator}=ref;
   const rows=(await pool.query(`SELECT to_jsonb(source)->>'endpoint' AS endpoint FROM ${event.source_table} source WHERE to_jsonb(source) @> $1::jsonb LIMIT 1`,[JSON.stringify(locator)])).rows;
   if(!rows.length)return 'reset';
   return !rows[0].endpoint||rows[0].endpoint===endpoint;
  }
  try{
   if(event.module==='site-content'){
    const row=(await pool.query(`SELECT id,state,published_at,result FROM site_publications_v1 WHERE endpoint=$1 AND state='published' AND published_at IS NOT NULL ORDER BY sequence DESC LIMIT 1`,[endpoint])).rows[0];
    return !!row&&row.id===ref.id&&row.result?.publicationId===row.id&&!row.result?.activationPending;
   }
   if(event.module==='information'&&webEventSources[event.source_table]!=='information'&&event.source_table!=='information_watch_changes_v2'){
    const allowed=await authorizeSource(connection,{...event,module:webEventSources[event.source_table]});return allowed?'reset':false;
   }
   if(event.module==='builders'){
    if(!builders)return false;
    let id=ref.builder_id??ref.id;
    if(event.source_table==='builder_probes')id=(await pool.query('SELECT builder_id FROM builder_events WHERE id=$1',[ref.request_id])).rows[0]?.builder_id;
    if(!id)return false;
    const reader=actor?.kind==='official-account'?null:actor;
    try{await builders.get(reader,{builderId:id});return true;}catch(error){
     if(reader&&authFailure(error)){await builders.manage(reader,{builderId:id});return 'reset';}throw error;
    }
   }
   if(event.module==='information'){
    if(!actor||actor.kind==='official-account'||!informationWatches||ref.subject_id!==actor.subjectId)return false;
    await informationWatches.list(actor,{watchId:ref.watch_id??ref.id});return true;
   }
   if(event.module==='choice-sync'){
    if(!actor||actor.kind==='official-account'||!choices||ref.subject_id!==actor.subjectId)return false;
    if(event.source_table==='choice_snapshot_preferences')await choices.preferences(actor);
    else await choices.get(actor,{snapshotId:ref.snapshot_id});return true;
   }
   if(event.module==='ci'){
    if(!actor||actor.kind==='official-account'||!ciV2)return false;
    if(event.source_table==='ci_proofs_v2'){
     if(ref.subject_id!==actor.subjectId)return false;await ciV2.getProof(actor,{id:ref.id});
    }else{const id=event.source_table==='ci_observations_v2'?ref.request_id:ref.id;
     const owner=(await pool.query('SELECT subject_id FROM ci_requests_v2 WHERE id=$1',[id])).rows[0];if(owner?.subject_id!==actor.subjectId)return false;
     await ciV2.get(actor,{id});}
    return true;
   }
   if(event.module==='capsules'){
    if(!capsules)return false;
    const view=await capsules.getV2(actor?.kind==='official-account'?null:actor,{capsuleId:ref.capsule_id??ref.id});
    return view?.version?true:'reset';
   }
   if(event.module==='notifications'){
    if(!actor||actor.kind==='official-account'||!inbox)return false;
    const kinds={chat_message_refs:'room-message',chat_decisions:'room-invite',task_events:'task-v2',task_comment_events_v2:'task-comment',
     capsule_events:'capsule',incident_notices:'incident',assistance_events:'assistance',context_grants:'context',context_acceptances:'context-accept',
     comment_governance_events_v2:'comment-governance',qualification_permission_request_events:'qualification-request',information_watch_changes_v2:'information-change'};
    if(kinds[event.source_table])return await inbox.run(actor,false,async db=>{
     await inbox.oneWithin(db,actor,`${kinds[event.source_table]}:${ref.message_id??ref.decision_id??ref.id}`);return 'reset';
    });
    if(ref.subject_id!==actor.subjectId)return false;
    return await inbox.run(actor,false,async()=> 'reset');
   }
   if(event.module==='forum'){
    if(!forum)throw unavailable();
    let view;
    if(event.source_table==='forum_replies_v1')view=await forum.getReply(ref.id,actor);
    else if(event.source_table==='forum_versions_v1')view=await forum.getVersion(ref.post_id,ref.id,actor);
    else if(event.source_table==='forum_posts_v1')view=await forum.getPost(ref.id,actor);
    else return false; // Permission-row changes are covered by the authorization reset below.
    return view?.availability==='available'?true:'reset';
   }
   if(event.module==='chat'){
    if(!actor||!chat||!ref.room_id)return false;
    await chat.get(actor,ref.room_id);return true;
   }
   if(event.module==='tasks'){
    if(!assistance)return false;
    const id=ref.task_id??ref.id;if(!id)return false;
    // Website account authority does not impersonate a signed Galaxy identity.
    if(actor&&actor.kind!=='official-account')await assistance.getTask(actor,id);
    else await assistance.getPublicTask(id);
    return true;
   }
   if(event.module==='projects'){
    if(!projects)return false;
    await projects.get(actor?.kind==='official-account'?null:actor,ref.project_id??ref.id);return true;
   }
   if(['account','account-work','bookmarks','follows'].includes(event.module)){
    if(!actor||!communityAccounts)return false;
    return await communityAccounts.runAuthorized(actor,'binding',async(db,_authorization,current)=>{
     if(!current?.accountId||current.accountId!==ref.account_id)return false;
     const account=(await db.query('SELECT id FROM community_accounts WHERE id=$1 AND endpoint=$2',[current.accountId,endpoint])).rows[0];
     return !!account;
    });
   }
   if(event.module==='contacts')return !!actor&&[ref.initiator_id,ref.recipient_id].includes(actor.subjectId)&&await access.runAuthorized(actor,'binding',async()=>true);
   return false;
  }catch(error){if(authFailure(error))return ref._operation==='DELETE'?'reset':false;throw error;}
 }
 return {authorizeConnection,authorizeModule,authorizeSource,modules:surface=>surface==='admin'?operationsModules:webModules};
}
