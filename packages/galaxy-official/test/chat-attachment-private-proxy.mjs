import {createServer} from 'node:http';
import {readFile,writeFile,rename,mkdir,unlink} from 'node:fs/promises';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {join,isAbsolute,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as z from 'zod/v4';

const objectKey=z.string().regex(/^attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/),digest=value=>createHash('sha256').update(value).digest('hex');
const itemSchema=z.strictObject({key:objectKey,mappedKey:objectKey,sha256:sha,size:z.number().int().positive(),stored:z.boolean(),removed:z.boolean()});
const ledgerSchema=z.strictObject({version:z.literal(1),namespace:z.uuid(),keyId:z.string(),bucket:z.string(),storageKeyId:z.string(),
 items:z.array(itemSchema).max(256),counts:z.record(z.string(),z.number().int().nonnegative())});
const failure=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const keyInput=z.strictObject({key:objectKey}),readInput=keyInput.extend({keyId:z.string(),size:z.number().int().positive()}),
 headInput=keyInput.extend({keyId:z.string()});
const code=error=>typeof error?.code==='string'&&/^[a-z0-9_]{1,100}$/.test(error.code)?error.code:'isolated_attachment_proxy_unavailable';
function parse(schema,input){const result=schema.safeParse(input);if(!result.success)failure('isolated_attachment_proxy_request_invalid');return result.data;}
function mapKey(namespace,key){
 const bytes=Buffer.from(digest(namespace+'/'+key).slice(0,32),'hex');bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;
 const hex=bytes.toString('hex');return 'attachments/'+[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
async function bytes(request,max){
 const size=Number(request.headers['content-length']);if(!Number.isSafeInteger(size)||size<0||size>max||request.headers['transfer-encoding'])failure('isolated_attachment_proxy_length_invalid',413);
 let length=0;const chunks=[];for await(const chunk of request){length+=chunk.length;if(length>size)failure('isolated_attachment_proxy_length_invalid',413);chunks.push(chunk);}
 if(length!==size)failure('isolated_attachment_proxy_length_invalid');return Buffer.concat(chunks);
}
const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value));};

// Test-only SSH-loopback adapter. The real private adapters stay on the selected
// host. A caller key is mapped into this run, never passed to a production key.
export async function createAttachmentPrivateProxy({storage,directory,namespace,token,port=0}){
 if(!storage?.store||!storage?.scanner||!storage?.policy||!isAbsolute(directory??'')||!z.uuid().safeParse(namespace).success
  ||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||!Number.isInteger(port)||port<0||port>65535)failure('isolated_attachment_proxy_configuration_invalid');
 await mkdir(directory,{recursive:true,mode:0o700});const file=join(directory,'objects.json'),keyId='isolated-'+namespace;
 let ledger={version:1,namespace,keyId,bucket:storage.store.bucket??'contract',storageKeyId:storage.store.keyId,items:[],counts:{}};
 try{const original=await readFile(file);if(original.length>1048576)failure('isolated_attachment_proxy_ledger_invalid');const saved=parse(ledgerSchema,JSON.parse(original));
  if(saved.namespace!==namespace||saved.keyId!==keyId||saved.bucket!==ledger.bucket||saved.storageKeyId!==ledger.storageKeyId
   ||saved.items.some(item=>item.mappedKey!==mapKey(namespace,item.key)))failure('isolated_attachment_proxy_ledger_mismatch');ledger=saved;}
 catch(error){if(error.code!=='ENOENT')throw error;}
 let queue=Promise.resolve(),closing=false;
 const serial=action=>{const run=queue.then(action);queue=run.catch(()=>{});return run;};
 async function persist(){const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(ledger),{mode:0o600});await rename(temp,file);}
 await persist();
 function known(input){if(input.keyId!==undefined&&input.keyId!==keyId)failure('isolated_attachment_proxy_key_id_invalid',409);return ledger.items.find(item=>item.key===input.key);}
 function count(name){ledger.counts[name]=(ledger.counts[name]??0)+1;}
 async function erase(item){
  if(item.removed)return false;const current=await storage.store.head({key:item.mappedKey,keyId:storage.store.keyId});
  if(current&&(current.size!==item.size||current.sha256!==item.sha256))failure('isolated_attachment_proxy_object_changed',409);
  if(current){await storage.store.erase({key:item.mappedKey});count('erase');}
  item.removed=true;await persist();return !!current;
 }
 async function cleanup(){
  let erased=0;const failures=[];
  for(const item of ledger.items){try{if(await erase(item))erased++;}catch(error){failures.push({objectId:item.key.slice(12),code:code(error)});}}
  return {namespace,erased,pending:ledger.items.filter(item=>!item.removed).length,failures};
 }
 function metadata(){return {version:1,namespace,keyId,policy:storage.policy,counts:{...ledger.counts},
  objects:ledger.items.map(({key,sha256,size,stored,removed})=>({objectId:key.slice(12),sha256,size,stored,removed})),
  storage:'real-private-S3-SSE-C-adapter',scanner:'real-ClamAV-adapter',credentialsReturned:false};}
 const server=createServer((request,response)=>{
  const supplied=request.headers.authorization,expected='Bearer '+token;
  if(typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)
   ||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return json(response,{error:'isolated_attachment_proxy_denied'},401);
  const url=new URL(request.url,'http://127.0.0.1');
  if(closing)return json(response,{error:'isolated_attachment_proxy_closing'},503);
  void serial(async()=>{
   if(url.search||url.hash)failure('isolated_attachment_proxy_request_invalid');
   if(request.method==='GET'&&url.pathname==='/verify')return json(response,metadata());
   if(request.method!=='POST')failure('isolated_attachment_proxy_request_unknown',404);
   if(url.pathname==='/configuration'){parse(z.strictObject({namespace:z.literal(namespace)}),JSON.parse((await bytes(request,1000)).toString('utf8')));return json(response,{version:1,namespace,keyId,policy:storage.policy});}
   if(url.pathname==='/cleanup'){parse(z.strictObject({namespace:z.literal(namespace)}),JSON.parse((await bytes(request,1000)).toString('utf8')));return json(response,await cleanup());}
   if(url.pathname==='/store/put'){
    const key=parse(objectKey,request.headers['x-galaxy-object-key']),sha256=parse(sha,request.headers['x-galaxy-sha256']);
    const body=await bytes(request,storage.policy.maxFileBytes);if(!body.length||digest(body)!==sha256)failure('isolated_attachment_proxy_digest_mismatch');
    let item=known({key});
    if(item&&(item.removed||item.sha256!==sha256||item.size!==body.length))failure('isolated_attachment_proxy_operation_conflict',409);
    if(!item){
     if(ledger.items.length>=256)failure('isolated_attachment_proxy_run_limit',409);
     const mappedKey=mapKey(namespace,key);
     if(await storage.store.head({key:mappedKey,keyId:storage.store.keyId}))failure('isolated_attachment_proxy_object_exists',409);
     item={key,mappedKey,sha256,size:body.length,stored:false,removed:false};ledger.items.push(item);await persist();
    }
    await storage.store.put({key:item.mappedKey,bytes:body,sha256});item.stored=true;count('put');await persist();return json(response,{stored:true,keyId});
   }
   if(url.pathname==='/scan'){
    const expectedSha=parse(sha,request.headers['x-galaxy-sha256']),body=await bytes(request,storage.policy.maxFileBytes);
    if(digest(body)!==expectedSha||!ledger.items.some(item=>item.stored&&!item.removed&&item.sha256===expectedSha&&item.size===body.length))failure('isolated_attachment_proxy_scan_outside_run',403);
    const result=await storage.scanner.scan(body);count('scan');await persist();return json(response,result);
   }
   if(url.pathname==='/store/head'||url.pathname==='/store/get'||url.pathname==='/store/erase'){
    const schema=url.pathname==='/store/head'?headInput:url.pathname==='/store/get'?readInput:keyInput,
     input=parse(schema,JSON.parse((await bytes(request,2000)).toString('utf8'))),item=known(input);
    if(url.pathname==='/store/erase'){if(item)await erase(item);return json(response,{objectRemoved:true,physicalBlockErasure:'storage-garbage-collection'});}
    if(!item||item.removed)return json(response,null,url.pathname==='/store/get'?404:200);
    if(url.pathname==='/store/head'){const value=await storage.store.head({key:item.mappedKey,keyId:storage.store.keyId});count('head');await persist();return json(response,value);}
    if(input.size!==item.size)failure('isolated_attachment_proxy_size_mismatch');
    const value=await storage.store.get({key:item.mappedKey,keyId:storage.store.keyId,size:item.size});
    if(!value)return json(response,null,404);
    if(value.length!==item.size||digest(value)!==item.sha256)failure('isolated_attachment_proxy_integrity_failed',502);
    count('get');await persist();response.writeHead(200,{'content-type':'application/octet-stream','content-length':value.length,'x-galaxy-content-sha256':item.sha256,'cache-control':'no-store'});response.end(value);return;
   }
   failure('isolated_attachment_proxy_request_unknown',404);
  }).catch(error=>{if(!response.headersSent)json(response,{error:code(error)},Number.isInteger(error.status)?error.status:503);else response.destroy();});
 });
 server.requestTimeout=90000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return{port:server.address().port,verify:()=>serial(async()=>metadata()),close:async({cleanupObjects=false}={})=>{
  closing=true;server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));await queue;
  const result=cleanupObjects?await cleanup():{namespace,pending:ledger.items.filter(item=>!item.removed).length};
  storage.store.close?.();return result;}};
}
if(process.argv.includes('--proxy')&&resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 const configurationModule=process.env.GALAXY_TEST_ATTACHMENT_CONFIGURATION_MODULE,secretFile=process.env.GALAXY_TEST_ATTACHMENT_PROXY_SECRET_FILE,
  directory=process.env.GALAXY_TEST_ATTACHMENT_PROXY_DIRECTORY;
 if(!isAbsolute(configurationModule??'')||!isAbsolute(secretFile??'')||!isAbsolute(directory??'')||resolve(dirname(secretFile))!==resolve(directory))failure('isolated_attachment_proxy_explicit_paths_required');
 const {loadAttachmentConfiguration}=await import(pathToFileURL(configurationModule).href),storage=await loadAttachmentConfiguration();
 const proxy=await createAttachmentPrivateProxy({storage,directory,namespace:process.env.GALAXY_TEST_ATTACHMENT_NAMESPACE,
  token:(await readFile(secretFile,'utf8')).trim(),port:Number(process.env.GALAXY_TEST_ATTACHMENT_PROXY_PORT)});
 process.stdout.write(JSON.stringify({ready:true,pid:process.pid,host:'127.0.0.1',port:proxy.port,namespace:process.env.GALAXY_TEST_ATTACHMENT_NAMESPACE,credentialsReturned:false})+'\n');
 let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  if(stopping)return;stopping=true;void proxy.close({cleanupObjects:true}).then(async result=>{await unlink(secretFile);process.stdout.write(JSON.stringify({stopped:true,...result})+'\n');process.exit(result.pending?1:0);}).catch(()=>{process.stdout.write(JSON.stringify({stopped:false,error:'isolated_attachment_proxy_cleanup_incomplete'})+'\n');process.exit(1);});
 });
}
