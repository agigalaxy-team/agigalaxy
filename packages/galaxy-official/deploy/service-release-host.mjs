import {readFile,writeFile,mkdir,rename,lstat,unlink} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

async function command(args,{timeout=20000}={}){
 return new Promise((resolveResult,reject)=>{
  const child=spawn('systemctl',args,{stdio:['ignore','pipe','ignore'],windowsHide:true});let text='';
  child.stdout.on('data',chunk=>{if(text.length<1024)text+=chunk.toString();});
  const timer=setTimeout(()=>child.kill(),timeout);
  child.once('error',()=>{clearTimeout(timer);reject(Error('Service command could not start.'));});
  child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('Service command failed.'));else resolveResult(text.trim());});
 });
}
const regular=async path=>{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Regular configuration file required.');};
const atomic=async(path,bytes)=>{const temporary=path+'.release-'+crypto.randomUUID();await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,path);};
export async function createServiceReleaseHost({configuration,operationId,from,to,run=command,fetch=globalThis.fetch}){
 const {files,units,migrationUnit,stateDirectory,readyUrl}=configuration;
 if(!/^[0-9a-f-]{36}$/i.test(operationId)||!isAbsolute(stateDirectory)||!Array.isArray(files)||files.length<1||files.length>20||!Array.isArray(units)||units.length!==3
  ||new Set(units).size!==3||[...units,migrationUnit].some(unit=>!/^[a-zA-Z0-9._@-]+\.service$/.test(unit)))throw Error('Explicit service family configuration required.');
 const url=new URL(readyUrl);if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/readyz')throw Error('Loopback readiness URL required.');
 for(const file of files)if(!isAbsolute(file.destination)||!isAbsolute(file.targetSource)||file.destination===file.targetSource)throw Error('Explicit protected source/destination files required.');
 if(new Set(files.map(file=>resolve(file.destination))).size!==files.length)throw Error('Duplicate protected file target.');
 const directory=join(stateDirectory,operationId);await mkdir(directory,{recursive:true,mode:0o700});
 const journal={async read(id){if(id!==operationId)throw Error('Original operation required.');try{return JSON.parse(await readFile(join(directory,'attempt.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  async write(record){if(record.operationId!==operationId)throw Error('Original operation required.');await atomic(join(directory,'attempt.json'),Buffer.from(JSON.stringify(record,null,2)+'\n'));}};
 const ready=async release=>{let failure;for(let turn=0;turn<40;turn++){
  try{const response=await fetch(readyUrl,{signal:AbortSignal.timeout(2000)});if(!response.ok||response.headers.get('x-galaxy-release')!==release.releaseId)throw Error('Selected release is not ready.');const body=await response.json();if(body.status!=='ready')throw Error('Readiness not established.');return;}
  catch(error){failure=error;await new Promise(resolveWait=>setTimeout(resolveWait,250));}
 }throw failure;};
 const host={async snapshot(){
   const records=[];for(const [index,file]of files.entries()){
    await regular(file.targetSource);let present=true;
    try{await regular(file.destination);await writeFile(join(directory,'before-'+index),await readFile(file.destination),{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='ENOENT')throw error;present=false;}
    records.push({index,destination:file.destination,present});
   }
   await writeFile(join(directory,'snapshot.json'),JSON.stringify(records)+'\n',{flag:'wx',mode:0o600});return directory;
  },async stopAll(){await run(['stop',...units]);},async applyTarget(){for(const file of files){await regular(file.targetSource);await atomic(file.destination,await readFile(file.targetSource));}await run(['daemon-reload']);},
  async restore(reference){if(resolve(reference)!==resolve(directory))throw Error('Original protected snapshot required.');
   const records=JSON.parse(await readFile(join(directory,'snapshot.json'),'utf8'));
   for(const record of records){if(files[record.index]?.destination!==record.destination)throw Error('Snapshot target changed.');
    if(record.present)await atomic(record.destination,await readFile(join(directory,'before-'+record.index)));
    else {try{await regular(record.destination);await unlink(record.destination);}catch(error){if(error.code!=='ENOENT')throw error;}}
   }await run(['daemon-reload']);
  },async startPrevious(){await run(['start',...units]);},async startTarget(){await run(['start',...units]);},
  verifyPrevious:()=>ready(from),verifyTarget:()=>ready(to),migrationState:()=>run(['show',migrationUnit,'--property=ActiveState','--value'])};
 return{host,journal,migrate:()=>run(['restart',migrationUnit],{timeout:600000}),directory};
}
