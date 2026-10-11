import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {createReconstructionFlowPreview} from './reconstruction-flow-preview.mjs';
import {ProsodyChatTransport} from '../src/infrastructure/prosody-chat.mjs';

// A thin local composition of normal services and the existing isolated OIDC
// interaction/Native bridge. No message transport or response-body replacement.
export async function createChatNormalFlowPreview({directory,certificate,key,reportDirectory,service,secretFile,ports=[5250,5251,5252]}){
 const transport=new ProsodyChatTransport({service,domain:'gateway.galaxy.internal',roomsDomain:'rooms.galaxy.internal',
  secret:(await readFile(secretFile,'utf8')).trim()});
 await transport.start();let scene;
 try{scene=await createReconstructionFlowPreview({directory,certificate,key,reportDirectory,ports,chatTransport:transport});
  const [requester,responder]=scene.people,metadataFile=join(reportDirectory,'shared-scene-status.json');
  // IDs are saved before the real requests so a restart can finish only this
  // exact synthetic invitation, never manufacture another contact or message.
  scene.metadata.seedConversation??={roomId:randomUUID(),operationId:randomUUID(),decisionId:randomUUID(),title:'[本地合成] 已有交流（仅作姓名选择来源）'};
  await writeFile(metadataFile,JSON.stringify(scene.metadata,null,2));
  const seed=scene.metadata.seedConversation;
  await requester.runtime.api.call('/v2/chat/rooms/create',{roomId:seed.roomId,operationId:seed.operationId,title:seed.title});
  await requester.runtime.api.call('/v2/chat/rooms/'+seed.roomId+'/propose',{decisionId:seed.decisionId,expectedRevision:1,action:'invite',targetSubjectId:responder.subjectId});
  await responder.runtime.api.call('/v2/chat/rooms/'+seed.roomId+'/accept',{decisionId:seed.decisionId,accept:true});
 }
 catch(error){await scene?.close();await transport.stop();throw error;}
 return{...scene,close:async()=>{await scene.close();await transport.stop();}};
}

if(process.argv.includes('--preview')){
 const scene=await createChatNormalFlowPreview({directory:process.env.GALAXY_CHAT_DATA_DIRECTORY,
  certificate:process.env.GALAXY_CHAT_TLS_CERT,key:process.env.GALAXY_CHAT_TLS_KEY,reportDirectory:process.env.GALAXY_CHAT_REPORT_DIRECTORY,
  service:process.env.GALAXY_CHAT_SERVICE,secretFile:process.env.GALAXY_CHAT_SECRET_FILE});
 process.stdout.write(JSON.stringify({pid:process.pid,endpoint:scene.metadata.endpoint,entries:scene.metadata.roles.map(value=>value.entry),
  chatTransportAvailable:scene.metadata.chatTransport.available})+'\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void scene.close().then(()=>process.exit(0)));
}
