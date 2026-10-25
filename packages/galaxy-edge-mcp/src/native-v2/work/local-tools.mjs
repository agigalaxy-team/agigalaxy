import * as z from 'zod/v4';
import {createLocalWorkHistory,workListInputSchema,workGetInputSchema,workPendingInputSchema,workSummaryInputSchema,workNoteInputSchema,workExportInputSchema,workDeleteInputSchema} from '../../../../galaxy-core/src/work-history/index.mjs';
import {createLocalConversationArchive,archiveSettingsInputSchema,archiveListInputSchema,archiveExportInputSchema,archiveDeleteInputSchema,archiveCleanupInputSchema} from '../../../../galaxy-core/src/conversation-archive/index.mjs';
import {getLocalUploadPrivacy,setLocalUploadPrivacy,initializeLocalWorkerGalaxyId,projectWorkHistoryForUpload,projectConversationForUpload} from '../../../../galaxy-core/src/local-store.mjs';
import {localPaths,readJson} from '../../../../galaxy-core/src/storage/files.mjs';
import {archiveSyncChoiceSchema,archiveCloudTargetSchema,archiveCloudListSchema,archiveCloudItemSchema,archiveCloudExportSchema,archiveSyncFlushSchema} from './archive-sync.mjs';
import {workSyncChoiceSchema,workSyncFlushSchema,workCloudListSchema,workCloudItemSchema} from './sync.mjs';
import {nativeDiagnostics} from '../diagnostics.mjs';

export const nativeUploadPrivacyInputSchema = z.strictObject({galaxyId:z.string().min(1).max(512).optional(),
  level:z.enum(['local-only','history-overview','work-content','conversation-archive']),
  includeFullConversations:z.boolean().optional(),sessionIds:z.array(z.string().min(1).max(512)).max(500).optional()});
export const nativeLocalSettingsInputSchema=z.strictObject({choiceId:z.uuid(),galaxyId:z.string().optional(),
  level:z.enum(['local-only','history-overview','work-content','conversation-archive']),
  conversationMode:z.enum(['off','local','cloud']),sessions:z.array(z.strictObject({host:z.string().min(1).max(512),sessionId:z.string().min(1).max(512)})).max(500),
  targetAccountId:z.uuid().optional(),autoCleanAfterDays:z.number().int().min(1).max(36500).nullable(),restoreArchiveSessionIds:z.array(z.uuid()).max(500).default([])})
  .refine(x=>x.conversationMode==='off'||x.sessions.length>0)
  .refine(x=>x.conversationMode!=='cloud'||x.level==='conversation-archive'&&!!x.targetAccountId);

/** Called while a Core local-store operation already owns the coordination
 * lock. Do not call runtime.status() or take another lock in this reader. */
export function nativeLocalIdentityReader(runtime) {
  if (runtime.localIdentityWithin) return runtime.localIdentityWithin;
  return async directory => {
    const selected = await runtime.store.readWithin(directory,'native-active:'+runtime.api.endpoint);
    if (selected?.subjectId) return {id:selected.subjectId};
    const paths = localPaths(directory);
    return await readJson(paths.identity,null) ?? await readJson(paths.legacyIdentity,null);
  };
}

export function createNativeLocalWorkServices(runtime) {
  const diagnostics=runtime.diagnostics??nativeDiagnostics();
  const dataDirectory = runtime.store.dataDirectory, getIdentity = nativeLocalIdentityReader(runtime);
  const work = createLocalWorkHistory({dataDirectory,getIdentity});
  const archive = createLocalConversationArchive({dataDirectory,getIdentity});
  const accountSettingsUrl=runtime.website?new URL('/app/account',runtime.website).href:null;
  const allArchives=async galaxyId=>{const items=[];let after;do{const page=await archive.list({galaxyId,limit:100,...(after?{after}:{})});items.push(...page.items);after=page.nextAfter;}while(after);return items;};
  let timer,pendingCleanup,lastCleanupError=null;
  function maintain() {
    return pendingCleanup??=diagnostics.run('archive-cleanup',()=>archive.cleanup(),{event:'host_archive',independent:true}).then(result=>{lastCleanupError=null;return result;},error=>{
      lastCleanupError=/^[a-z0-9_]{1,100}$/.test(error.code??error.message)?error.code??error.message:'local_archive_cleanup_failed';
      return {state:'cleanup-failed',error:lastCleanupError};
    }).finally(()=>{pendingCleanup=null;});
  }
  return Object.freeze({work,archive,cloud:runtime.archiveSync,workCloud:runtime.workSync,
    resumeSync:()=>runtime.resumePrivateSync?.(),
    // The app-only preparation action invokes this only through the existing
    // native initialization choice. It is not called by a history read.
    prepareLocal:input=>runtime.initialize({initializationPath:'personal-galaxy',subjectType:input.subjectType},{confirmed:true}),
    async availableAccounts(){const connection=await runtime.store.readConnection?.(runtime.api.endpoint);
      if(!connection?.permission?.enabled||!runtime.archiveSync)return {accounts:[],connected:false,accountSettingsUrl};
      try{return {...await runtime.archiveSync.accounts(),connected:true,accountSettingsUrl};}catch(error){diagnostics.emit({event:'native_private_sync',stage:'private-sync',outcome:'failed',error});return {accounts:[],connected:true,unavailable:true,accountSettingsUrl};}},
    async saveSettings(input){const parsed=nativeLocalSettingsInputSchema.safeParse(input);if(!parsed.success)throw new Error('local_settings_invalid');const x=parsed.data;
      const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity}),owner=privacy.galaxyId;if(!owner||x.galaxyId&&x.galaxyId!==owner)throw new Error('local_identity_changed');
      const key='local-settings:'+runtime.api.endpoint+':'+owner+':'+x.choiceId,previous=await runtime.store.get(key);
      if(previous&&JSON.stringify(previous.input)!==JSON.stringify(x))throw new Error('local_settings_original_choice_changed');
      if(previous?.completed)return {saved:true};
      if(x.conversationMode==='cloud'){if(!runtime.archiveSync)throw new Error('account_target_unavailable');const accounts=await runtime.archiveSync.accounts();if(accounts.subjectId!==owner||!accounts.accounts.some(account=>account.accountId===x.targetAccountId&&account.endpoint===runtime.api.endpoint))throw new Error('account_target_unavailable');}
      await runtime.store.put(key,{input:x,completed:false});
      await archive.configure({galaxyId:owner,enabled:x.conversationMode!=='off',sessions:x.sessions,autoCleanAfterDays:x.autoCleanAfterDays});
      const sessions=await allArchives(owner),chosen=sessions.filter(item=>x.sessions.some(source=>source.host===item.host&&source.sessionId===item.sessionId)).map(item=>item.archiveSessionId);
      await setLocalUploadPrivacy(dataDirectory,{galaxyId:owner,level:x.level,includeFullConversations:x.conversationMode==='cloud',sessionIds:x.conversationMode==='cloud'?chosen:[]},{getIdentity});
      if(runtime.archiveSync){const prior=await runtime.archiveSync.settings(),targetAccountId=x.targetAccountId??prior.choice.targetAccountId;await runtime.archiveSync.choose({choiceId:x.choiceId,enabled:x.conversationMode==='cloud',
        ...(targetAccountId?{targetAccountId}:{}),archiveSessionIds:chosen,restoreArchiveSessionIds:x.conversationMode==='cloud'?x.restoreArchiveSessionIds:[]});}
      await runtime.store.put(key,{input:x,completed:true});runtime.resumePrivateSync?.();return {saved:true};
    },
    async deleteLocalArchive(input){const result=await archive.deleteSession(input);await runtime.archiveSync?.cancelLocalSource(input);return result;},
    async deleteLocalWork(input){const result=await work.deleteWork(input);await runtime.workSync?.cancelLocalSource(input);return result;},
    async summarize(input){const result=await work.submitSummary(input);if(runtime.workSync)void diagnostics.run('private-sync',()=>runtime.workSync.flush({workId:result.workId}),{event:'native_private_sync',independent:true}).catch(()=>{});return result;},
    startMaintenance(){if(timer)return;void maintain();timer=setInterval(()=>{void maintain();},60*60*1000);timer.unref?.();},
    async close(){clearInterval(timer);timer=null;await pendingCleanup;},
    maintenanceStatus:()=>({automaticCleanupError:lastCleanupError}),
    privacyGet:()=>getLocalUploadPrivacy(dataDirectory,{getIdentity}),
    async privacySet(input){const result=await setLocalUploadPrivacy(dataDirectory,input,{getIdentity});runtime.resumePrivateSync?.();return result;},
    workerCreate:input=>initializeLocalWorkerGalaxyId(dataDirectory,input),
    async projectWork(input) {
      const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});
      if (!privacy.galaxyId) throw new Error('local_identity_required');
      const record=await work.get({...input,galaxyId:privacy.galaxyId});
      return projectWorkHistoryForUpload(privacy.settings,record);
    },
    async projectArchive(input) {
      const privacy=await getLocalUploadPrivacy(dataDirectory,{getIdentity});
      if (!privacy.galaxyId) throw new Error('local_identity_required');
      const record=await archive.exportSession({...input,galaxyId:privacy.galaxyId});
      return projectConversationForUpload(privacy.settings,record);
    },
    async command(command) {
      if(command==='worker')return {command,route:'galaxy-worker-identity',state:'identity-setup-available',
        message:'通过独立 Worker 目录创建 Agent 主体，保留普通客户端身份与履历；本操作不启动 Worker 或模型。',
        nextTools:['galaxy_local_worker_identity_create'],runtimeStarted:false,localOnly:true};
      if (command === 'history' || command === 'work') return {command,route:'galaxy-work-history',state:'ready',history:await work.list(),
        nextTools:['galaxy_local_work_get','galaxy_local_work_pending','galaxy_local_work_summary','galaxy_local_work_note'],localOnly:true};
      if (command === 'privacy') return {command,route:'galaxy-privacy-controls',state:'ready',privacy:await getLocalUploadPrivacy(dataDirectory,{getIdentity}),
        nextTools:['galaxy_local_upload_privacy_set','galaxy_local_archive_settings','galaxy_local_archive_list'],localOnly:true};
      return null;
    },
  });
}

export function registerNativeLocalWorkTools(register,runtime) {
  const local = createNativeLocalWorkServices(runtime);
  register('galaxy_local_work_list',workListInputSchema,'Read real local work sessions for the currently controlled identity. Does not create an ID, connect, upload or run a model.',input=>local.work.list(input));
  register('galaxy_local_work_get',workGetInputSchema,'Read actual observations, sources, environment facts and own-model summaries. Missing host observations remain missing; a summary is not original evidence.',input=>local.work.get(input));
  register('galaxy_local_work_pending',workPendingInputSchema,'Read the next unprocessed observations and exact summary revision. Your own Agent can incrementally organize them without a formal Case or network.',input=>local.work.pending(input));
  register('galaxy_local_work_summary',workSummaryInputSchema,'Save your own Agent’s local summary with expectedRevision, throughSequence and all covered sourceObservationIds. This is user-model interpretation, not official inference or ability evaluation.',input=>local.summarize(input),{write:true});
  register('galaxy_local_work_note',workNoteInputSchema,'Add an explicitly labelled user statement or model report to a local work session. It cannot impersonate a host observation or turn a success claim into verified success.',input=>local.work.recordNote(input),{write:true});
  register('galaxy_local_work_export',workExportInputSchema,'Export only this identity’s actually retained work observations and summaries. This is not a full-conversation export.',input=>local.work.exportWork(input));
  register('galaxy_local_work_delete',workDeleteInputSchema,'Delete one selected local work history and its queued local upload bodies for the current identity. Host originals, separately selected conversation archives and cloud replicas are separate.',input=>local.deleteLocalWork(input),{write:true,needsChoice:true});
  register('galaxy_local_upload_privacy_get',z.strictObject({}),'Read the saved four-level upload selection. Level 2 is the initial default; full conversations stay excluded unless explicitly enabled for selected archive session IDs.',()=>local.privacyGet());
  register('galaxy_local_upload_privacy_set',nativeUploadPrivacyInputSchema,'Choose local upload data types. This starts no upload, changes no online public-query setting, and does not limit your own host model or local history reads.',input=>local.privacySet(input),{write:true,needsChoice:true});
  register('galaxy_local_settings_save',nativeLocalSettingsInputSchema,'Save one exact local/upload/private-account conversation selection. The program resolves session references and maintains unchanged source ranges. New private disclosure is reviewed once.',input=>local.saveSettings(input),{write:true,needsChoice:true});
  register('galaxy_local_work_upload_preview',workGetInputSchema,'Project actual local work fields according to the saved upload level before choosing a service. Level 2 omits observations and raw work content. This preview uploads nothing.',input=>local.projectWork(input));
  register('galaxy_local_archive_upload_preview',archiveExportInputSchema,'Project only an explicitly enabled and selected private archive session at upload level 4. Does not upload, publish, or infer permission for another destination.',input=>local.projectArchive(input));
  register('galaxy_local_worker_identity_create',z.strictObject({workerId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)}),
    'Create an Agent-subject identity in a separate local Worker directory. Keeps the normal client’s ID/history unchanged. Does not start a Worker, model, network or cloud account.',input=>local.workerCreate(input),{write:true,needsChoice:true});
  register('galaxy_local_archive_settings',z.strictObject({}),'Read explicit local full-conversation capture scopes and optional automatic cleanup. Full originals are excluded by default.',async()=>({...await local.archive.settings(),...local.maintenanceStatus()}));
  register('galaxy_local_archive_configure',archiveSettingsInputSchema,'Select exact host/session pairs for future private local original-message capture and optional cleanup days. No attachment fetch or upload. Enabling a high upload level alone does not select conversations.',input=>local.archive.configure(input),{write:true,needsChoice:true});
  register('galaxy_local_archive_list',archiveListInputSchema,'List current-identity private captured sessions. archiveSessionId is the exact scope ID used when separately choosing a full-conversation upload.',input=>local.archive.list(input));
  register('galaxy_local_archive_export',archiveExportInputSchema,'Export a page of actually captured original messages and parts for one selected private session. Coverage is explicit; missing earlier messages are not fabricated.',input=>local.archive.exportSession(input));
  register('galaxy_local_archive_delete',archiveDeleteInputSchema,'Delete the selected private local archive and stop capturing that session. Clears its queued local snapshot bodies; does not delete host originals, ordinary work facts or an independent cloud replica.',input=>local.deleteLocalArchive(input),{write:true,needsChoice:true});
  register('galaxy_local_archive_cleanup',archiveCleanupInputSchema,'Apply the current identity’s previously selected automatic cleanup age to captured local originals. With no cleanup age configured this deletes nothing.',input=>local.archive.cleanup(input),{write:true});
  if(local.cloud){
    register('galaxy_archive_sync_settings',z.strictObject({}),'Read this identity’s exact private-cloud target/range and durable immutable upload queue. Does not connect or upload.',()=>local.cloud.settings());
    register('galaxy_archive_sync_accounts',z.strictObject({}),'Read actual currently associated account targets through the selected identity connection. Uses no cookie and never chooses the earliest account.',()=>local.cloud.accounts());
    register('galaxy_archive_sync_choice',archiveSyncChoiceSchema,'Choose a private account and selected original sessions; preserve unchanged ranges, and restore an owner-deleted source only when explicitly selected for restoration.',async input=>{const result=await local.cloud.choose(input);runtime.resumePrivateSync?.();return result;},{write:true,needsChoice:true});
    register('galaxy_archive_sync_flush',archiveSyncFlushSchema,'Continue already selected private archive snapshots. Reconciles original IDs/chunks after unknown delivery; no new scope, cookie or per-chunk choice.',input=>local.cloud.flush(input),{write:true});
    register('galaxy_archive_cloud_list',archiveCloudListSchema,'Read owned private cloud archives at the explicitly selected account. Continue with nextAfter unchanged; no new disclosure choice is needed for another page.',input=>local.cloud.listCloud(input));
    register('galaxy_archive_cloud_export',archiveCloudExportSchema,'Read one owned cloud archive chunk. Local upload level does not restrict the owner reading their existing private copy.',input=>local.cloud.exportCloud(input));
    register('galaxy_archive_cloud_delete',archiveCloudItemSchema,'Delete the exact owned private cloud snapshot. Its source scope cannot silently reappear; other sources and local originals remain separate.',input=>local.cloud.deleteCloud(input),{write:true,needsChoice:true});
    register('galaxy_archive_cloud_cleanup',archiveCloudTargetSchema,'Apply the selected account’s existing private-archive retention rule. Does not create or enlarge a sync selection.',input=>local.cloud.cleanupCloud(input),{write:true});
  }
  if(local.workCloud){
    register('galaxy_work_sync_settings',z.strictObject({}),'Read the exact chosen account/work scope and durable history upload queue; no connection or upload.',()=>local.workCloud.settings());
    register('galaxy_work_sync_accounts',z.strictObject({}),'Read real current associated account choices for private work-history synchronization.',()=>local.workCloud.accounts());
    register('galaxy_work_sync_choice',workSyncChoiceSchema,'Choose a private account and work range, preserving unchanged sources and earlier receipts. Existing materials and restoring deleted sources require an explicit selection.',async input=>{const result=await local.workCloud.choose(input);runtime.resumePrivateSync?.();return result;},{write:true,needsChoice:true});
    register('galaxy_work_sync_flush',workSyncFlushSchema,'Continue this already selected work range at its saved upload level. Actual metadata is sent at level 2; free text requires level 3. Unknown ACKs keep original operationId and payload.',input=>local.workCloud.flush(input),{write:true});
    register('galaxy_work_cloud_list',workCloudListSchema,'Read private work copies uploaded by this identity to the explicit account, using the returned cursor for later pages.',input=>local.workCloud.listCloud(input));
    register('galaxy_work_cloud_get',workCloudItemSchema,'Read an owned private work copy. Does not infer public visibility or expand other identity sources.',input=>local.workCloud.getCloud(input));
    register('galaxy_work_cloud_delete',workCloudItemSchema,'Delete the exact private work copy and prevent the same source scope silently reappearing.',input=>local.workCloud.deleteCloud(input),{write:true,needsChoice:true});
  }
  return local;
}
