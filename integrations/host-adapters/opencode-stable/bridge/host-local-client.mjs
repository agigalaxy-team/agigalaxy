import {createChildRPC} from './child-rpc.mjs';

// This client is never supplied to nativeTools or a model. The process exposes
// only host persistence methods, while all model execution stays in the SDK.
export function createHostLocalClient({configPath=process.env.GALAXY_NATIVE_CONFIG,executable=process.env.GALAXY_NATIVE_EXECUTABLE,requestTimeoutMs=30000}={}){
 const rpc=createChildRPC({executable,configPath,requestTimeoutMs,command:'host',maxMessageBytes:9*1024*1024});
 const call=method=>(params={})=>rpc.request(method,params);
 return Object.freeze({
  initialize:call('native.initialize'),
  preparationStatus:call('native.preparationStatus'),
  deferPreparation:call('native.deferPreparation'),
  history:Object.freeze({identity:call('history.identity'),beginCapture:call('history.beginCapture'),observeEnvironment:call('history.observeEnvironment'),observe:call('history.observe'),list:call('history.list'),get:call('history.get'),pending:call('history.pending'),setSummaryState:call('history.setSummaryState'),submitSummary:call('history.submitSummary')}),
  archive:Object.freeze({settings:call('archive.settings'),captureMessage:call('archive.captureMessage'),configure:call('archive.configure')}),
  close:rpc.close,
 });
}

