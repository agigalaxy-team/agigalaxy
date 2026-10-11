import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {withLocalRead,withLocalWrite} from '../../packages/galaxy-core/src/storage/write-lock.mjs';
import {localPaths,writeJson} from '../../packages/galaxy-core/src/storage/files.mjs';
import {verifyGalaxyGenesis} from '../../packages/galaxy-core/src/galaxy-guid.mjs';
import {deletionIntentSchema,deletionStates} from '../../packages/galaxy-official/src/shared/deletion-schema.mjs';

export const DELETION_RECORDS_FILE='galaxy-deletion-records.json';
const recordSchema=z.strictObject({requestId:z.uuid(),subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/),endpoint:z.url().max(2048),
 recordedAt:z.number().int().nonnegative(),requestHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
 lastAction:z.enum(['request','cancel']).optional(),observedState:z.enum(deletionStates).optional(),observedAt:z.number().int().nonnegative().optional()});
const archiveSchema=z.strictObject({version:z.literal(1),records:z.array(recordSchema).max(128)});
async function identity(directory){const paths=localPaths(directory);
 for(const file of [paths.initializationJournal,paths.resetJournal]){try{await lstat(file);throw Error('Local identity recovery required.');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const meta=await lstat(paths.identity);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>16384)throw Error('Invalid local identity.');
 const value=JSON.parse(await readFile(paths.identity,'utf8'));if(!verifyGalaxyGenesis(value.id,value.genesisProof))throw Error('Valid local identity required.');return value.id;
}
async function archive(directory){const file=join(directory,DELETION_RECORDS_FILE);try{const meta=await lstat(file);
 if(!meta.isFile()||meta.isSymbolicLink()||meta.size>524288)throw Error('Invalid deletion record archive.');return archiveSchema.parse(JSON.parse(await readFile(file,'utf8')));
 }catch(e){if(e.code==='ENOENT')return{version:1,records:[]};throw e;}}

// These minimal locators are local history, never a credential, proof of
// submission, current deletion state or permission to query another subject.
export function createLocalDeletionRecords({dataDirectory,endpoint,isCurrent=()=>true,now=()=>Math.floor(Date.now()/1000)}){
 async function update(input,expectedSubject){return withLocalWrite(dataDirectory,async directory=>{
  if(!isCurrent())throw Error('Deletion record canceled.');const subjectId=await identity(directory);if(expectedSubject&&expectedSubject!==subjectId)throw Error('Deletion record identity changed.');
  const value=archiveSchema.parse(await archive(directory)),prior=value.records.find(r=>r.requestId===input.requestId&&r.endpoint===endpoint&&r.subjectId===subjectId);
  const record=recordSchema.parse({...prior,requestId:input.requestId,subjectId,endpoint,recordedAt:prior?.recordedAt??now(),...input});
  if(prior){if(prior.requestHash&&input.requestHash&&prior.requestHash!==input.requestHash)throw Error('Original deletion request changed.');value.records[value.records.indexOf(prior)]=record;}
  else{if(value.records.length>=128)throw Error('Deletion record archive full.');value.records.push(record);}
  if(!isCurrent())throw Error('Deletion record canceled.');await writeJson(join(directory,DELETION_RECORDS_FILE),value);return record;
 });}
 return Object.freeze({
  async rememberPreview(preview){const intent=deletionIntentSchema.parse(JSON.parse(preview.payloadJson));if(intent.endpoint!==endpoint||preview.endpoint!==endpoint)throw Error('Deletion record target changed.');
   const requestId=intent.action==='request'?intent.id:intent.requestId;if(preview.requestId!==requestId)throw Error('Deletion request reference changed.');
   return update({requestId,lastAction:intent.action,...(intent.action==='request'?{requestHash:createHash('sha256').update(preview.payloadJson).digest('hex')}:{})},intent.subjectId);},
  async observe(result){const requestId=result.id??result.requestId;if(result.endpoint!==undefined&&result.endpoint!==endpoint)throw Error('Deletion response target changed.');
   if(!deletionStates.includes(result.state))throw Error('Unknown deletion state.');return update({requestId,observedState:result.state,observedAt:now()},result.subjectId);},
  async list(){return withLocalRead(dataDirectory,async directory=>{if(!isCurrent())throw Error('Deletion record canceled.');const subjectId=await identity(directory),value=await archive(directory);
   if(!isCurrent())throw Error('Deletion record canceled.');return{source:'local-history',currentStateVerified:false,records:value.records.filter(r=>r.endpoint===endpoint&&r.subjectId===subjectId).sort((a,b)=>b.recordedAt-a.recordedAt)};});}
 });
}
