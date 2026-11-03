import {enqueueIngress} from './ingress.mjs';
import {randomUUID} from 'node:crypto';
import {createChildRPC} from '../opencode-stable/bridge/child-rpc.mjs';
import {captureTranscript} from './transcript-archive.mjs';
import {nativeObservationEnvironment} from './native-environment.mjs';

// The inherited Host channel is private to the adapter, not an MCP tool.
export function createHostRecorder(options={}) {
  const {host,executable=process.env.GALAXY_NATIVE_EXECUTABLE,dataDirectory=process.env.GALAXY_NATIVE_DATA_DIR}=options;
  const configPath=options.configPath??(options.dataDirectory?undefined:process.env.GALAXY_NATIVE_CONFIG);
  const env=nativeObservationEnvironment();if(dataDirectory&&!configPath)for(const key of Object.keys(env))if(key.toUpperCase()==='GALAXY_NATIVE_CONFIG')delete env[key];
  const rpc=createChildRPC({executable,command:configPath?'host':'integration-host',configPath,dataDirectory,env,requestTimeoutMs:165000,maxMessageBytes:9*1024*1024});
  const call=(method,params={})=>rpc.request(method,params);
  return {
    enqueue:event=>enqueueIngress({executable,configPath,dataDirectory,host,event}),
    async record(event,{includeWork=false}={}) {
      if (!event?.sessionId || !event.sourceId || !event.kind || !event.source?.kind) return {state:'ignored'};
      await this.enqueue(event);
      // A queued event remains durable if the service is unavailable.
      await call('history.drainIngress',{});
      return includeWork?await this.workFor(event.sessionId):{state:'recorded'};
    },
    async sourceCursor(sessionId,seq){const owner=await call('history.identity');if(!owner?.id)return null;const cursor=await call('history.sourceCursor',{galaxyId:owner.id,host,sessionId,seq});return {galaxyId:owner.id,...cursor};},
    advanceCursor:({galaxyId,sessionId,seq})=>call('history.advanceSourceCursor',{galaxyId,host,sessionId,seq}),
    async selectedArchiveOwner(sessionId) {
      const current=await call('archive.settings');
      return current?.galaxyId&&current.settings?.enabled&&current.settings.sessions?.some(item=>item.host===host&&item.sessionId===sessionId)?current.galaxyId:null;
    },
    async captureSelectedMessage({sessionId,messageId,message,parts,expectedGalaxyId}) {
      if(typeof sessionId!=='string'||!sessionId||typeof messageId!=='string'||!messageId||!message||!Array.isArray(parts))return {captured:false,reason:'host-message-unavailable'};
      const galaxyId=await this.selectedArchiveOwner(sessionId);
      if(!galaxyId||expectedGalaxyId&&galaxyId!==expectedGalaxyId)return {captured:false,reason:'not-selected'};
      // The store rechecks selection and identity in the capture transaction.
      return call('archive.captureMessage',{galaxyId,host,sessionId,messageId,message,parts});
    },
    async captureSelectedTranscript(sessionId,transcriptPath) {
      if(typeof sessionId!=='string'||!sessionId||typeof transcriptPath!=='string')return;
      const current=await call('archive.settings');
      if(!current?.galaxyId||!current.settings?.enabled||!current.settings.sessions?.some(item=>item.host===host&&item.sessionId===sessionId))return;
      await captureTranscript({host,sessionId,transcriptPath,galaxyId:current.galaxyId,options:{configPath,dataDirectory},capture:params=>call('archive.captureMessage',params),acquire:params=>call('archive.transcript.acquire',params),release:params=>call('archive.transcript.release',params)});
    },
    async workFor(sessionId){const owner=await call('history.identity');if(!owner?.id)return null;const result=await call('history.get',{galaxyId:owner.id,host,sessionId,limit:1});return result?.work||null;},
    close:()=>rpc.close()
  };
}
export const short=(value,n=1200)=>typeof value==='string'?value.slice(0,n):'';
export const content=value=>({excerpt:short(value),originalLength:typeof value==='string'?value.length:0,retained:value?'excerpt':'none',availableFromHost:false});
export const uniqueId=()=>randomUUID();
export function environment(host,input) {
  return {host,platform:process.platform,architecture:process.arch,runtime:'node',runtimeVersion:process.versions.node,...(typeof input.model==='string'?{selectedModel:input.model}:{})};
}
export async function runHook(host,normalize) {
  let recorder,output={};
  try {
    process.stdin.setEncoding('utf8');
    let input=''; for await(const chunk of process.stdin){input+=chunk;if(input.length>9*1024*1024)throw Error('hook_input_too_large');}
    const value=JSON.parse(input), event=normalize(value);
    if(event||typeof value?.session_id==='string'){
      const options={host};
      for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i], value=process.argv[i+1]; if(!value)throw Error('hook_argument_invalid'); if(name==='--executable')options.executable=value; else if(name==='--config')options.configPath=value; else if(name==='--data-dir'){options.dataDirectory=value;options.configPath=null;} else if(name==='--host-executable'){ /* accepted for existing configurations */ } else throw Error('hook_argument_invalid');}
      recorder=createHostRecorder(options);
      try {
        const saved=event?await recorder.record(event,{includeWork:value.hook_event_name==='UserPromptSubmit'}):null;
        if(value.hook_event_name==='UserPromptSubmit' && saved?.pending && typeof saved.workId==='string'){
          output={hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:`银河已积累当前工作的待整理本机观察。当前 Agent 可在自然阶段用 galaxy_local_work_pending 和 galaxy_local_work_summary 按需整理；工作引用 ${JSON.stringify(saved.workId)}。`}};
        }
      } finally {
        try {await recorder.captureSelectedTranscript(value.session_id,value.transcript_path);}
        catch {process.stderr.write('galaxy selected conversation capture unavailable\n');}
      }
    }
  } catch(error) {
    // Failure must remain visible without writing captured content or interrupting work.
    process.stderr.write(`galaxy host recording unavailable: ${typeof error?.code==='string'?error.code:'recording_failed'}\n`);
  } finally {await recorder?.close().catch(()=>{});}
  process.stdout.write(JSON.stringify(output)+'\n');
}











