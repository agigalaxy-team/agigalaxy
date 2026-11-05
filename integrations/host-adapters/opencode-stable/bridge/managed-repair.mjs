import {spawn} from 'node:child_process';
import {basename,dirname,isAbsolute,normalize} from 'node:path';
import {nativeObservationEnvironment} from '../../shared/native-environment.mjs';

// Only an already-installed release can ask its own Go installer to reconcile
// the selected OpenCode profile. No configuration is read or written here.
export function repairManagedOpenCodeIfNeeded({executable,configPath,dataDirectory}={}) {
 if(typeof executable!=='string'||!isAbsolute(executable)||typeof dataDirectory!=='string'||!isAbsolute(dataDirectory))return Promise.resolve({attempted:false});
 if(configPath && (typeof configPath!=='string'||!isAbsolute(configPath)))return Promise.resolve({attempted:false});
 const command=normalize(executable),packageRoot=dirname(command),releases=dirname(packageRoot),installRoot=dirname(releases);
 if(!/^galaxy(?:\.exe)?$/i.test(basename(command))||!/^release-[0-9a-f-]+$/i.test(basename(packageRoot))||basename(releases)!=='releases'||!isAbsolute(installRoot))return Promise.resolve({attempted:false});
 const args=['repair','--if-needed','--host','opencode','--install-root',installRoot,'--package-dir',packageRoot,'--data-dir',dataDirectory];
 const env=nativeObservationEnvironment();
 if(configPath)args.push('--config',configPath);else {args.push('--local-only');for(const key of Object.keys(env))if(key.toUpperCase()==='GALAXY_NATIVE_CONFIG')delete env[key];}
 return new Promise(resolve=>{
  let child,settled=false,timer;
  const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
  try { child=spawn(command,args,{env,stdio:'ignore',windowsHide:true,shell:false}); }
  catch {finish({attempted:true,ok:false});return;}
  timer=setTimeout(()=>{
   try {child.kill('SIGTERM');} catch {}
   const hardStop=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)try{child.kill('SIGKILL');}catch{}},1000);
   hardStop.unref();finish({attempted:true,ok:false});
  },30000);
  timer.unref();
  child.once('error',()=>finish({attempted:true,ok:false}));
  child.once('close',code=>finish({attempted:true,ok:code===0}));
 });
}
