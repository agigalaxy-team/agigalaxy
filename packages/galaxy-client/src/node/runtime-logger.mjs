import pino from 'pino';
import {createStream} from 'rotating-file-stream';
import {mkdir,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {runtimeDiagnosticFields,runtimeDiagnosticContext} from './runtime-diagnostics.mjs';

// A formatter is required here: each runtime must supply its closed metadata
// projection. The shared writer never accepts an arbitrary input object as a
// default record. The server facade and Native diagnostics supply their own.
export function runtimeLogConfiguration(env){
  const directory=env.GALAXY_RUNTIME_LOG_DIRECTORY??null;
  const instance=env.GALAXY_RUNTIME_LOG_INSTANCE??'primary';
  const rotateBytes=Number(env.GALAXY_RUNTIME_LOG_ROTATE_BYTES??10485760);
  const maxFiles=Number(env.GALAXY_RUNTIME_LOG_MAX_FILES??14);
  if(directory!==null&&!isAbsolute(directory))throw new Error('Absolute runtime log directory required');
  if(!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(instance)||!Number.isSafeInteger(rotateBytes)||rotateBytes<1024||rotateBytes>1073741824
    ||!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>90)throw new Error('Invalid runtime log configuration');
  return {directory,instance,rotateBytes,maxFiles,environment:runtimeDiagnosticContext({environment:env.GALAXY_ENVIRONMENT}).environment};
}
function loggerFor(component,sink,{owned=false,maxBufferedBytes=1048576,fallback=process.stderr,release,environment,eventFormatter,streamMode='stdout'}={}){
  if(!['api','worker','migration','content-publisher','native','host-client'].includes(component)||typeof eventFormatter!=='function')throw new Error('Invalid log component');
  let logContext=runtimeDiagnosticContext({release,environment});
  let failed=false,closed=false,writeFailures=0,droppedRecords=0,rotationWarnings=0,rotations=0,reported=false;
  const report=reason=>{
    if(reported)return;reported=true;
    try{fallback.write(JSON.stringify({event:'runtime_log_sink_unavailable',component,...logContext,time:new Date().toISOString(),reason})+'\n');}catch{}
  };
  const onError=()=>{failed=true;writeFailures++;report('write_failed');};
  sink.on('error',onError);
  if(owned){sink.on('warning',()=>{rotationWarnings++;report('rotation_warning');});sink.on('rotated',()=>{rotations++;});}
  const output={write(line){
    if(closed||failed||sink.destroyed||(sink.writableLength??0)+Buffer.byteLength(line)>maxBufferedBytes){
      droppedRecords++;report('buffer_or_sink_unavailable');return false;
    }
    try{return sink.write(line);}catch{onError();droppedRecords++;return false;}
  }};
  const logger=pino({base:{component},timestamp:pino.stdTimeFunctions.isoTime},output);
  const write=(input,level)=>{
    let formatted;
    try{formatted=eventFormatter(input);if(!formatted||typeof formatted!=='object'||Array.isArray(formatted)||typeof formatted.event!=='string')throw new Error();}
    catch{droppedRecords++;report('format_failed');return false;}
    const {component:_component,release:_release,environment:_environment,...fields}=formatted;
    const event={...fields,...logContext};
    logger[level??(event.event.endsWith('_failed')||event.status>=500?'error':event.status>=400||event.event.endsWith('_unavailable')||event.event.endsWith('_deferred')?'warn':'info')](event);
  };
  let closePromise=null;
  return {write,
    updateContext(input){logContext=runtimeDiagnosticContext({...logContext,...input});},
    error:input=>write(input,'error'),
    status:()=>({mode:owned?'file':streamMode,ready:!closed&&!failed&&!sink.destroyed&&(sink.writableLength??0)<maxBufferedBytes,
      writeFailures,droppedRecords,rotationWarnings,rotations}),
    close(){
      if(closePromise)return closePromise;
      closed=true;
      closePromise=owned?(async()=>{const done=finished(sink,{cleanup:true});sink.end();await done;})():Promise.resolve();
      return closePromise.catch(error=>{
        try{fallback.write(JSON.stringify({event:'runtime_shutdown_failed',component,...logContext,time:new Date().toISOString(),...runtimeDiagnosticFields({stage:'log-close',error})})+'\n');}catch{}
        throw error;
      }).finally(()=>{if(!owned)sink.off('error',onError);});
    }
  };
}
export function consoleRuntimeLogger(component,{destination=process.stdout,...options}={}){
  return loggerFor(component,destination,{streamMode:destination===process.stderr?'stderr':'stdout',...options});
}
// Runtime failures terminate through the component's existing drain path. Node's
// default stderr dump contains Error.message and must not expose private input.
export function installRuntimeFailureHandlers({logger,onFatal,process:target=process}){
  let failed=false;
  const handle=(error,signal)=>{
    if(failed)return;failed=true;target.exitCode=1;
    try{logger({event:signal==='unhandledRejection'?'runtime_unhandled_rejection':'runtime_uncaught_exception',stage:'shutdown',signal,error});}catch{}
    Promise.resolve().then(()=>onFatal()).catch(failure=>{
      try{logger({event:'runtime_shutdown_failed',stage:'shutdown',error:failure});}catch{}
    });
  };
  const uncaught=error=>handle(error,'uncaughtException'),rejected=error=>handle(error,'unhandledRejection');
  target.on('uncaughtException',uncaught);target.on('unhandledRejection',rejected);
  return()=>{target.off('uncaughtException',uncaught);target.off('unhandledRejection',rejected);};
}
export async function createRuntimeLogger({component,directory=null,instance='primary',rotateBytes=10485760,maxFiles=14,release,environment,eventFormatter,defaultDestination=process.stdout}){
  if(!['api','worker','migration','content-publisher','native','host-client'].includes(component))throw new Error('Invalid log component');
  if(!directory)return consoleRuntimeLogger(component,{release,environment,eventFormatter,destination:defaultDestination});
  runtimeLogConfiguration({GALAXY_RUNTIME_LOG_DIRECTORY:directory,GALAXY_RUNTIME_LOG_INSTANCE:instance,
    GALAXY_RUNTIME_LOG_ROTATE_BYTES:String(rotateBytes),GALAXY_RUNTIME_LOG_MAX_FILES:String(maxFiles)});
  const path=join(directory,component+'-'+instance);
  await mkdir(path,{recursive:true,mode:0o700});
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||(process.platform!=='win32'&&(info.mode&0o077)))throw new Error('Invalid private runtime log directory');
  // Fixed numbered rotation avoids an imported history file controlling paths.
  // One writer per component/instance; stable name preserves rotation on restart.
  const stream=createStream(index=>index?'runtime.'+index+'.jsonl.gz':'runtime.jsonl',
    {path,size:rotateBytes+'B',interval:'1d',rotate:maxFiles,compress:'gzip',mode:0o600});
  const logger=loggerFor(component,stream,{owned:true,release,environment,eventFormatter});
  try{await once(stream,'open');return logger;}catch{stream.destroy();throw new Error('Runtime log file unavailable');}
}
