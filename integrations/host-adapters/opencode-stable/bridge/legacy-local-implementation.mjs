// Existing JavaScript installation compatibility only. The Go candidate
// excludes this module; its host persistence stays in the Go JSONL process.
import * as store from '../../../../packages/galaxy-core/src/local-store.mjs';
import * as connection from '../../../../packages/galaxy-core/src/connection-profile.mjs';
import {createLocalWorkHistory} from '../../../../packages/galaxy-core/src/work-history/index.mjs';
import {createLocalConversationArchive} from '../../../../packages/galaxy-core/src/conversation-archive/index.mjs';
import {readNativeConfiguration} from '../../../../packages/galaxy-edge-mcp/src/native-v2/configuration.mjs';
import {createNativeStore} from '../../../../packages/galaxy-edge-mcp/src/native-v2/store.mjs';
import {readJson,localPaths,resolveDataDir} from '../../../../packages/galaxy-core/src/storage/files.mjs';
export {store,connection};
export {createLocalDeletionRecords} from '../../local-deletion-records.mjs';
export {prepareOpenCodeLocalWork,isOpenCodePreparationDeferred,deferOpenCodePreparation} from '../local-preparation.mjs';
export const createLegacyHistory=options=>createLocalWorkHistory(options);
export const createLegacyArchive=options=>createLocalConversationArchive(options);
export async function legacyHostConfiguration({dataDirectory,endpoint,selected,diagnostics}){
 dataDirectory=resolveDataDir(dataDirectory);
 let readLocalIdentity,onWorkSessionComplete,connectionUnavailable=false;
 if(selected){
  try{
   const config=await readNativeConfiguration(selected);
   if(!config)throw Error('Galaxy selected configuration unavailable.');
   dataDirectory=config.dataDirectory;endpoint=config.endpoint;
   onWorkSessionComplete=async({host,sessionId})=>{
    const {syncSelectedArchivesForSession}=await import('../../../../packages/galaxy-edge-mcp/src/native-v2/work/archive-sync-bridge.mjs');
    return syncSelectedArchivesForSession({dataDirectory:config.dataDirectory,nativeConfiguration:{endpoint:config.endpoint,website:config.website,trustedKeys:config.trustedKeys},host,sessionId});
   };
  }catch(error){diagnostics.emit({event:'host_bridge',stage:'configuration',outcome:'failed',host:'opencode',error});connectionUnavailable=true;}
 }
 if(endpoint){
  const local=createNativeStore(dataDirectory);
  readLocalIdentity=async directory=>{
   const current=await local.readWithin(directory,'native-active:'+endpoint);
   const genesis=await readJson(localPaths(directory).identity,null)??await readJson(localPaths(directory).legacyIdentity,null);
   if(current?.subjectId)return current.subjectId===genesis?.id?genesis:{id:current.subjectId};
   return genesis;
  };
 }
 return {dataDirectory,readLocalIdentity,onWorkSessionComplete,connectionUnavailable};
}
