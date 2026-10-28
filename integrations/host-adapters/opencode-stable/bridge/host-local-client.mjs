import {createChildRPC} from './child-rpc.mjs';

// Private inherited-stdio persistence, never a model tool. No service choice
// means the original local-only store, not an implicit official connection.
/** @param {{configPath?:string, executable?:string, dataDirectory?:string, localOnly?:boolean, requestTimeoutMs?:number}} [options] */
export function createHostLocalClient({configPath=process.env.GALAXY_NATIVE_CONFIG,executable=process.env.GALAXY_NATIVE_EXECUTABLE,dataDirectory,localOnly=!configPath,requestTimeoutMs=30000}={}){
 let rpc,closed=false,closing;
 const transport=()=>{
  if(closed)throw Object.assign(Error('native_bridge_closed'),{code:'native_bridge_closed'});
  return rpc??=createChildRPC({executable,configPath:localOnly?undefined:configPath,dataDirectory:localOnly?dataDirectory:undefined,requestTimeoutMs,command:localOnly?'integration-host':'host',maxMessageBytes:9*1024*1024});
 };
 const call=method=>async(params={})=>transport().request(method,params);
 const snapshot=call('local.snapshot'),status=call('local.integrationStatus'),connection=call('local.connectionStatus'),reset=call('local.resetIntegration');
 return Object.freeze({
  initialize:call('native.initialize'),preparationStatus:call('native.preparationStatus'),deferPreparation:call('native.deferPreparation'),
  history:Object.freeze({identity:call('history.identity'),beginCapture:call('history.beginCapture'),observeEnvironment:call('history.observeEnvironment'),observe:call('history.observe'),list:call('history.list'),get:call('history.get'),pending:call('history.pending'),setSummaryState:call('history.setSummaryState'),submitSummary:call('history.submitSummary')}),
  archive:Object.freeze({settings:call('archive.settings'),captureMessage:call('archive.captureMessage'),configure:call('archive.configure')}),
  store:Object.freeze({getLocalSnapshot:(_directory)=>snapshot(),getGalaxyIntegrationStatus:(_directory)=>status(),resetGalaxyIntegration:(_directory)=>reset()}),
  connection:Object.freeze({getGalaxyConnectionStatus:(_directory)=>connection()}),
  /** @param {{endpoint:string,isCurrent?:()=>boolean}} options */
  deletionRecords({endpoint,isCurrent=()=>true}){
   const current=()=>{if(!isCurrent())throw Error('Deletion record canceled.');};
   const run=async(method,input)=>{current();const result=await call(method)({endpoint,...input});current();return result;};
   return Object.freeze({rememberPreview:preview=>run('local.deletion.rememberPreview',{preview}),observe:result=>run('local.deletion.observe',{result}),list:()=>run('local.deletion.list',{})});
  },
  close(){closed=true;return closing??=(rpc?rpc.close():Promise.resolve());},
 });
}
export async function prepareOpenCodeLocalWork(dataDirectory,{subjectType='person',configPath=process.env.GALAXY_NATIVE_CONFIG,executable=process.env.GALAXY_NATIVE_EXECUTABLE}={}){
 const client=createHostLocalClient({dataDirectory,configPath,executable});
 try{return await client.initialize({initializationPath:'personal-galaxy',subjectType});}finally{await client.close();}
}
