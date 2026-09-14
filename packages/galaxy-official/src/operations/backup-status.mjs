import { randomUUID } from 'node:crypto';
import { mkdir,lstat,readFile,writeFile,rename,rm } from 'node:fs/promises';
import { isAbsolute,join } from 'node:path';
import { z } from 'zod';

export const backupActions=['init','create','check','copy','retention','restore','prepare-cleanup','cleanup'];
const timestamp=z.number().int().nonnegative();
const schema=z.object({version:z.literal(1),action:z.enum(backupActions),runId:z.uuid(),startedAt:timestamp,finishedAt:timestamp.nullable(),
  outcome:z.enum(['running','succeeded','failed']),lastSuccessAt:timestamp.nullable()}).strict()
  .refine(value=>(value.outcome==='running')===(value.finishedAt===null),'Invalid backup run state');
function target(directory,action){
  if(!isAbsolute(directory)||!backupActions.includes(action))throw new Error('Invalid backup status target');
  return join(directory,action+'.json');
}
export async function readBackupStatus(directory,action){
  const path=target(directory,action);
  try{
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('Invalid backup status');
    const value=schema.parse(JSON.parse(await readFile(path,'utf8')));
    if(value.action!==action)throw new Error('Backup status action mismatch');
    return value;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function save(directory,value){
  const path=target(directory,value.action),temporary=path+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify(schema.parse(value))+'\n',{flag:'wx',mode:0o600});
    await rename(temporary,path);
  }finally{await rm(temporary,{force:true});}
}
export async function beginBackupStatus(directory,action,now=Math.floor(Date.now()/1000)){
  target(directory,action);await mkdir(directory,{recursive:true,mode:0o700});
  const previous=await readBackupStatus(directory,action);
  const value={version:1,action,runId:randomUUID(),startedAt:now,finishedAt:null,outcome:'running',lastSuccessAt:previous?.lastSuccessAt??null};
  await save(directory,value);return {directory,...value};
}
export async function finishBackupStatus(run,success,now=Math.floor(Date.now()/1000)){
  const current=await readBackupStatus(run.directory,run.action);
  // A newer invocation owns the latest-attempt record. Scheduling should still
  // prevent overlapping jobs of the same action; this is not a process lock.
  if(current?.runId!==run.runId)return false;
  await save(run.directory,{...current,finishedAt:now,outcome:success?'succeeded':'failed',lastSuccessAt:success?now:current.lastSuccessAt});
  return true;
}
