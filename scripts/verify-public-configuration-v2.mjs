import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createWebRuntime,loadWebConfiguration} from '../packages/galaxy-web/src/runtime.mjs';
import {createConfigurationClient} from "../packages/galaxy-web/src/features/tools/configuration-client.mjs";

const release=process.argv[2],reportPath=process.argv[3];
assert.match(release??'',/^official-2026\.09\.13-product-v2-r[1-9][0-9]*$/);
assert.ok(reportPath&&isAbsolute(reportPath));
const ready=await fetch('https://official.agigalaxy.org/readyz',{redirect:'error'});
assert.equal(ready.status,200);assert.equal(ready.headers.get('x-galaxy-release'),release);
const config=await loadWebConfiguration((path,options)=>{assert.equal(path,'/galaxy-web-config.json');return fetch('https://agigalaxy.org/galaxy-web-config.json',options);});
assert.equal(config.endpoint,'https://official.agigalaxy.org');
const values=new Map(),store={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{values.set(key,structuredClone(value));}};
const runtime=await createWebRuntime(config,{store,fetch:(url,options)=>fetch(url,{...options,headers:{...options.headers,Origin:'https://agigalaxy.org'}})});
const record={observedAt:new Date().toISOString(),release,scope:'synthetic private configuration using real public HTTPS, WebCrypto and BrowserClient; no UI or real account acceptance',checks:{},backupStarted:false};
let client,configurationId,configurationVersion=0;
try{
 await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
 const status=await runtime.status(),subjectId=status.identity.subjectId;
 record.subjectId=subjectId;record.bindingId=status.connection.bindingId;record.checks.currentDeviceSignatureAndSession=true;
 client=createConfigurationClient({api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,subjectId});
 configurationId=randomUUID();
 const payload={schemaVersion:2,id:configurationId,operationId:randomUUID(),expectedVersion:0,actorId:subjectId,kind:'record',
 title:'合成部署验证配置',summary:'仅验证明确选定配置元数据的私有写入、读取与撤销，不代表真实工作环境。',
 conditions:{model:{name:null,version:null},runtime:{name:null,version:null},environment:{name:null,version:null},tools:[],skills:[],mcp:[],
 promptPolicyVersion:null,rulesVersion:null,operationScope:[],inputScopeSummary:null,limitations:'Synthetic deployment probe; no user files, prompts, model use or capability claim.'},
 observedAt:new Date().toISOString(),synthetic:true,selectedFieldsOnly:true};
 const preview=await client.prepare(payload,{visibility:'Private',viewers:[]});
 await client.execute(preview,{confirmed:true});configurationVersion=1;
 const read=await client.get({id:configurationId,version:1});assert.equal(read.record.synthetic,true);assert.equal(read.record.title,payload.title);
 record.checks.privateConfigurationExactVersion=true;record.configurationId=configurationId;
 const owned=await runtime.api.call('/v1/builders/owned/query',{});assert.ok(Array.isArray(owned.items));record.checks.builderOwnedQuery=true;
 await assert.rejects(runtime.api.call('/v2/builders/support/read',{builderId:randomUUID()}),error=>error.status===404);
 record.checks.builderSupportMissingObjectIs404=true;
}catch(error){record.failure={type:error.name,code:error.code??'probe_failed'};process.exitCode=1;}
finally{
 if(client&&configurationVersion){try{const preview=await client.prepare({schemaVersion:2,id:configurationId,operationId:randomUUID(),expectedVersion:configurationVersion,actorId:record.subjectId,kind:'revoke',reason:'Synthetic deployment validation finished.'},{visibility:'Private',viewers:[]});await client.execute(preview,{confirmed:true});record.configurationRevoked=true;}catch{record.configurationRevoked=false;process.exitCode=1;}}
 try{if(record.bindingId){await runtime.api.call('/v1/bindings/'+record.bindingId+'/revoke',{});record.bindingRevoked=true;}}catch{record.bindingRevoked=false;process.exitCode=1;}
 runtime.close();values.clear();record.localSyntheticKeysDiscarded=true;record.completedAt=new Date().toISOString();
 await writeFile(reportPath,JSON.stringify(record,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(record));
}
