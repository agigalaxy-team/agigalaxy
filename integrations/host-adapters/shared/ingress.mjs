import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// The CLI durably queues a redacted observation before the shared service is
// contacted. A retry reuses the same delivery ID; no user content is logged.
export async function enqueueIngress({executable,configPath,dataDirectory,host,event}){
 const {sessionId,facts,deliveryId,...observation}=event;
 const payload={deliveryId:deliveryId||randomUUID(),observation:{host,sessionId,...observation,...(facts?{environment:facts}:{})}};
 const run=()=>new Promise((resolve,reject)=>{
  const args=['ingress',...(configPath?['--config',configPath]:dataDirectory?['--data-dir',dataDirectory]:[])];
  const env={...process.env};if(dataDirectory&&!configPath)delete env.GALAXY_NATIVE_CONFIG;
  const child=spawn(executable,args,{stdio:['pipe','pipe','ignore'],windowsHide:true,shell:false,env});let output='',settled=false;
  const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(Error('host_ingress_timeout'));},15000);
  child.on('error',()=>finish(Error('host_ingress_unavailable')));
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536){child.kill();finish(Error('host_ingress_invalid'));}});
  child.stdin.on('error',()=>finish(Error('host_ingress_unavailable')));
  child.on('close',code=>{if(code!==0)return finish(Error('host_ingress_unavailable'));try{const value=JSON.parse(output);if(value.deliveryId!==payload.deliveryId||value.queued!==true)throw Error();finish(null,value);}catch{finish(Error('host_ingress_invalid'));}});
  child.stdin.end(JSON.stringify(payload)+'\n');
 });
 try{return await run();}catch{return await run();}
}


