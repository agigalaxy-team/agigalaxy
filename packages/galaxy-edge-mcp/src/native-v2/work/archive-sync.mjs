import {randomUUID} from 'node:crypto';
const compareText=(left,right)=>left<right?-1:left>right?1:0;
import {mkdir,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import * as z from 'zod/v4';
import {withLocalRead,withLocalWrite} from '../../../../galaxy-core/src/storage/write-lock.mjs';
import {createLocalConversationArchive} from '../../../../galaxy-core/src/conversation-archive/index.mjs';
import {createLocalWorkHistory} from '../../../../galaxy-core/src/work-history/index.mjs';
import {getLocalUploadPrivacy} from '../../../../galaxy-core/src/application/local-operations.mjs';
import {allowsUploadDataType,projectConversationForUpload} from '../../../../galaxy-core/src/upload-privacy.mjs';
import {assertNoWorkCredentials} from '../../../../galaxy-core/src/local-data-redaction.mjs';

export const archiveSyncChoiceSchema=z.strictObject({choiceId:z.uuid(),enabled:z.boolean(),targetAccountId:z.uuid().optional(),archiveSessionIds:z.array(z.uuid()).max(500),restoreArchiveSessionIds:z.array(z.uuid()).max(500).default([])})
  .refine(x=>(!x.enabled||!!x.targetAccountId&&x.archiveSessionIds.length>0)&&x.restoreArchiveSessionIds.every(id=>x.archiveSessionIds.includes(id)));
export const archiveCloudTargetSchema=z.strictObject({targetAccountId:z.uuid()});
export const archiveCloudListSchema=archiveCloudTargetSchema.extend({after:z.string().min(1).max(512).optional(),limit:z.number().int().min(1).max(100).optional()});
export const archiveCloudItemSchema=archiveCloudTargetSchema.extend({id:z.uuid()});
export const archiveCloudExportSchema=archiveCloudItemSchema.extend({sequence:z.number().int().nonnegative().default(0)});
export const archiveSyncFlushSchema=z.strictObject({archiveSessionId:z.uuid().optional()});
const error=code=>Object.assign(new Error(code),{code});
const codeOf=e=>/^[a-z0-9_-]{1,100}$/.test(e?.code??e?.message??'')?e.code??e.message:'archive_sync_unavailable';
const exists=async file=>{try{await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const parse=(schema,value)=>{const parsed=schema.safeParse(value);if(!parsed.success)throw error('archive_sync_input_invalid');return parsed.data;};
const ddl=`CREATE TABLE IF NOT EXISTS sync_choices(owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(owner_id,endpoint));
CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,endpoint TEXT NOT NULL,target_id TEXT NOT NULL,archive_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL,scope_id TEXT NOT NULL,choice_id TEXT NOT NULL,title TEXT NOT NULL,selection_json TEXT NOT NULL,
 state TEXT NOT NULL,chunk_count INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error_code TEXT,
 UNIQUE(owner_id,endpoint,target_id,archive_id,source_revision,scope_id));
CREATE TABLE IF NOT EXISTS sync_chunks(job_id TEXT NOT NULL,sequence INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(job_id,sequence));`;
const defaultChoice=()=>({enabled:false,choiceId:null,targetAccountId:null,archiveSessionIds:[],scopeIds:{},revision:0});
const jobView=row=>({id:row.id,archiveSessionId:row.archive_id,sourceRevision:row.source_revision,targetAccountId:row.target_id,
  scopeId:row.scope_id,state:row.state,chunkCount:row.chunk_count,updatedAt:row.updated_at,error:row.error_code??null});
const splitUtf8=text=>{
  const bytes=Buffer.from(text,'utf8'),chunks=[];
  if(bytes.length>64*1024*1024)throw error('local_archive_snapshot_too_large');
  for(let start=0;start<bytes.length;){let end=Math.min(start+262144,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    chunks.push(bytes.subarray(start,end).toString('utf8'));start=end;}
  return chunks;
};

/** A private, owner/account/source-scoped immutable queue. No model, cookie or
 * key material is stored. A prepared original is reconciled before resuming. */
export function createNativeArchiveSync({dataDirectory,endpoint,getIdentity,call,now=()=>new Date().toISOString()}={}) {
  const archive=createLocalConversationArchive({dataDirectory,getIdentity});
  const work=createLocalWorkHistory({dataDirectory,getIdentity});
  let flushing=null,closed=false;
  async function access(write,requested,operation){return (write?withLocalWrite:withLocalRead)(dataDirectory,async directory=>{
    const identity=await getIdentity(directory),owner=typeof identity==='string'?identity:identity?.id??identity?.subjectId;
    if(requested&&requested!==owner)throw error('archive_sync_identity_changed');
    if(!owner){if(write)throw error('local_identity_required');return operation(null,null);}
    const folder=join(directory,'conversation-archive'),file=join(folder,'sync.sqlite');
    if(!write&&!(await exists(file)))return operation(null,owner);
    if(write)await mkdir(folder,{recursive:true,mode:0o700});
    const db=process.versions.bun?new(await import('bun:sqlite')).Database(file,{readonly:!write,create:write})
      :new(await import('node:sqlite')).DatabaseSync(file,{readOnly:!write});
    try{if(write){await chmod(file,0o600);db.exec(ddl);db.exec('BEGIN IMMEDIATE');}const result=await operation(db,owner);if(write)db.exec('COMMIT');return result;}
    catch(e){if(write){try{db.exec('ROLLBACK');}catch{ /* no transaction */ }}throw e;}finally{db.close();}
  });}
  const choiceWithin=(db,owner)=>db?JSON.parse(db.prepare('SELECT body_json FROM sync_choices WHERE owner_id=? AND endpoint=?').get(owner,endpoint)?.body_json??'null')??defaultChoice():defaultChoice();
  async function settings(){return access(false,null,(db,galaxyId)=>{const choice=choiceWithin(db,galaxyId);return {galaxyId,endpoint,choice,
    stoppedArchiveSessionIds:db?Object.entries(choice.scopeIds).filter(([id,scope])=>db.prepare("SELECT 1 FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='deleted' LIMIT 1").get(galaxyId,endpoint,id,scope)).map(([id])=>id):[],
    queue:db?db.prepare('SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? ORDER BY created_at DESC LIMIT 100').all(galaxyId,endpoint).map(jobView):[],localOnly:true};});}
  async function accounts(){if(!call)throw error('archive_sync_transport_unavailable');return call('/v2/account-archives/accounts',{});}
  async function choose(input){
    const x=parse(archiveSyncChoiceSchema,input),before=await settings();
    if(!before.galaxyId)throw error('local_identity_required');
    const unchanged=before.choice.enabled===x.enabled&&before.choice.targetAccountId===(x.targetAccountId??null)&&JSON.stringify([...before.choice.archiveSessionIds].sort(compareText))===JSON.stringify([...new Set(x.archiveSessionIds)].sort(compareText));
    if(before.choice.choiceId===x.choiceId){if(!unchanged||JSON.stringify(before.choice.restoreArchiveSessionIds??[])!==JSON.stringify(x.restoreArchiveSessionIds))throw error('archive_sync_original_choice_changed');return before;}
    if(unchanged&&!x.restoreArchiveSessionIds.length)return before;
    const ids=[...new Set(x.archiveSessionIds)];
    if(x.enabled){const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});
      if(privacy.galaxyId!==before.galaxyId||ids.some(id=>!allowsUploadDataType(privacy.settings,'full-conversation',{sessionId:id})))throw error('upload_privacy_conversation_scope_not_allowed');
      const available=await accounts();if(available.subjectId!==before.galaxyId||!available.accounts.some(account=>account.accountId===x.targetAccountId&&account.endpoint===endpoint))throw error('account_target_unavailable');
      for(const id of ids){const source=await archive.exportSession({galaxyId:before.galaxyId,archiveSessionId:id,limit:1});if(!source)throw error('local_archive_session_unavailable');}
    }
    return access(true,before.galaxyId,(db,galaxyId)=>{
      const previous=choiceWithin(db,galaxyId);
      if(previous.choiceId===x.choiceId)return {galaxyId,endpoint,choice:previous,localOnly:true};
      const sameTarget=previous.targetAccountId===(x.targetAccountId??null),scopeIds=sameTarget?{...previous.scopeIds}:{};
      for(const id of ids){const prior=sameTarget&&previous.scopeIds[id],stopped=prior&&db.prepare("SELECT 1 FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='deleted' LIMIT 1").get(galaxyId,endpoint,id,prior);
        if(!prior||x.restoreArchiveSessionIds.includes(id)||!stopped&&(!previous.enabled||!previous.archiveSessionIds.includes(id)))scopeIds[id]=randomUUID();
      }
      const choice={...x,targetAccountId:x.targetAccountId??null,archiveSessionIds:ids,scopeIds,revision:previous.revision+1};
      db.prepare('INSERT INTO sync_choices(owner_id,endpoint,body_json) VALUES(?,?,?) ON CONFLICT(owner_id,endpoint) DO UPDATE SET body_json=excluded.body_json').run(galaxyId,endpoint,JSON.stringify(choice));
      return {galaxyId,endpoint,choice,localOnly:true};
    });
  }
  async function allowed(job){
    if(closed)throw error('archive_sync_closed');
    const selection=await settings(),choice=selection.choice;
    if(selection.galaxyId!==job.owner_id||!choice.enabled||choice.targetAccountId!==job.target_id||choice.scopeIds[job.archive_id]!==job.scope_id||!choice.archiveSessionIds.includes(job.archive_id))throw error('archive_sync_scope_changed');
    const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});
    if(privacy.recoveryRequired||privacy.galaxyId!==job.owner_id||!allowsUploadDataType(privacy.settings,'full-conversation',{sessionId:job.archive_id}))throw error('upload_privacy_conversation_scope_not_allowed');
  }
  async function send(job,operation,input,{material=false}={}){
    await allowed(job);
    return call('/v2/account-archives/'+operation,input,{accountId:job.target_id,
      ...(material?{localUpload:{dataTypes:['full-conversation'],sessionId:job.archive_id}}:{})});
  }
  async function mark(job,state,errorCode=null){return access(true,job.owner_id,db=>{
    db.prepare('UPDATE sync_jobs SET state=?,error_code=?,updated_at=? WHERE id=? AND owner_id=? AND endpoint=?').run(state,errorCode,now(),job.id,job.owner_id,endpoint);
    if(['ready','deleted','expired'].includes(state))db.prepare('DELETE FROM sync_chunks WHERE job_id=?').run(job.id);
  });}
  async function prepare(archiveSessionId,{host,sessionId}={},afterSequence=0){
    const selected=await settings(),choice=selected.choice;
    if(!choice.enabled||!choice.archiveSessionIds.includes(archiveSessionId))return null;
    const description=await archive.describe({galaxyId:selected.galaxyId,archiveSessionId});
    if(!description||(host&&(description.host!==host||description.sessionId!==sessionId)))return null;
    const source=await archive.snapshot({galaxyId:selected.galaxyId,archiveSessionId,afterSequence});
    if(!source.messages.length)return null;
    const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});
    const projected=projectConversationForUpload(privacy.settings,source).data;
    const original={format:'galaxy-private-conversation-v1',...projected};assertNoWorkCredentials(original);
    const scopeId=choice.scopeIds[archiveSessionId],chunks=splitUtf8(JSON.stringify(original));
    const relatedWork=await work.get({galaxyId:selected.galaxyId,host:source.session.host,sessionId:source.session.sessionId,limit:1});
    const sourceTitle=relatedWork?.work.title;
    const title=(sourceTitle&& !['Recorded work','Unprocessed work'].includes(sourceTitle)?sourceTitle:source.session.host+' · '+source.session.updatedAt.slice(0,10)+'的对话').slice(0,240);
    const sourceVersion=afterSequence||source.nextAfter!==null?source.session.revision+':'+afterSequence+':'+source.selectedCoverage.throughSequence+':'+(source.nextAfter===null?'done':'more'):source.session.revision;
    const job=await access(true,selected.galaxyId,(db,owner)=>{
      const current=choiceWithin(db,owner);if(!current.enabled||current.choiceId!==choice.choiceId)throw error('archive_sync_scope_changed');
      const withdrawn=db.prepare("SELECT id FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='deleted' LIMIT 1").get(owner,endpoint,archiveSessionId,scopeId);
      if(withdrawn)return null;
      const existing=db.prepare('SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? AND target_id=? AND archive_id=? AND source_revision=? AND scope_id=?').get(owner,endpoint,choice.targetAccountId,archiveSessionId,sourceVersion,scopeId);
      if(existing)return existing;
      const id=randomUUID(),selection={workspaceId:source.session.workspaceId??'unknown',sessionIds:[source.session.sessionId],scopeId};
      db.prepare('INSERT INTO sync_jobs(id,owner_id,endpoint,target_id,archive_id,source_revision,scope_id,choice_id,title,selection_json,state,chunk_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,owner,endpoint,choice.targetAccountId,archiveSessionId,sourceVersion,scopeId,choice.choiceId,title,JSON.stringify(selection),'prepared',chunks.length,now(),now());
      const insert=db.prepare('INSERT INTO sync_chunks(job_id,sequence,content) VALUES(?,?,?)');chunks.forEach((content,sequence)=>insert.run(id,sequence,content));
      return db.prepare('SELECT * FROM sync_jobs WHERE id=?').get(id);
    });
    return job?{job,nextAfter:source.nextAfter}:null;
  }
  async function upload(job){
    if(['deleted','expired','local-deleted'].includes(job.state))return jobView(job);
    try{
      const status=await send(job,'status',{id:job.id});
      if(status.state==='deleted'||status.state==='expired'){await mark(job,status.state==='expired'||status.reason==='expired'?'expired':'deleted');return {...jobView(job),state:status.state==='expired'||status.reason==='expired'?'expired':'deleted'};}
      if(status.state==='ready'){await mark(job,'ready');return {...jobView(job),state:'ready'};}
      // A cloud replica removed outside this client cannot be silently rebuilt.
      if(job.state==='ready'&&status.state==='absent'){await mark(job,'deleted');return {...jobView(job),state:'deleted'};}
      if(status.state==='absent')await send(job,'create',{id:job.id,title:job.title,selection:JSON.parse(job.selection_json),uploadLevel:'conversation-archive',includeFullConversation:true},{material:true});
      const stored=new Set(status.storedSequences??[]);
      const chunks=await access(false,job.owner_id,db=>db.prepare('SELECT sequence,content FROM sync_chunks WHERE job_id=? ORDER BY sequence').all(job.id));
      if(chunks.length!==job.chunk_count)throw error('archive_sync_original_snapshot_unavailable');
      for(const chunk of chunks)if(!stored.has(chunk.sequence))await send(job,'chunk',{id:job.id,sequence:chunk.sequence,content:chunk.content},{material:true});
      await send(job,'complete',{id:job.id,chunkCount:job.chunk_count},{material:true});await mark(job,'ready');return {...jobView(job),state:'ready'};
    }catch(e){const code=codeOf(e);
      if(code==='archive_deleted'){
        // Creation can race an owner deletion of an older snapshot in this
        // same scope. Expiry stops only the old snapshot, owner deletion the
        // selection; an unavailable reply still retains the original job.
        try{const status=await send(job,'status',{id:job.id});const state=status.state==='expired'||status.reason==='expired'?'expired':'deleted';
          await mark(job,state,code);return {...jobView(job),state,error:code};}catch{ /* reconcile the same job later */ }
      }
      await mark(job,'unknown',code);return {...jobView(job),state:'unknown',error:code,originalOperationRetained:true};}
  }
  async function cancelLocalSource({archiveSessionId}){
    return access(true,null,(db,owner)=>{
      db.prepare('DELETE FROM sync_chunks WHERE job_id IN (SELECT id FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=?)').run(owner,endpoint,archiveSessionId);
      db.prepare("UPDATE sync_jobs SET state='local-deleted',updated_at=? WHERE owner_id=? AND endpoint=? AND archive_id=?").run(now(),owner,endpoint,archiveSessionId);
      return {archiveSessionId,localQueueCleared:true,cloudChanged:false};
    });
  }
  async function processSource(id,filter){
    const selected=await settings(),choice=selected.choice;
    const description=await archive.describe({galaxyId:selected.galaxyId,archiveSessionId:id});
    if(!description){await cancelLocalSource({archiveSessionId:id});return [];}
    if(filter&&(description.host!==filter.host||description.sessionId!==filter.sessionId))return [];
    const previous=await access(false,selected.galaxyId,db=>{
      if(!db)return [];
      const args=[selected.galaxyId,endpoint,id,choice.scopeIds[id]];
      const ready=db.prepare("SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='ready' ORDER BY created_at DESC LIMIT 1").get(...args);
      const pending=db.prepare("SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state NOT IN ('ready','deleted','expired','local-deleted') ORDER BY created_at").all(...args);
      return [...(ready?[ready]:[]),...pending];
    });
    const items=[];
    for(const job of previous){const result=await upload(job);items.push(result);if(result.state==='unknown'||result.state==='deleted')return items;}
    const currentSaved=await access(false,selected.galaxyId,db=>db?.prepare("SELECT 1 FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='ready' AND (source_revision=? OR CAST(source_revision AS TEXT) LIKE ?) LIMIT 1").get(selected.galaxyId,endpoint,id,choice.scopeIds[id],description.revision,description.revision+':%:done'));
    if(currentSaved)return items;
    let afterSequence=0;
    do{const prepared=await prepare(id,filter,afterSequence);if(!prepared)break;
      if(!previous.some(old=>old.id===prepared.job.id)){const result=await upload(prepared.job);items.push(result);if(result.state==='unknown'||result.state==='deleted')break;}
      afterSequence=prepared.nextAfter;
    }while(afterSequence!==null);
    return items;
  }
  async function flush(input={}){
    const x=parse(archiveSyncFlushSchema,input);if(flushing)return flushing;
    return flushing=(async()=>{
      const selected=await settings();if(!selected.choice.enabled)return {state:'not-selected',items:[],networkStarted:false};
      const ids=x.archiveSessionId?[x.archiveSessionId]:selected.choice.archiveSessionIds,items=[];
      for(const id of ids)items.push(...await processSource(id));
      return {state:'processed',items};
    })().finally(()=>{flushing=null;});
  }
  async function onSessionComplete({host,sessionId}){
    const selected=await settings();if(!selected.choice.enabled)return {state:'not-selected',networkStarted:false};
    const items=[];for(const id of selected.choice.archiveSessionIds)items.push(...await processSource(id,{host,sessionId}));
    return {state:'processed',items};
  }
  async function listCloud(input){const {targetAccountId,...page}=parse(archiveCloudListSchema,input);return call('/v2/account-archives/list',page,{accountId:targetAccountId});}
  async function exportCloud(input){const x=parse(archiveCloudExportSchema,input);return call('/v2/account-archives/export',{id:x.id,sequence:x.sequence},{accountId:x.targetAccountId});}
  async function deleteCloud(input){const x=parse(archiveCloudItemSchema,input),result=await call('/v2/account-archives/delete',{id:x.id},{accountId:x.targetAccountId});
    await access(true,null,(db,owner)=>{const job=db.prepare('SELECT * FROM sync_jobs WHERE id=? AND owner_id=? AND endpoint=? AND target_id=?').get(x.id,owner,endpoint,x.targetAccountId);
      if(job){db.prepare("UPDATE sync_jobs SET state='deleted',updated_at=? WHERE id=?").run(now(),job.id);db.prepare('DELETE FROM sync_chunks WHERE job_id=?').run(job.id);}});return result;}
  async function cleanupCloud(input){const x=parse(archiveCloudTargetSchema,input);return call('/v2/account-archives/cleanup',{}, {accountId:x.targetAccountId});}
  return Object.freeze({settings,accounts,choose,flush,onSessionComplete,listCloud,exportCloud,deleteCloud,cleanupCloud,cancelLocalSource,
    async close(){closed=true;await flushing;}});
}
