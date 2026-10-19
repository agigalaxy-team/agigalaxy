import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {registerAppResource,registerAppTool,RESOURCE_MIME_TYPE,getUiCapability} from '@modelcontextprotocol/ext-apps/server';
import {createCompactController,panelInputSchema,panelIdSchema,panelOpenSchema,panelReturnSchema,panelDraftSchema,panelReplyDraftSchema,panelMessageSchema,panelSelectSchema,panelFinishSchema,panelPrepareSchema,panelExecuteSchema,panelOperationSchema} from './controller.mjs';
import {panelResult} from './result.mjs';
import {createHostViewState,hostViewStateSchema} from './host-view-state.mjs';
import {registerLocalWorkPanelTools} from './local-work-server.mjs';
export function nativeCompactUiAdvertised(server){return !!getUiCapability(server.server.getClientCapabilities?.())?.mimeTypes?.includes(RESOURCE_MIME_TYPE);}
export async function loadCompactArtifact(){const url=new URL('dist/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',url),'utf8')),html=await readFile(new URL('panel.html',url),'utf8');
 if(createHash('sha256').update(html).digest('hex')!==manifest.sha256)throw new Error('panel_artifact_changed');return{manifest,html};}
export function registerNativeCompactApps(server,{runtime,artifact,reviewAction}){
 if(!artifact?.manifest?.uri||createHash('sha256').update(artifact.html).digest('hex')!==artifact.manifest.sha256)throw new Error('panel_artifact_required');
 const controller=createCompactController(runtime,{reviewAction}),preferences=createHostViewState(runtime),uri=artifact.manifest.uri,meta={ui:{csp:{connectDomains:[],resourceDomains:[],frameDomains:[]},prefersBorder:true}};
 registerAppResource(server,'Galaxy compact workspace',uri,{mimeType:RESOURCE_MIME_TYPE,_meta:meta},async()=>({contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:artifact.html,_meta:meta}]}));
 const add=(name,inputSchema,description,run,write=false,appOnly=false)=>registerAppTool(server,name,{inputSchema,description,annotations:{readOnlyHint:!write,destructiveHint:false},_meta:{ui:{resourceUri:uri,...(appOnly?{visibility:['app']}: {})}}},async (input,context)=>{
  try{const data=await run(input,{context});if(data?.resultType==='input_required')return data;
   const ui=getUiCapability(server.server.getClientCapabilities?.());return panelResult(data,
   {advertisedByHost:!!ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE),actualRendering:'not-confirmed'});}
  catch(e){const c=e.code??e.message;const data={error:/^[a-z0-9_-]{1,100}$/.test(c??'')?c:'panel_operation_failed',businessMutation:false};return{isError:true,...panelResult(data)};}});
 add('galaxy_panel',panelInputSchema,'Show concrete user-model help explanations only after current source review, actual responses separately, and matching/publishing/participation entries. Device-local unsent notes are component-only metadata. Text-only hosts retain object references and use ordinary help/task tools.',controller.show);
 add('galaxy_panel_refresh',panelIdSchema,'Re-read only this view’s current object through existing permissions. Does not mark human read.',controller.refresh);
 add('galaxy_panel_open',panelOpenSchema,'Open this exact object or one of three active entries in the configured browser. Does not publish or join.',controller.open,true);
 add('galaxy_panel_return',panelReturnSchema,'Refresh this view’s own original browser navigation. Does not cancel or complete work.',controller.resume);
 add('galaxy_panel_draft_save',panelDraftSchema,'Save only this view’s device-local draft with revision conflict protection. No sharing or cloud synchronization.',controller.save,true);
 add('galaxy_panel_reply_draft_save',panelReplyDraftSchema,'Keep this current conversation’s unsent reply on this device only. Text stays in component metadata and is never model context or a shared message.',controller.saveReply,true,true);
 add('galaxy_panel_message_send',panelMessageSchema,'Send the panel user’s exact reply within an existing current respond grant. Preserve the original clientMessageId after unknown delivery; reconcile automatically before another send.',controller.sendMessage,true,true);
 add('galaxy_panel_select',panelSelectSchema,'Save this exact set of help IDs as a device-local choice after source review. Does not contact, publish, apply or pay.',controller.select,true);
 add('galaxy_panel_action_prepare',panelPrepareSchema,'Prepare a precise existing help-flow action for component review. Includes exact material, recipients and visibility. No business submission or automatic authorization.',controller.prepare,true);
 add('galaxy_panel_action_preview',panelOperationSchema,'Recover the exact pending action preview by its original operation ID. Never reconstructs a new operation.',controller.preview);
 add('galaxy_panel_action_execute',panelExecuteSchema,'Execute the explicitly confirmed exact preview through existing authorization and business services. Unknown outcomes require the original receipt query; never retries blindly.',controller.execute,true);
 add('galaxy_panel_action_reconcile',panelOperationSchema,'Query the original operation receipt without resending or changing IDs, recipients or material.',controller.reconcile);
 add('galaxy_panel_finish',panelFinishSchema,'Refresh actual task state and return minimal references to the original work. Does not cancel remote work, claim resolution or automatically invoke a model.',controller.finish,true);
 registerAppTool(server,'galaxy_host_view_state',{inputSchema:hostViewStateSchema,description:'Read or save only device-local host display preferences for the current principal and endpoint. No cloud or business effects.',annotations:{readOnlyHint:false,destructiveHint:false},_meta:{ui:{resourceUri:uri,visibility:['app']}}},async input=>{
  try{const data=await preferences.run(input);return{content:[],structuredContent:data};}
  catch(e){const value=e.code??e.message,error=/^[a-z0-9_-]{1,100}$/.test(value??'')?value:'host_view_unavailable';return{isError:true,content:[],structuredContent:{error,businessMutation:false}};}
 });
 return{close:()=>{controller.close();preferences.close();},resourceUri:uri,
  registerLocalWork:local=>registerLocalWorkPanelTools(server,{resourceUri:uri,local,reviewAction})};
}
