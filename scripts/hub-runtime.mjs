import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {resolve,join,basename,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const roles=Object.freeze({api:'galaxy-api',worker:'galaxy-worker','information-worker':'galaxy-information-worker',publisher:'galaxy-publisher',migrate:'galaxy-migrate',lifecycle:'galaxy-lifecycle'});

// Local launch convenience only. The selected binary is the actual server;
// this script never imports a Node business runtime, builds, or migrates data.
export async function hubCommand({role='api',artifact=process.env.GALAXY_RELEASE_DIRECTORY,args=[]}={}){
 const nativeRole=['native','integration-mcp','local-id'].includes(role);
 const entry=roles[role];
 if(nativeRole){
  let command=process.env.GALAXY_NATIVE_EXECUTABLE;
  if(!command){
   if(typeof artifact!=='string'||!artifact)throw Error('Select GALAXY_NATIVE_EXECUTABLE, or an existing combined Go core artifact through GALAXY_RELEASE_DIRECTORY.');
   const directory=resolve(artifact),manifest=JSON.parse(await readFile(join(directory,'go-core-artifact.json'),'utf8'));
   const native=manifest.entries?.native,expected='native/'+(manifest.target?.goos==='windows'?'galaxy.exe':'galaxy');
   if(!['galaxy-go-core-local-candidate','galaxy-go-core-release'].includes(manifest.kind)||manifest.backend!=='go'||native!==expected)throw Error('Selected Go core does not contain Native; choose the standalone Native executable.');
   command=join(directory,native);
  }
  if(!isAbsolute(command)||!(await stat(command)).isFile())throw Error('Select an absolute existing Go Native executable.');
  if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw Error('Native arguments must be strings.');
  // Preserve the caller cwd for existing relative --data-dir / GALAXY_DATA_DIR.
  return {command,args:[...(role==='local-id'?[]:[role]),...args],cwd:process.cwd(),native:true};
 }
 if(!entry)throw Error('Choose api, worker, information-worker, publisher, migrate, lifecycle, native, integration-mcp, or local-id.');
 if(typeof artifact!=='string'||!artifact)throw Error('Select an existing Go core artifact with GALAXY_RELEASE_DIRECTORY (or --release-directory), GALAXY_RELEASE_SHA256, and GALAXY_CONFIGURATION_VERSION. Build it with scripts/build-go-core.mjs first.');
 if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw Error('Hub arguments must be strings.');
 const directory=resolve(artifact),manifest=JSON.parse(await readFile(join(directory,'go-core-artifact.json'),'utf8'));
 if(!['galaxy-go-core-local-candidate','galaxy-go-core-release'].includes(manifest.kind)||manifest.backend!=='go')throw Error('Expected a Go core artifact; a legacy Node service release is not a Go runtime.');
 const binary=manifest.entries?.[entry],expected=entry+(manifest.target?.goos==='windows'?'.exe':'');
 if(binary!==expected||basename(binary)!==binary)throw Error('Go artifact is missing the selected server entry.');
 const command=join(directory,binary);
 if(!(await stat(command)).isFile())throw Error('Go server executable is unavailable.');
 return {command,args:[...args],cwd:directory};
}

export async function runHub(options={}){
 const selected=await hubCommand(options);
 const child=spawn(selected.command,selected.args,{cwd:selected.cwd,env:selected.native?process.env:{...process.env,GALAXY_RELEASE_DIRECTORY:selected.cwd},stdio:'inherit',shell:false,windowsHide:true});
 const forward=signal=>{if(child.exitCode===null&&child.signalCode===null)child.kill(signal);};
 const interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');
 process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
 try{return await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolveExit({code,signal}));});}
 finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv.slice(2),role=input.shift()??'api';let artifact;
 if(input[0]==='--release-directory'){input.shift();artifact=input.shift();if(!artifact)throw Error('--release-directory requires a directory.');}
 if(input[0]==='--')input.shift();
 try{const result=await runHub({role,artifact,args:input});process.exitCode=result.code??(result.signal==='SIGINT'?130:result.signal==='SIGTERM'?143:1);}
 catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
}
