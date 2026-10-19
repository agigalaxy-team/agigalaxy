import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {getLocalSnapshot,initializeGalaxyIntegration} from '../../../packages/galaxy-core/src/local-store.mjs';
import {resolveDataDir,readJson,writeJson} from '../../../packages/galaxy-core/src/storage/files.mjs';

const preferencePath=directory=>join(resolveDataDir(directory),'opencode-local-preparation.json');

/** @param {string} [dataDirectory] */
export async function isOpenCodePreparationDeferred(dataDirectory){
 return (await readJson(preferencePath(dataDirectory),null))?.deferred===true;
}

/** @param {string} [dataDirectory] */
export async function deferOpenCodePreparation(dataDirectory){
 await mkdir(resolveDataDir(dataDirectory),{recursive:true,mode:0o700});
 await writeJson(preferencePath(dataDirectory),{version:1,deferred:true});
}

/** Used only by an actual install/start choice. Ordinary capture never calls it.
 * @param {string} [dataDirectory]
 * @param {{subjectType?:'person'|'organization',endpoint?:string}} [options] */
export async function prepareOpenCodeLocalWork(dataDirectory,{subjectType='person',endpoint=undefined}={}){
 if(!['person','organization'].includes(subjectType))throw Error('local_subject_type_invalid');
 const before=await getLocalSnapshot(dataDirectory);
 if(before.recoveryRequired)throw Error('local_initialization_requires_recovery');
 if(endpoint){
  const {createNativeStore}=await import('../../../packages/galaxy-edge-mcp/src/native-v2/store.mjs');
  const selected=await createNativeStore(before.dataDir).readConnection(endpoint);
  if(selected.active?.subjectId)return{created:false,identity:selected.active.subjectId,subjectType:null,existingIdentityPreserved:true};
 }
 if(before.identity)return{created:false,identity:before.identity.id,subjectType:before.identity.subjectType??null,existingIdentityPreserved:true};
 await initializeGalaxyIntegration(dataDirectory,{initializationPath:'personal-galaxy',source:'opencode-installation',subjectType});
 const after=await getLocalSnapshot(dataDirectory);
 if(!after.identity)throw Error('local_initialization_incomplete');
 await writeJson(preferencePath(dataDirectory),{version:1,deferred:false});
 return{created:true,identity:after.identity.id,subjectType:after.identity.subjectType??null,existingIdentityPreserved:false};
}
