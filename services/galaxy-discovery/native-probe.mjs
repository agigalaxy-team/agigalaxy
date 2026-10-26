import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';

// Root-only operational probe. Input is protected Galaxy discovery config,
// either an absolute file argument or stdin (-). Nothing resolved is printed.
// It never calls OpenPanel, creates a user/feedback, or writes Galaxy source DB.
const input=process.argv[2];
if(!input)throw new Error('Protected config file or stdin (-) is required');
let raw;if(input==='-'){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)throw new Error('Probe config too large');chunks.push(chunk);}raw=Buffer.concat(chunks).toString('utf8');}else raw=await readFile(input,'utf8');
let config;try{config=JSON.parse(raw);}catch{throw new Error('Invalid protected discovery probe configuration');}const options=config.config??config;
function engine(name){const value=options[name];let url;try{url=new URL(value?.url);}catch{throw new Error('Invalid private engine origin');}if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','meilisearch','gorse-gateway'].includes(url.hostname)||url.pathname!=='/'||url.username||url.password||url.search||url.hash||typeof value.apiKey!=='string'||value.apiKey.length<24)throw new Error('Explicit private engine configuration required');return{url:url.origin,key:value.apiKey};}
const meili=engine('meilisearch'),gorse=engine('gorse');
const index='galaxy_native_probe_'+randomUUID().replaceAll('-',''),documentId='probe_'+randomUUID().replaceAll('-',''),itemId='post_'+randomUUID();
const result={startedAt:new Date().toISOString(),scope:'native-engine-operational-probe-not-business-traffic',objects:{meilisearchIndex:index,gorseItem:itemId},checks:[],cleanup:{meilisearch:false,gorse:false},openpanelTouched:false,galaxySourceDatabaseTouched:false,usersCreated:0,feedbackCreated:0};
const check=name=>result.checks.push({name,passed:true});
const fail=code=>{throw Object.assign(new Error(code),{code});};
async function request(service,path,{method='GET',body,absent=false}={}){
 let response;try{response=await fetch(service.url+path,{method,headers:{...(service===meili?{Authorization:'Bearer '+service.key}:{'X-API-Key':service.key}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});}catch{fail('native_probe_transport_failed');}
 if(absent&&response.status===404)return null;
 if(!response.ok)fail('native_probe_http_'+response.status);
 try{return await response.json();}catch{fail('native_probe_response_invalid');}
}
async function task(value){if(!Number.isInteger(value?.taskUid))fail('native_probe_task_invalid');const until=Date.now()+20000;while(Date.now()<until){const status=await request(meili,'/tasks/'+value.taskUid);if(status.status==='succeeded')return;if(['failed','canceled'].includes(status.status))fail('native_probe_task_failed');await pause(150);}fail('native_probe_task_pending');}
let indexIntent=false,itemIntent=false;
try{
 if(await request(meili,'/indexes/'+index,{absent:true}))fail('native_probe_index_collision');
 indexIntent=true;await task(await request(meili,'/indexes',{method:'POST',body:{uid:index,primaryKey:'id'}}));
 await task(await request(meili,'/indexes/'+index+'/settings',{method:'PATCH',body:{searchableAttributes:['title','body'],displayedAttributes:['id']}}));
 await task(await request(meili,'/indexes/'+index+'/documents',{method:'POST',body:[{id:documentId,title:'原生中文检索运维验证',body:'银河中文分词与协作搜索。此临时对象不是银河业务内容。'}]}));
 const found=await request(meili,'/indexes/'+index+'/search',{method:'POST',body:{q:'协作 搜索',limit:3,attributesToRetrieve:['id']}});
 if(!found.hits?.some(row=>row.id===documentId))fail('native_probe_chinese_match_missing');check('meilisearch-native-chinese-tokenization-match');
 itemIntent=true;
 const inserted=await request(gorse,'/api/items',{method:'POST',body:[{ItemId:itemId,IsHidden:false,Categories:['unclassified'],Timestamp:new Date().toISOString(),Labels:{tags:['galaxy-native-probe']},Comment:'Temporary operational probe; not Galaxy source content'}]});
 if(inserted?.RowAffected!==1)fail('native_probe_gorse_insert_unconfirmed');check('gorse-native-postgres-item-write-acknowledged');
 const latest=await request(gorse,'/api/latest?n=1');if(!Array.isArray(latest))fail('native_probe_gorse_latest_invalid');
 // Warm-up may not have put a just-inserted item into its native candidate
 // cache yet. An empty read is recorded honestly, not called personalization.
 result.gorseLatest={responded:true,temporaryProbeObserved:latest.some(row=>(row.Id??row.ItemId)===itemId),personalizationClaimed:false};check('gorse-native-latest-read');
}catch(error){result.errorCode=typeof error.code==='string'?error.code:'native_probe_failed';}
finally{
 if(indexIntent)try{const deletion=await request(meili,'/indexes/'+index,{method:'DELETE',absent:true});if(deletion)await task(deletion);if(await request(meili,'/indexes/'+index,{absent:true}))fail('native_probe_index_cleanup_unconfirmed');result.cleanup.meilisearch=true;}catch(error){result.cleanup.meilisearchError=typeof error.code==='string'?error.code:'native_probe_cleanup_failed';}
 if(itemIntent)try{const deletion=await request(gorse,'/api/item/'+itemId,{method:'DELETE'});if(deletion?.RowAffected!==1)fail('native_probe_item_cleanup_unconfirmed');result.cleanup.gorse=true;}catch(error){result.cleanup.gorseError=typeof error.code==='string'?error.code:'native_probe_cleanup_failed';}
 result.finishedAt=new Date().toISOString();result.passed=!result.errorCode&&result.cleanup.meilisearch&&result.cleanup.gorse;console.info(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
