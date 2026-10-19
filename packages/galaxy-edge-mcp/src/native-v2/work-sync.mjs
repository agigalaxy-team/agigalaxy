import {randomUUID} from 'node:crypto';
import {mkdir,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import * as z from 'zod/v4';
import {withLocalRead,withLocalWrite} from '../../../galaxy-core/src/storage/write-lock.mjs';
import {createLocalWorkHistory} from '../../../galaxy-core/src/work-history/index.mjs';
import {getLocalUploadPrivacy} from '../../../galaxy-core/src/application/local-operations.mjs';
import {projectWorkHistoryForUpload,allowedUploadDataTypes} from '../../../galaxy-core/src/upload-privacy.mjs';

export const workSyncChoiceSchema=z.strictObject({choiceId:z.uuid(),enabled:z.boolean(),targetAccountId:z.uuid().optional(),workIds:z.array(z.string().min(1).max(512)).max(500),
  includeExisting:z.boolean().default(false),includeFutureWork:z.boolean().default(false),restoreWorkIds:z.array(z.string().min(1).max(512)).max(500).default([])})
  .refine(x=>(!x.enabled||!!x.targetAccountId&&(x.workIds.length>0||x.includeFutureWork))&&x.restoreWorkIds.every(id=>x.workIds.includes(id)));
export const workSyncFlushSchema=z.strictObject({workId:z.string().min(1).max(512).optional()});
export const workCloudTargetSchema=z.strictObject({targetAccountId:z.uuid()});
export const workCloudListSchema=workCloudTargetSchema.extend({after:z.string().min(1).max(512).optional(),limit:z.number().int().min(1).max(50).default(20)});
export const workCloudItemSchema=workCloudTargetSchema.extend({workId:z.string().min(1).max(512)});
const fail=code=>Object.assign(new Error(code),{code});
const codeOf=e=>/^[a-z0-9_-]{1,100}$/.test(e?.code??e?.message??'')?e.code??e.message:'work_sync_unavailable';
const parse=(schema,input)=>{const value=schema.safeParse(input);if(!value.success)throw fail('work_sync_input_invalid');return value.data;};
const exists=async file=>{try{await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const empty=()=>({enabled:false,targetAccountId:null,choiceId:null,workIds:[],includeExisting:false,includeFutureWork:false,restoreWorkIds:[],excludedWorkIds:[],selectedAt:null});
const sameSelection=(a,b)=>a.enabled===b.enabled&&(a.targetAccountId??null)===(b.targetAccountId??null)&&a.includeExisting===b.includeExisting&&a.includeFutureWork===b.includeFutureWork&&JSON.stringify([...a.workIds].sort())===JSON.stringify([...b.workIds].sort());
const ddl=`CREATE TABLE IF NOT EXISTS work_sync_choices(owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(owner_id,endpoint));
CREATE TABLE IF NOT EXISTS work_sync_scopes(owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,work_id TEXT NOT NULL,choice_id TEXT NOT NULL,scope_id TEXT NOT NULL,
 baseline_sequence INTEGER NOT NULL,baseline_environment INTEGER NOT NULL,baseline_summary INTEGER NOT NULL,include_existing INTEGER NOT NULL,selected_at TEXT NOT NULL,
 last_token TEXT,blocked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,endpoint,work_id));
CREATE TABLE IF NOT EXISTS work_sync_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,target_id TEXT NOT NULL,work_id TEXT NOT NULL,
 choice_id TEXT NOT NULL,scope_id TEXT NOT NULL,source_token TEXT NOT NULL,data_json TEXT NOT NULL,expected_revision INTEGER,revision INTEGER,state TEXT NOT NULL,error_code TEXT,updated_at TEXT NOT NULL);`;
const view=row=>({operationId:row.id,workId:row.work_id,targetAccountId:row.target_id,scopeId:row.scope_id,revision:row.revision,state:row.state,error:row.error_code,updatedAt:row.updated_at});
function boundedProjection(data){
  const detailed=data.uploadLevel!=='history-overview',all=data.observations??[],omitted=[];
  if(data.environments.length>1000){data.environments=[];omitted.push('environments');}
  if(detailed){data.observations=all.slice(-2000);data.coverage={observations:{sourceTotal:all.length,included:0,firstSequence:null,lastSequence:null,hasEarlier:false}};}
  const refresh=()=>{if(detailed){const rows=data.observations;data.coverage.observations={sourceTotal:all.length,included:rows.length,firstSequence:rows[0]?.sequence??null,lastSequence:rows.at(-1)?.sequence??null,hasEarlier:rows.length<all.length};if(omitted.length)data.coverage.omittedFields=[...new Set(omitted)];}return Buffer.byteLength(JSON.stringify(data));};
  if(refresh()>524288&&data.summary){delete data.summary;omitted.push('summary');}
  if(refresh()>524288&&data.environments.length){data.environments=[];omitted.push('environments');}
  if(detailed&&refresh()>524288){let low=0,high=data.observations.length;const candidates=data.observations;
    while(low<high){const count=Math.ceil((low+high)/2);data.observations=candidates.slice(candidates.length-count);if(refresh()<=524288)low=count;else high=count-1;}
    data.observations=candidates.slice(candidates.length-low);refresh();
  }
  return data;
}

export function createNativeWorkSync({dataDirectory,endpoint,getIdentity,call,now=()=>new Date().toISOString()}={}){
  const work=createLocalWorkHistory({dataDirectory,getIdentity});let chain=Promise.resolve(),closed=false;
  async function access(write,requested,operation){return (write?withLocalWrite:withLocalRead)(dataDirectory,async directory=>{
    const identity=await getIdentity(directory),owner=typeof identity==='string'?identity:identity?.id??identity?.subjectId;
    if(requested&&requested!==owner)throw fail('work_sync_identity_changed');if(!owner){if(write)throw fail('local_identity_required');return operation(null,null);}
    const folder=join(directory,'work-history'),file=join(folder,'sync.sqlite');if(!write&&!(await exists(file)))return operation(null,owner);
    if(write)await mkdir(folder,{recursive:true,mode:0o700});
    const db=process.versions.bun?new(await import('bun:sqlite')).Database(file,{readonly:!write,create:write}):new(await import('node:sqlite')).DatabaseSync(file,{readOnly:!write});
    try{if(write){await chmod(file,0o600);db.exec(ddl);db.exec('BEGIN IMMEDIATE');}const result=await operation(db,owner);if(write)db.exec('COMMIT');return result;}
    catch(e){if(write){try{db.exec('ROLLBACK');}catch{ /* no transaction */ }}throw e;}finally{db.close();}
  });}
  const choiceWithin=(db,owner)=>db?JSON.parse(db.prepare('SELECT body_json FROM work_sync_choices WHERE owner_id=? AND endpoint=?').get(owner,endpoint)?.body_json??'null')??empty():empty();
  async function settings(){return access(false,null,(db,galaxyId)=>({galaxyId,endpoint,choice:choiceWithin(db,galaxyId),
    sources:db?db.prepare('SELECT work_id AS workId,blocked FROM work_sync_scopes WHERE owner_id=? AND endpoint=?').all(galaxyId,endpoint).map(row=>({...row,blocked:!!row.blocked})):[],
    queue:db?db.prepare('SELECT * FROM work_sync_jobs WHERE owner_id=? AND endpoint=? ORDER BY updated_at DESC LIMIT 100').all(galaxyId,endpoint).map(view):[],localOnly:true}));}
  async function accounts(){return call('/v2/account-archives/accounts',{});}
  async function choose(input){
    const x=parse(workSyncChoiceSchema,input),selected=await settings();if(!selected.galaxyId)throw fail('local_identity_required');
    if(selected.choice.choiceId===x.choiceId){if(!sameSelection(x,selected.choice)||JSON.stringify(x.restoreWorkIds)!==JSON.stringify(selected.choice.restoreWorkIds??[]))throw fail('work_sync_original_choice_changed');return selected;}
    if(sameSelection(x,selected.choice)&&!x.restoreWorkIds.length)return selected;
    const sources=[];
    if(x.enabled){const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});if(privacy.settings.level==='local-only')throw fail('local_upload_type_not_allowed');
      const targets=await accounts();if(targets.subjectId!==selected.galaxyId||!targets.accounts.some(account=>account.accountId===x.targetAccountId&&account.endpoint===endpoint))throw fail('account_target_unavailable');
      for(const workId of new Set(x.workIds)){const source=await work.get({galaxyId:selected.galaxyId,workId,limit:1});if(!source)throw fail('local_work_unavailable');sources.push(source.work);}
    }
    return access(true,selected.galaxyId,(db,owner)=>{
      const previous=choiceWithin(db,owner),sameTarget=(previous.targetAccountId??null)===(x.targetAccountId??null);
      const excluded=new Set(previous.excludedWorkIds??[]);for(const id of previous.workIds)if(!x.workIds.includes(id))excluded.add(id);for(const id of x.workIds)excluded.delete(id);
      const choice={...x,excludedWorkIds:[...excluded],selectedAt:sameTarget&&previous.enabled&&previous.includeFutureWork&&x.includeFutureWork?previous.selectedAt:now()};
      db.prepare('INSERT INTO work_sync_choices(owner_id,endpoint,body_json) VALUES(?,?,?) ON CONFLICT(owner_id,endpoint) DO UPDATE SET body_json=excluded.body_json').run(owner,endpoint,JSON.stringify(choice));
      const save=db.prepare('INSERT INTO work_sync_scopes(owner_id,endpoint,work_id,choice_id,scope_id,baseline_sequence,baseline_environment,baseline_summary,include_existing,selected_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,endpoint,work_id) DO UPDATE SET choice_id=excluded.choice_id,scope_id=excluded.scope_id,baseline_sequence=excluded.baseline_sequence,baseline_environment=excluded.baseline_environment,baseline_summary=excluded.baseline_summary,include_existing=excluded.include_existing,selected_at=excluded.selected_at,last_token=NULL,blocked=0');
      // Unchanged sources keep their baseline, receipts and owner-delete stop.
      if(sameTarget&&x.includeFutureWork&&previous.includeFutureWork)for(const row of db.prepare('SELECT work_id FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND choice_id=?').all(owner,endpoint,previous.choiceId))
        if(!excluded.has(row.work_id)&&!previous.workIds.includes(row.work_id))db.prepare('UPDATE work_sync_scopes SET choice_id=? WHERE owner_id=? AND endpoint=? AND work_id=?').run(x.choiceId,owner,endpoint,row.work_id);
      for(const source of sources){const old=db.prepare('SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?').get(owner,endpoint,source.workId);
        const unchanged=sameTarget&&old&&!x.restoreWorkIds.includes(source.workId)&&(old.blocked||previous.enabled&&previous.workIds.includes(source.workId)&&previous.includeExisting===x.includeExisting);
        if(unchanged)db.prepare('UPDATE work_sync_scopes SET choice_id=? WHERE owner_id=? AND endpoint=? AND work_id=?').run(x.choiceId,owner,endpoint,source.workId);
        else save.run(owner,endpoint,source.workId,x.choiceId,randomUUID(),x.includeExisting?0:source.lastSequence,x.includeExisting?0:source.environmentVersion?.version??0,x.includeExisting?0:source.summaryRevision,x.includeExisting?1:0,now());
      }
      return {galaxyId:owner,endpoint,choice,localOnly:true};
    });
  }
  async function scopeFor(record,selected){return access(true,selected.galaxyId,(db,owner)=>{
    if(choiceWithin(db,owner).choiceId!==selected.choice.choiceId)return null;
    if(selected.choice.excludedWorkIds?.includes(record.work.workId))return null;
    let scope=db.prepare('SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?').get(owner,endpoint,record.work.workId);
    if(scope?.choice_id===selected.choice.choiceId)return scope;
    if(!selected.choice.includeFutureWork||Date.parse(record.work.startedAt)<Date.parse(selected.choice.selectedAt))return null;
    db.prepare('INSERT INTO work_sync_scopes(owner_id,endpoint,work_id,choice_id,scope_id,baseline_sequence,baseline_environment,baseline_summary,include_existing,selected_at) VALUES(?,?,?,?,?,0,0,0,0,?) ON CONFLICT(owner_id,endpoint,work_id) DO UPDATE SET choice_id=excluded.choice_id,scope_id=excluded.scope_id,baseline_sequence=0,baseline_environment=0,baseline_summary=0,include_existing=0,selected_at=excluded.selected_at,last_token=NULL,blocked=0')
      .run(owner,endpoint,record.work.workId,selected.choice.choiceId,randomUUID(),selected.choice.selectedAt);
    return db.prepare('SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?').get(owner,endpoint,record.work.workId);
  });}
  async function allowed(job){
    if(closed)throw fail('work_sync_closed');const selected=await settings();
    const scope=await access(false,job.owner_id,db=>db?.prepare('SELECT scope_id,choice_id,blocked FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?').get(job.owner_id,endpoint,job.work_id));
    if(selected.galaxyId!==job.owner_id||!selected.choice.enabled||selected.choice.targetAccountId!==job.target_id||scope?.scope_id!==job.scope_id||scope.choice_id!==selected.choice.choiceId||scope.blocked)throw fail('work_sync_scope_changed');
    const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});if(privacy.galaxyId!==job.owner_id||privacy.recoveryRequired)throw fail('work_sync_identity_changed');
    return privacy;
  }
  async function mark(job,state,errorCode=null){return access(true,job.owner_id,db=>{
    db.prepare('UPDATE work_sync_jobs SET state=?,error_code=?,updated_at=? WHERE id=?').run(state,errorCode,now(),job.id);
    if(state==='stored')db.prepare('UPDATE work_sync_scopes SET last_token=? WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=?').run(job.source_token,job.owner_id,endpoint,job.work_id,job.scope_id);
    if(state==='deleted')db.prepare('UPDATE work_sync_scopes SET blocked=1 WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=?').run(job.owner_id,endpoint,job.work_id,job.scope_id);
  });}
  async function upload(job){
    if(['blocked-size','local-deleted','superseded'].includes(job.state))return view(job);
    try{await allowed(job);const status=await call('/v2/account-work/status',{workId:job.work_id},{accountId:job.target_id});
      if(status.state==='stored'&&status.lastOperationId===job.id){await mark(job,'stored');return {...view(job),state:'stored',revision:status.revision};}
      if(status.state==='deleted'&&status.scopeId===job.scope_id){await mark(job,'deleted');return {...view(job),state:'deleted'};}
      if(job.expected_revision===null){job=await access(true,job.owner_id,db=>{
        const current=db.prepare('SELECT * FROM work_sync_jobs WHERE id=?').get(job.id);
        if(current.expected_revision===null)db.prepare('UPDATE work_sync_jobs SET expected_revision=?,revision=? WHERE id=?').run(status.revision??0,(status.revision??0)+1,job.id);
        return db.prepare('SELECT * FROM work_sync_jobs WHERE id=?').get(job.id);
      });}
      const latest=await allowed(job),data=JSON.parse(job.data_json),types=data.uploadLevel==='history-overview'?['history-metadata','environment-versions']:['history-metadata','environment-versions','work-summary','work-content'];
      if(types.some(type=>!allowedUploadDataTypes(latest.settings).includes(type))){await mark(job,'superseded','local_upload_range_reduced');return {...view(job),state:'superseded'};}
      const result=await call('/v2/account-work/put',{operationId:job.id,workId:job.work_id,scopeId:job.scope_id,revision:job.revision,expectedRevision:job.expected_revision,data},
        {accountId:job.target_id,localUpload:{dataTypes:types}});
      await mark(job,'stored');return {...view(job),state:'stored',revision:result.revision};
    }catch(e){const code=codeOf(e);
      // A delete may win after status was read but before put. The server's
      // tombstone is authoritative; retain this scope as stopped, not retryable.
      if(code==='account_work_owner_deleted'){await mark(job,'deleted',code);return {...view(job),state:'deleted',error:code};}
      await mark(job,'unknown',code);return {...view(job),state:'unknown',error:code,originalOperationRetained:true};}
  }
  async function source(workId,selected){
    let record=await work.get({galaxyId:selected.galaxyId,workId,limit:1});if(!record)throw fail('local_work_unavailable');
    const scope=await scopeFor(record,selected);if(!scope||scope.blocked)return [];
    const pending=await access(false,selected.galaxyId,db=>db.prepare("SELECT * FROM work_sync_jobs WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=? AND state IN ('unknown','prepared') ORDER BY updated_at").all(selected.galaxyId,endpoint,workId,scope.scope_id));
    const results=[];for(const job of pending){const result=await upload(job);results.push(result);if(!['stored','superseded'].includes(result.state))return results;}
    const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});if(privacy.settings.level==='local-only')return results;
    let token=['window-v1',record.work.lastSequence,record.work.summaryRevision,record.work.environmentVersion?.version??0,privacy.settings.revision].join(':');
    const fresh=await access(false,selected.galaxyId,db=>db.prepare('SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?').get(selected.galaxyId,endpoint,workId));
    if(fresh.last_token===token||!scope.include_existing&&record.work.lastSequence<=scope.baseline_sequence&&(record.work.environmentVersion?.version??0)<=scope.baseline_environment&&record.work.summaryRevision<=scope.baseline_summary)return results;
    const priorAttempt=await access(false,selected.galaxyId,db=>db.prepare('SELECT * FROM work_sync_jobs WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=? AND source_token=? ORDER BY updated_at DESC LIMIT 1').get(selected.galaxyId,endpoint,workId,scope.scope_id,token));
    if(priorAttempt?.state==='blocked-size')return [...results,view(priorAttempt)];
    if(privacy.settings.level!=='history-overview'){
      record=await work.exportWork({galaxyId:selected.galaxyId,workId});
      record.observations=record.observations.filter(item=>item.sequence<=record.work.lastSequence);
      token=['window-v1',record.work.lastSequence,record.work.summaryRevision,record.work.environmentVersion?.version??0,privacy.settings.revision].join(':');
    }
    if(!scope.include_existing){record.observations=record.observations.filter(item=>item.sequence>scope.baseline_sequence&&Date.parse(item.occurredAt??item.observedAt)>=Date.parse(scope.selected_at));
      record.environments=record.environments.filter(item=>item.version>scope.baseline_environment&&Date.parse(item.observedAt)>=Date.parse(scope.selected_at));
    }
    // Explicitly marked Galaxy-managed material stays a current service
    // reference, not an unpermissioned copy inside a generic host observation.
    record.observations=record.observations.map(item=>{
      const managed=item.details?.managedSourceRef||item.source?.locator?.startsWith('galaxy:')||item.source?.kind==='external-material'&&item.source?.locator?.startsWith(endpoint+'/');
      const originalRef=item.details?.managedSourceRef??item.source?.locator;
      const reference=typeof originalRef==='string'?originalRef:Object.fromEntries(['kind','id','version','endpoint','locator'].filter(key=>Object.hasOwn(originalRef??{},key)).map(key=>[key,originalRef[key]]));
      return managed?{...item,content:null,details:{managedSourceRef:reference,bodyExcluded:true}}:item;
    });
    const data=projectWorkHistoryForUpload(privacy.settings,record).data;
    if(!scope.include_existing){delete data.summary;if(Date.parse(data.startedAt)<Date.parse(scope.selected_at))delete data.startedAt;}
    const encoded=JSON.stringify(boundedProjection(data));
    const job=await access(true,selected.galaxyId,(db,owner)=>{
      const existing=db.prepare('SELECT * FROM work_sync_jobs WHERE owner_id=? AND endpoint=? AND work_id=? AND scope_id=? AND source_token=?').get(owner,endpoint,workId,scope.scope_id,token);
      if(existing)return existing;
      const id=randomUUID();db.prepare("INSERT INTO work_sync_jobs(id,owner_id,endpoint,target_id,work_id,choice_id,scope_id,source_token,data_json,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?)")
        .run(id,owner,endpoint,selected.choice.targetAccountId,workId,selected.choice.choiceId,scope.scope_id,token,encoded,now());return db.prepare('SELECT * FROM work_sync_jobs WHERE id=?').get(id);
    });
    results.push(await upload(job));return results;
  }
  async function run({workId,host,sessionId}={}){
    const selected=await settings();if(!selected.choice.enabled)return {state:'not-selected',items:[],networkStarted:false};
    let ids=workId?[workId]:[...selected.choice.workIds];
    if(host&&sessionId){const current=await work.get({galaxyId:selected.galaxyId,host,sessionId,limit:1});ids=current?[current.work.workId]:[];}
    else if(selected.choice.includeFutureWork){let after;do{const page=await work.list({galaxyId:selected.galaxyId,limit:100,...(after?{after}:{})});ids.push(...page.items.filter(item=>Date.parse(item.startedAt)>=Date.parse(selected.choice.selectedAt)).map(item=>item.workId));after=page.nextAfter;}while(after);}
    const items=[];for(const id of new Set(ids)){try{items.push(...await source(id,selected));}catch(e){items.push({workId:id,state:'not-synced',error:codeOf(e)});}}return {state:'processed',items};
  }
  function enqueue(input){const operation=chain.catch(()=>{}).then(()=>run(input));chain=operation;return operation;}
  async function listCloud(input){const {targetAccountId,...x}=parse(workCloudListSchema,input);return call('/v2/account-work/list',x, {accountId:targetAccountId});}
  async function getCloud(input){const x=parse(workCloudItemSchema,input);return call('/v2/account-work/get',{workId:x.workId},{accountId:x.targetAccountId});}
  async function deleteCloud(input){const x=parse(workCloudItemSchema,input),result=await call('/v2/account-work/delete',{workId:x.workId},{accountId:x.targetAccountId});
    await access(true,null,(db,owner)=>{if(choiceWithin(db,owner).targetAccountId===x.targetAccountId)db.prepare('UPDATE work_sync_scopes SET blocked=1 WHERE owner_id=? AND endpoint=? AND work_id=?').run(owner,endpoint,x.workId);db.prepare("UPDATE work_sync_jobs SET state='deleted',data_json='null' WHERE owner_id=? AND endpoint=? AND work_id=? AND target_id=?").run(owner,endpoint,x.workId,x.targetAccountId);});return result;}
  async function cancelLocalSource({workId}){return access(true,null,(db,owner)=>{db.prepare("UPDATE work_sync_jobs SET state='local-deleted',data_json='null' WHERE owner_id=? AND endpoint=? AND work_id=?").run(owner,endpoint,workId);db.prepare('UPDATE work_sync_scopes SET blocked=1 WHERE owner_id=? AND endpoint=? AND work_id=?').run(owner,endpoint,workId);return {workId,localQueueCleared:true,cloudChanged:false};});}
  return Object.freeze({settings,accounts,choose,flush:input=>enqueue(parse(workSyncFlushSchema,input??{})),onSessionComplete:input=>enqueue(input),listCloud,getCloud,deleteCloud,cancelLocalSource,
    async close(){closed=true;await chain.catch(()=>{});}});
}
