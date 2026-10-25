import * as z from 'zod/v4';
import {registerAppTool} from '@modelcontextprotocol/ext-apps/server';
import {nativeUploadPrivacyInputSchema,nativeLocalSettingsInputSchema} from '../../../packages/galaxy-edge-mcp/src/native-v2/work/local-tools.mjs';
import {archiveSettingsInputSchema,archiveDeleteInputSchema} from '../../../packages/galaxy-core/src/conversation-archive/index.mjs';
import {workDeleteInputSchema} from '../../../packages/galaxy-core/src/work-history/index.mjs';
import {archiveSyncChoiceSchema} from '../../../packages/galaxy-edge-mcp/src/native-v2/work/archive-sync.mjs';
import {workSyncChoiceSchema} from '../../../packages/galaxy-edge-mcp/src/native-v2/work/sync.mjs';

const inputSchema=z.strictObject({view:z.enum(['history','privacy','archive']).default('history'),galaxyId:z.string().optional(),workId:z.string().optional(),
   archiveSessionId:z.uuid().optional(),afterSequence:z.number().int().nonnegative().optional(),after:z.string().max(200).optional()});
function component(data) {
  return {content:[{type:'text',text:data.error?'本机内容暂时无法读取。':'银河 · 履历'}],
    structuredContent:{kind:'galaxy-local-work-panel',view:data.view,galaxyId:data.galaxyId??null,error:data.error??null,localOnly:true},
    _meta:{galaxyLocalWork:{kind:'galaxy-local-work-panel',...data}}};
}
const unpack=result=>{
  if(result?.structuredContent)return result.structuredContent;
  try{return JSON.parse(result?.content?.find(item=>item.type==='text')?.text??'null');}catch{return null;}
};

export function registerLocalWorkPanelTools(server,{resourceUri,local,reviewAction}) {
  const collect=async(method,galaxyId)=>{const items=[];let after;do{const page=await method({galaxyId,limit:100,...(after?{after}:{})});items.push(...page.items);after=page.nextAfter;}while(after);return items;};
  async function snapshot(input={}) {
    const privacy=await local.privacyGet(),galaxyId=privacy.galaxyId;
    if(privacy.recoveryRequired)throw new Error('local_identity_recovery_required');
    if(input.galaxyId&&input.galaxyId!==galaxyId)throw new Error('local_identity_changed');
    if(!galaxyId)return {view:input.view??'history',galaxyId:null,notInitialized:true};
    const view=input.view??'history';
    if(view==='privacy'){
      const [work,archives,archiveSettings]=await Promise.all([collect(local.work.list,galaxyId),collect(local.archive.list,galaxyId),local.archive.settings()]);
      const choices=new Map(work.map(item=>[JSON.stringify([item.host,item.sessionId]),{workId:item.workId,host:item.host,sessionId:item.sessionId,title:item.title,updatedAt:item.updatedAt}]));
      for(const item of archives){const key=JSON.stringify([item.host,item.sessionId]);choices.set(key,{...(choices.get(key)??{host:item.host,sessionId:item.sessionId,updatedAt:item.updatedAt}),archiveSessionId:item.archiveSessionId});}
      for(const item of archiveSettings.settings.sessions){const key=JSON.stringify([item.host,item.sessionId]);if(!choices.has(key))choices.set(key,{...item,title:'已保存的会话'});}
      return {view,galaxyId,privacy,archiveSettings,work:{items:work},archives:{items:archives},sessionChoices:[...choices.values()],accountsPending:!!(local.cloud&&local.workCloud),
        archiveSync:await local.cloud?.settings(),workSync:await local.workCloud?.settings()};
    }
    if(view==='archive'){
      const archives=await local.archive.list({galaxyId,limit:30,...(input.after?{after:input.after}:{})});
      const titled=async item=>{const work=await local.work.get({galaxyId,host:item.host,sessionId:item.sessionId,limit:1}),title=work?.work.title;return {...item,...(title&&!['Recorded work','Unprocessed work'].includes(title)?{title}:{})};};
      archives.items=await Promise.all(archives.items.map(titled));
      let selectedArchive=null,missingSelection;
      if(input.archiveSessionId)try{selectedArchive=await local.archive.exportSession({galaxyId,archiveSessionId:input.archiveSessionId,afterSequence:input.afterSequence??0,limit:20});}
      catch(error){if((error.code??error.message)!=='local_archive_session_unavailable')throw error;missingSelection='archive';}
      const selected=selectedArchive?await titled(selectedArchive.session):null;
      return {view,galaxyId,archives,selectedArchive,archiveTitle:selected?.title,...(missingSelection?{missingSelection}:{})};
    }
    const selectedWork=input.workId?await local.work.get({galaxyId,workId:input.workId,afterSequence:input.afterSequence??0,limit:100}):null;
    const original=selectedWork?await local.archive.findSession({galaxyId,host:selectedWork.work.host,sessionId:selectedWork.work.sessionId}):null;
    return {view,galaxyId,work:await local.work.list({galaxyId,limit:30,...(input.after?{after:input.after}:{})}),selectedWork,
      ...(original?.messageCount?{relatedArchiveSessionId:original.archiveSessionId}:{}),...(input.workId&&!selectedWork?{missingSelection:'work'}:{})};
  }
  const add=(name,schema,description,run,{write=false,appOnly=false}={})=>registerAppTool(server,name,{inputSchema:schema,description,
    annotations:{readOnlyHint:!write},_meta:{ui:{resourceUri,...(appOnly?{visibility:['app']}: {})}}},async(input,context)=>{
    try{return await run(input,context);}catch(error){const code=error.code??error.message;return{isError:true,...component({error:/^[a-z0-9_-]{1,100}$/.test(code??'')?code:'local_panel_unavailable'})};}
  });
  add('galaxy_local_panel',inputSchema,'Open a compact local work/history/upload-settings panel beside the current Agent. Reads actual device-local records only; no web RPC, model, connection or upload is started.',async input=>component(await snapshot(input)));
  add('galaxy_local_panel_read',inputSchema,'Read the selected local work or captured original for this panel. Full body remains component-only.',async input=>component(await snapshot(input)),{appOnly:true});
  async function reviewed(name,input,context,run,view) {
    const result=await reviewAction({name,input,preview:input,context,run});
    if(result?.resultType==='input_required')return result;
    const value=unpack(result);
    if(value?.state==='user-choice-needs-browser'||value?.state==='declined'||value?.state==='pending')return component({view,galaxyId:input.galaxyId,choice:value});
    if(result?.isError)return result;
    return component(await snapshot({view,galaxyId:input.galaxyId}));
  }
  add('galaxy_local_panel_prepare',z.strictObject({view:z.enum(['history','privacy','archive']).default('history'),subjectType:z.enum(['person','organization']).default('person')}),
    'Prepare this device only after the panel user chooses Start. Reuse the normal Native initialization review; existing local identity is read without creating or changing its type.',async(input,context)=>{
      // The original preparation may have finished while its reply was lost.
      // Reconcile actual local identity before offering another creation choice.
      const privacy=await local.privacyGet();if(privacy.recoveryRequired)throw new Error('local_identity_recovery_required');
      if(privacy.galaxyId)return component(await snapshot({view:input.view}));
      const initialization={initializationPath:'personal-galaxy',subjectType:input.subjectType};
      return reviewed('galaxy_native_initialize',initialization,context,()=>local.prepareLocal(initialization),input.view);
    },{write:true,appOnly:true});
  add('galaxy_local_panel_upload_save',nativeUploadPrivacyInputSchema,'Save this panel user’s exact new upload selection through the real Native choice surface.',(input,context)=>reviewed('galaxy_local_upload_privacy_set',input,context,()=>local.privacySet(input),'privacy'),{write:true,appOnly:true});
  add('galaxy_local_panel_settings_save',nativeLocalSettingsInputSchema,'Save one selected conversation scope for local retention, allowed upload and the chosen private account.',(input,context)=>reviewed('galaxy_local_settings_save',input,context,()=>local.saveSettings(input),'privacy'),{write:true,appOnly:true});
  add('galaxy_local_panel_archive_save',archiveSettingsInputSchema,'Save exact selected private host/session capture scopes and cleanup age. No upload.',(input,context)=>reviewed('galaxy_local_archive_configure',input,context,()=>local.archive.configure(input),'privacy'),{write:true,appOnly:true});
  add('galaxy_local_panel_archive_delete',archiveDeleteInputSchema,'Delete this selected local original archive through actual user choice. Other sources and cloud replicas are separate.',(input,context)=>reviewed('galaxy_local_archive_delete',input,context,()=>local.deleteLocalArchive(input),'archive'),{write:true,appOnly:true});
  add('galaxy_local_panel_work_delete',workDeleteInputSchema,'Delete this selected local work record through actual user choice.',(input,context)=>reviewed('galaxy_local_work_delete',input,context,()=>local.deleteLocalWork(input),'history'),{write:true,appOnly:true});
  if(local.cloud&&local.workCloud){
    add('galaxy_local_panel_sync_accounts',z.strictObject({galaxyId:z.string().min(1)}),'Read actual account targets only after the panel user asks to configure private cloud copies.',async input=>{
      if((await local.privacyGet()).galaxyId!==input.galaxyId)throw new Error('local_identity_changed');
      const targets=await local.availableAccounts();
      if((await local.privacyGet()).galaxyId!==input.galaxyId)throw new Error('local_identity_changed');
      return component({view:'privacy',galaxyId:input.galaxyId,accountUpdate:true,accounts:targets.accounts,accountSettingsUrl:targets.accountSettingsUrl,
        accountsPending:false,accountsUnavailable:!!targets.unavailable,accountConnectionRequired:targets.connected===false});
    },{appOnly:true});
    const save=(kind,schema)=>add('galaxy_local_panel_'+kind+'_sync_save',schema.safeExtend({galaxyId:z.string().min(1)}),
      'Save this panel user’s exact private account/source selection through real Native choice; no implicit old-material selection.',async(input,context)=>{
        const {galaxyId,...choice}=input;if((await local.privacyGet()).galaxyId!==galaxyId)throw new Error('local_identity_changed');
        return reviewed(kind==='work'?'galaxy_work_sync_choice':'galaxy_archive_sync_choice',input,context,
          async()=>{const result=await(kind==='work'?local.workCloud.choose(choice):local.cloud.choose(choice));local.resumeSync();return result;},'privacy');
      },{write:true,appOnly:true});
    save('work',workSyncChoiceSchema);save('archive',archiveSyncChoiceSchema);
    add('galaxy_local_panel_sync_flush',z.strictObject({galaxyId:z.string().min(1)}),'Continue the existing exact private work/archive selections; no new scope or per-chunk approval.',async input=>{
      if((await local.privacyGet()).galaxyId!==input.galaxyId)throw new Error('local_identity_changed');
      await local.workCloud.flush();await local.cloud.flush();return component(await snapshot({view:'privacy',galaxyId:input.galaxyId}));
    },{write:true,appOnly:true});
  }
}
