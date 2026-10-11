import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ProsodyChatTransport} from '../src/infrastructure/prosody-chat.mjs';
import {createReconstructionFlowPreview} from './reconstruction-flow-preview.mjs';
import {createAttachmentProxyConfiguration} from './chat-attachment-proxy-client.mjs';

// A normal API/HTTPS/SQL composition with a separate real Prosody component.
// Remote private storage and scanning are real adapters in a run-only proxy;
// OIDC test accounts, identities and sample work remain explicitly synthetic.
export async function createChatAttachmentFlowPreview({directory,certificate,key,reportDirectory,service,secretFile,proxyEndpoint,proxySecretFile,namespace,ports=[5260,5261,5262]}){
 await mkdir(directory,{recursive:true});
 const attachmentConfiguration=await createAttachmentProxyConfiguration({endpoint:proxyEndpoint,secretFile:proxySecretFile,namespace});
 const transport=new ProsodyChatTransport({service,domain:'gateway.galaxy.internal',roomsDomain:'rooms.galaxy.internal',
  secret:(await readFile(secretFile,'utf8')).trim()});
 await transport.start();let scene,working=null,timer=null,stopped=false;
 const observation=join(reportDirectory,'attachment-worker-observation.json');
 async function maintenance(){
  if(stopped||working)return;working=(async()=>{
   let result;try{const purge=await scene.services.attachments.purgeExpired({limit:20}),scan=await scene.services.attachments.scanPending({limit:1});result={purge,scan};}
   catch(error){result={error:typeof error.code==='string'&&/^[a-z0-9_]{1,100}$/.test(error.code)?error.code:'isolated_attachment_worker_failed'};}
   await writeFile(observation,JSON.stringify({checkedAt:new Date().toISOString(),namespace,implementation:'ChatAttachmentsService.scanPending/purgeExpired',...result},null,2));
  })();
  try{await working;}finally{working=null;if(!stopped)timer=setTimeout(()=>void maintenance(),1000);}
 }
 try{
  scene=await createReconstructionFlowPreview({directory,certificate,key,reportDirectory,ports,chatTransport:transport,attachmentConfiguration});
  const [requester,responder]=scene.people,metadataFile=join(reportDirectory,'shared-scene-status.json');
  scene.metadata.seedConversation??={roomId:randomUUID(),operationId:randomUUID(),decisionId:randomUUID(),title:'[本地合成] 附件页面已有交流（姓名选择来源）'};
  scene.metadata.attachmentNamespace=namespace;scene.metadata.attachments.worker='normal-service-background-scan-and-purge';
  await writeFile(metadataFile,JSON.stringify(scene.metadata,null,2));
  const seed=scene.metadata.seedConversation;
  await requester.runtime.api.call('/v2/chat/rooms/create',{roomId:seed.roomId,operationId:seed.operationId,title:seed.title});
  await requester.runtime.api.call('/v2/chat/rooms/'+seed.roomId+'/propose',{decisionId:seed.decisionId,expectedRevision:1,action:'invite',targetSubjectId:responder.subjectId});
  await responder.runtime.api.call('/v2/chat/rooms/'+seed.roomId+'/accept',{decisionId:seed.decisionId,accept:true});
  await maintenance();
 }catch(error){stopped=true;clearTimeout(timer);await working?.catch(()=>{});await scene?.close();await transport.stop();throw error;}
 return{...scene,close:async()=>{if(stopped)return;stopped=true;clearTimeout(timer);await working?.catch(()=>{});await scene.close();await transport.stop();}};
}
if(process.argv.includes('--preview')&&resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 const scene=await createChatAttachmentFlowPreview({directory:process.env.GALAXY_ATTACHMENT_DATA_DIRECTORY,
  certificate:process.env.GALAXY_ATTACHMENT_TLS_CERT,key:process.env.GALAXY_ATTACHMENT_TLS_KEY,reportDirectory:process.env.GALAXY_ATTACHMENT_REPORT_DIRECTORY,
  service:process.env.GALAXY_ATTACHMENT_CHAT_SERVICE,secretFile:process.env.GALAXY_ATTACHMENT_CHAT_SECRET_FILE,
  proxyEndpoint:process.env.GALAXY_TEST_ATTACHMENT_PROXY_ENDPOINT,proxySecretFile:process.env.GALAXY_TEST_ATTACHMENT_PROXY_SECRET_FILE,
  namespace:process.env.GALAXY_TEST_ATTACHMENT_NAMESPACE});
 process.stdout.write(JSON.stringify({ready:true,pid:process.pid,endpoint:scene.metadata.endpoint,entries:scene.metadata.roles.map(person=>person.entry),
  namespace:scene.metadata.attachmentNamespace,attachments:scene.metadata.attachments,chatTransport:scene.metadata.chatTransport})+'\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void scene.close().then(()=>process.exit(0)));
}
