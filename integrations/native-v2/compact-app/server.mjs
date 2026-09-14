import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {registerAppResource,registerAppTool,RESOURCE_MIME_TYPE,getUiCapability} from '@modelcontextprotocol/ext-apps/server';
import {createCompactController,panelInputSchema,panelIdSchema,panelOpenSchema,panelReturnSchema,panelDraftSchema} from './controller.mjs';
export async function loadCompactArtifact(){const url=new URL('dist/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',url),'utf8')),html=await readFile(new URL('panel.html',url),'utf8');
 if(createHash('sha256').update(html).digest('hex')!==manifest.sha256)throw new Error('panel_artifact_changed');return{manifest,html};}
export function registerNativeCompactApps(server,{runtime,artifact}){
 if(!artifact?.manifest?.uri||createHash('sha256').update(artifact.html).digest('hex')!==artifact.manifest.sha256)throw new Error('panel_artifact_required');
 const controller=createCompactController(runtime),uri=artifact.manifest.uri,meta={ui:{csp:{connectDomains:[],resourceDomains:[],frameDomains:[]},prefersBorder:true}};
 registerAppResource(server,'Galaxy compact workspace',uri,{mimeType:RESOURCE_MIME_TYPE,_meta:meta},async()=>({contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:artifact.html,_meta:meta}]}));
 const add=(name,inputSchema,description,run,write=false)=>registerAppTool(server,name,{inputSchema,description,annotations:{readOnlyHint:!write,destructiveHint:false},_meta:{ui:{resourceUri:uri}}},async input=>{
  try{const data=await run(input),ui=getUiCapability(server.server.getClientCapabilities?.());return{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,
   _meta:{galaxyUi:{advertisedByHost:!!ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE),actualRendering:'not-confirmed'}}};}
  catch(e){const c=e.code??e.message;const data={error:/^[a-z0-9_-]{1,100}$/.test(c??'')?c:'panel_operation_failed',businessMutation:false};return{isError:true,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}});
 add('galaxy_panel',panelInputSchema,'Show current permitted object and all help directions, with matching, publishing and participation entries. This is a progressive UI; text-only hosts retain the same result. No model or cloud upload.',controller.show);
 add('galaxy_panel_refresh',panelIdSchema,'Re-read only this view’s current object through existing permissions. Does not mark human read.',controller.refresh);
 add('galaxy_panel_open',panelOpenSchema,'Open this exact object or one of three active entries in the configured browser. Does not publish or join.',controller.open,true);
 add('galaxy_panel_return',panelReturnSchema,'Refresh this view’s own original browser navigation. Does not cancel or complete work.',controller.resume);
 add('galaxy_panel_draft_save',panelDraftSchema,'Save only this view’s device-local draft with revision conflict protection. No sharing or cloud synchronization.',controller.save,true);
 return{close:controller.close,resourceUri:uri};
}
