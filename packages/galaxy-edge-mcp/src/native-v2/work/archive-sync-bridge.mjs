import {createNativeStore} from '../store.mjs';
import {createNativeArchiveSync} from './archive-sync.mjs';
import {createNativeWorkSync} from './sync.mjs';
import {localPaths,readJson} from '../../../../galaxy-core/src/storage/files.mjs';

/** Host terminal-event hook. Ordinary recording never waits for this optional
 * network path. No saved explicit selection means no runtime and no network. */
export async function syncSelectedArchivesForSession({dataDirectory,nativeConfiguration,host,sessionId}={}){
  if(!nativeConfiguration?.endpoint)return {state:'not-selected',networkStarted:false};
  const {endpoint}=nativeConfiguration,store=createNativeStore(dataDirectory);
  const getIdentity=async directory=>{
    const selected=await store.readWithin(directory,'native-active:'+endpoint);
    if(selected?.subjectId)return {id:selected.subjectId};
    const paths=localPaths(directory);return await readJson(paths.identity,null)??await readJson(paths.legacyIdentity,null);
  };
  const reader=createNativeArchiveSync({dataDirectory,endpoint,getIdentity});
  const selected=await reader.settings();
  const workReader=createNativeWorkSync({dataDirectory,endpoint,getIdentity});
  const selectedWork=await workReader.settings();
  if(!selected.choice.enabled&&!selectedWork.choice.enabled)return {state:'not-selected',networkStarted:false};
  const connection=await store.readConnection(endpoint);
  if(!connection.permission?.enabled)return {state:'not-connected',networkStarted:false};
  const {createNativeRuntime}=await import('../runtime.mjs');
  const runtime=await createNativeRuntime({...nativeConfiguration,dataDirectory,autoResumePrivateSync:false});
  try{return {archives:await runtime.archiveSync.onSessionComplete({host,sessionId}),work:await runtime.workSync.onSessionComplete({host,sessionId})};}
  finally{await runtime.close();}
}
