import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {operationsOperatorNamesWithin} from "../src/operations/accounts/history-identities.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {OperationsForumContentService} from "../src/operations/public-content/service.mjs";
import {OperationsSearchQualityService} from "../src/operations/search-quality/service.mjs";
import {OperationsCommunityService} from "../src/operations/community/service.mjs";
import {AccountChatGovernanceService} from "../src/chat/reports/service.mjs";
import {searchQualityFixedConstraints,nativeSearchSettings} from '../src/shared/operations-search-quality-schema.mjs';
import {OperationsRecommendationService} from "../src/operations/recommendations/service.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';
import {recommendationHistory} from "../../../apps/galaxy-admin/src/lib/recommendation/recommendation-view-model.ts";

test('history labels use current same-endpoint principals, preserve immutable IDs and never add names to withheld or ordinary-account chat views',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
 const endpoint='https://history-labels.example.invalid',other='https://foreign-history.example.invalid',now=()=>2000000000,
  at=new Date(now()*1000).toISOString(),later=new Date((now()+600)*1000).toISOString(),past=new Date((now()-181*86400)*1000).toISOString(),
  known='a'.repeat(64),blank='b'.repeat(64),foreign='c'.repeat(64),missing='d'.repeat(64),executor='executor:'+randomUUID(),
  actor={kind:'business-operator',operatorId:known,role:'administrator',endpoint},targetId=randomUUID(),reportId=randomUUID();
 for(const [id,scope,name]of [[known,endpoint,' 当前运营名称 '],[blank,endpoint,' '],[foreign,other,'另一端点不得借用的名称']])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://management.example.invalid',$1,$3,$4,$4)`,[id,scope,name,at]);
 const settings={synonyms:[],rankingMode:'relevance',fixedConstraints:searchQualityFixedConstraints},actors=[known,blank,foreign,missing,executor];
 for(const [index,id]of actors.entries()){
  await db.query(`INSERT INTO operations_forum_content_events_v1(id,endpoint,target_kind,target_id,kind,operator_id,operation_id,source_version,revision,reason,changes,created_at)
   VALUES($1,$2,'post',$3,'curation',$4,$5,1,$6,'既有操作说明',$7,$8)`,[randomUUID(),endpoint,targetId,id,randomUUID(),index+1,{topic:{before:'life',after:'learning'}},at]);
  const versionId=randomUUID();await db.query(`INSERT INTO operations_search_quality_versions_v1(id,endpoint,version,settings,native_settings,kind,operator_id,created_at)
   VALUES($1,$2,$3,$4,$5,'draft',$6,$7)`,[versionId,endpoint,index+1,settings,nativeSearchSettings(settings),id,at]);
  await db.query(`INSERT INTO operations_search_quality_operations_v1(endpoint,operation_id,operator_id,kind,request_hash,input,version_id,phase,changes,reason,created_at,updated_at)
   VALUES($1,$2,$3,'draft',$4,$5,$6,'applied',$7,'既有配置说明',$8,$8)`,[endpoint,randomUUID(),id,'0'.repeat(64),{},versionId,{},at]);
 }
 await db.query(`INSERT INTO operations_forum_content_events_v1(id,endpoint,target_kind,target_id,kind,operator_id,operation_id,source_version,revision,reason,changes,created_at)
  VALUES($1,$2,'post',$3,'curation',$4,$5,1,1,'外端点记录',$6,$7)`,[randomUUID(),other,targetId,known,randomUUID(),{},at]);
 const before=(await db.query('SELECT id,operator_id,reason,changes FROM operations_forum_content_events_v1 ORDER BY sequence')).rows;
 const beforeSearch=(await db.query('SELECT operation_id,operator_id,input,changes,reason FROM operations_search_quality_operations_v1 ORDER BY sequence')).rows;
 await db.exec('SET ROLE galaxy_api');
 let nameQueries=0;const apiDb={query:async(sql,args)=>{if(sql.includes('FROM operations_operator_principals_v1'))nameQueries++;return db.query(sql,args);}};
 const names=await operationsOperatorNamesWithin(apiDb,{endpoint,operatorIds:[...actors,known,null]});
 assert.equal(names.get(known),'当前运营名称');assert.equal(names.get(blank),null);for(const id of [foreign,missing,executor])assert(!names.has(id));assert.equal(nameQueries,1);
 const content=Object.assign(Object.create(OperationsForumContentService.prototype),{endpoint}),history=await content.historyWithin(apiDb,'post',targetId);
 assert.equal(history.items.length,5);assert.equal(history.items.find(item=>item.operatorId===known).operatorDisplayName,'当前运营名称');
 for(const id of [blank,foreign,missing,executor])assert.equal(history.items.find(item=>item.operatorId===id).operatorDisplayName,null);
 const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async current=>current.operatorId===known?'administrator':null}),
  search=new OperationsSearchQualityService({db:apiDb,endpoint,permissions,now});
 const searchHistory=await search.history(actor,{limit:2});assert.equal(searchHistory.items.length,2);assert(searchHistory.nextAfter);
 const all=[];let after;do{const page=await search.history(actor,{limit:2,...(after?{after}:{})});all.push(...page.items);after=page.nextAfter;}while(after);
 assert.equal(new Set(all.map(item=>item.id)).size,5);assert.equal(all.find(item=>item.operatorId===known).operatorDisplayName,'当前运营名称');
 for(const id of [blank,foreign,missing,executor])assert.equal(all.find(item=>item.operatorId===id).operatorDisplayName,null);

 // Existing source/party qualification is supplied as an explicit fixture here.
 // Only the new name lookup uses real PG/galaxy_api; these are not full case or
 // chat authority tests, and they do not exercise a new material-read grant.
 const decisions=actors.map((id,index)=>({id:randomUUID(),version:index+1,operator_id:id,resolution:'dismissed',summary:'既有案件结论',restriction_action:'keep',effect_until:null,created_at:at})),
  decisionRows=[{id:randomUUID(),version:0,actor_kind:'identity',actor_id:known,resolution:'dismissed',restriction_action:null,effect_until:null,created_at:at},...decisions.map(row=>({...row,actor_kind:'business-operator',actor_id:row.operator_id}))];
 let independent=true;const caseDb={query:async(sql,args)=>{
  if(sql.includes('FROM forum_operations_events_v1')&&!sql.includes('UNION ALL'))return{rows:structuredClone(decisions)};
  if(sql.includes('UNION ALL SELECT id,version'))return{rows:structuredClone(decisionRows)};
  return apiDb.query(sql,args);
 }},cases=Object.assign(Object.create(OperationsCommunityService.prototype),{endpoint,now,maxHideSeconds:60,forum:{policy:{maxReportEvents:20,maxAppeals:3}},
  independentWithin:async()=>independent,sourceWithin:async()=>({availability:'available',content:null,publishedUntil:now()+600})}),
  caseRow={id:reportId,target:{kind:'reply',id:targetId},version:5,state:'resolved',reporter_account_id:null,target_author_account_id:null,operations_disclosed:false,created_at:at,audit_until:later,decision_event_id:decisions[0].id};
 const caseNamesBefore=nameQueries,view=await cases.reportViewWithin(caseDb,caseRow,actor,{detail:true});assert.equal(nameQueries-caseNamesBefore,1);
 assert.equal(view.events.find(event=>event.operatorId===known).operatorDisplayName,'当前运营名称');assert.equal(view.currentDecision.operatorDisplayName,'当前运营名称');assert.equal(view.initialDecision.operatorDisplayName,null,'identity actor must not be treated as a management principal');
 for(const id of [foreign,missing,executor])assert.equal(view.events.find(event=>event.operatorId===id).operatorDisplayName,null);
 independent=false;const withheld=await cases.reportViewWithin(caseDb,caseRow,actor,{detail:true});assert.deepEqual(withheld.events,[]);assert.equal(withheld.initialDecision,null);independent=true;

 const eventRows=[{id:randomUUID(),kind:'review',version:1,created_at:at,actor_kind:'business-operator',operator_id:known,account_id:null,summary:'既有受权记录',input:{}},
  {id:randomUUID(),kind:'review',version:2,created_at:at,actor_kind:'business-operator',operator_id:executor,account_id:null,summary:'程序记录',input:{}}];
 let operator=true,sourceAvailable=true;const decision={eventId:randomUUID(),operatorId:known,at,action:'hide',sourceRevision:1},
  chat=Object.assign(Object.create(AccountChatGovernanceService.prototype),{endpoint,now,
   contextWithin:async()=>({operator,independent:true,reporter:!operator,party:false,canReadMaterials:true,canManageCase:false}),
   currentTargetWithin:async()=>null,messageVisibility:{caseBlockedWithin:async()=>false},
   materialsWithin:async()=>[{state:sourceAvailable?'available':'unavailable',sourceExpiresAt:later,attachments:[],moderation:{initialDecision:structuredClone(decision),currentDecision:structuredClone(decision)}}]}),
  chatDb={query:async(sql,args)=>sql.includes('SELECT count(*) AS n FROM account_chat_governance_materials_v1')?{rows:[{n:'1'}]}:sql.includes('SELECT * FROM account_chat_governance_events_v1')?{rows:structuredClone(eventRows)}:apiDb.query(sql,args)},
  chatRow={id:reportId,room_id:randomUUID(),version:2,target_version:1,state:'reviewing',created_at:at,updated_at:at,closed_at:null,restriction_until:null};
 const chatNamesBefore=nameQueries,chatView=await chat.viewWithin(chatDb,chatRow,actor,{operator:true});assert.equal(nameQueries-chatNamesBefore,1);assert.equal(chatView.events[0].operatorDisplayName,'当前运营名称');assert.equal(chatView.events[1].operatorDisplayName,null);assert.equal(chatView.materials[0].moderation.initialDecision.operatorDisplayName,'当前运营名称');
 sourceAvailable=false;const unavailable=await chat.viewWithin(chatDb,chatRow,actor,{operator:true});assert.equal(unavailable.materials[0].moderation.initialDecision.operatorDisplayName,null);
 const expired=await chat.viewWithin(chatDb,{...chatRow,closed_at:past},actor,{operator:true});assert(expired.events.every(event=>event.operatorId===null&&event.operatorDisplayName===null));
 operator=false;const ordinaryBefore=nameQueries,ordinary=await chat.viewWithin(chatDb,chatRow,{accountId:randomUUID()});assert.equal(nameQueries,ordinaryBefore);assert(ordinary.events.every(event=>!Object.hasOwn(event,'operatorDisplayName')));assert(!Object.hasOwn(ordinary.materials[0].moderation.initialDecision,'operatorDisplayName'));

 await db.exec('RESET ROLE');await db.query('UPDATE operations_operator_principals_v1 SET display_name=$2 WHERE operator_id=$1',[known,'已更新运营名称']);await db.exec('SET ROLE galaxy_api');
 assert.equal((await content.historyWithin(apiDb,'post',targetId)).items.find(item=>item.operatorId===known).operatorDisplayName,'已更新运营名称');
 assert.equal((await search.history(actor)).items.find(item=>item.operatorId===known).operatorDisplayName,'已更新运营名称');
 const afterContent=(await db.query('SELECT id,operator_id,reason,changes FROM operations_forum_content_events_v1 ORDER BY sequence')).rows,
  afterSearch=(await db.query('SELECT operation_id,operator_id,input,changes,reason FROM operations_search_quality_operations_v1 ORDER BY sequence')).rows;
 assert.deepEqual(afterContent,before);assert.deepEqual(afterSearch,beforeSearch);
});

test('recommendation history rechecks current access after name lookup and projects bounded optional labels without changing actor IDs',async()=>{
 const endpoint='https://recommendation-label.example.invalid',known='a'.repeat(64),executor='executor:'+randomUUID(),now=()=>2000000000,
  actor={kind:'business-operator',operatorId:known,endpoint},at=new Date(now()*1000).toISOString(),
  rows=[known,executor].map((operator_id,index)=>({id:randomUUID(),sequence:String(index+1),kind:'policy-updated',operator_id,revision:index+1,theme_key:'category:learning',changes:{enabled:{before:false,after:true}},reason:'既有说明',created_at:at}));
 let allowed=true,revokeDuringLookup=false,authorizations=0;
 const service=new OperationsRecommendationService({endpoint,now,db:{query:async(sql,args)=>{
  if(sql.includes('FROM operations_recommendation_events_v1'))return{rows};
  assert(sql.includes('FROM operations_operator_principals_v1'));assert.equal(args[0],endpoint);assert.deepEqual(args[1],[known]);
  if(revokeDuringLookup)allowed=false;return{rows:[{operator_id:known,display_name:' 推荐运营姓名 '}]};
 }},permissions:{requireAction:async(current,action)=>{authorizations++;assert.equal(current,actor);assert.equal(action,'recommendations.read');if(!allowed)throw new ServiceError('operations_permission_denied',403);return current;}}});
 const result=await service.history(actor),projected=recommendationHistory(result);assert.equal(authorizations,2);assert(projected);
 assert.equal(projected.items[0].operatorId,known);assert.equal(projected.items[0].operatorDisplayName,'推荐运营姓名');assert.equal(projected.items[1].operatorId,executor);assert.equal(projected.items[1].operatorDisplayName,null);
 for(const invalid of ['行内\n额外内容','x'.repeat(201),{name:'不得展开对象'}]){const guarded=recommendationHistory({...result,items:[{...result.items[0],operatorDisplayName:invalid}]});assert.equal(guarded.items[0].operatorDisplayName,null);assert.equal(guarded.items[0].operatorId,known);}
 const legacy=recommendationHistory({...result,items:[{...result.items[0],operatorDisplayName:undefined}]});assert.equal(legacy.items[0].operatorDisplayName,null);
 revokeDuringLookup=true;await assert.rejects(service.history(actor),{code:'operations_permission_denied'});assert.equal(authorizations,4);
});
