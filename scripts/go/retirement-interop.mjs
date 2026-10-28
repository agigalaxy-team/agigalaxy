// Read-only oracle over the current original retirement controller and exact
// service-access classifier. Synthetic keys are written only to an OS test dir.
import {readFile,writeFile} from 'node:fs/promises';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {createRetirementController,retirementPolicySchema} from '../../packages/galaxy-official/src/privacy/retirement.mjs';
import {serviceAccessV2} from '../../packages/galaxy-official/src/operations/service-access-v2.mjs';
import {createGalaxyGenesis} from '../../packages/galaxy-core/src/galaxy-guid.mjs';
if(process.argv[2]==='stranger'){
 const dir=process.env.GALAXY_GO_TEST_RETIREMENT_DIR;if(!isAbsolute(dir??''))throw Error('absolute disposable directory required');
 const pair=generateKeyPairSync('ed25519'),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'}),genesis=createGalaxyGenesis({publicKeyPem,originCode:'5',issuedAtMs:2000000000000});await writeFile(join(dir,'stranger-private.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});console.log(JSON.stringify({genesis,installationId:randomUUID()}));
}else{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));
 const original=await readFile(new URL('../../packages/galaxy-official/src/operations/service-access-v2.mjs',import.meta.url),'utf8');
 const paths=[...new Set([...original.matchAll(/'(\/[^']+)'/g)].map(m=>m[1]))];
 const routes=new Map();const add=(method,path)=>routes.set(method+' '+path,{method,path,access:serviceAccessV2(method,path)});
 for(const path of paths){for(const method of ['POST','GET','PUT'])add(method,path);add('POST',path+'/extra')};
 for(const {method,path} of input.routes??[])add(method,path);
 const observations=[];for(const at of input.times){const controller=createRetirementController(input.policy,{endpoint:input.endpoint,now:()=>at});const gate=[];for(const r of routes.values()){let code=null;try{controller.assertRoute(r.method,r.path)}catch(e){code=e.code};gate.push(code)};let downloadCode=null;try{controller.assertDownload()}catch(e){downloadCode=e.code};observations.push({at,snapshot:controller.snapshot(),gate,downloadCode,downloadDeadline:Number.isFinite(controller.downloadDeadline())?controller.downloadDeadline():null})}
 console.log(JSON.stringify({routes:[...routes.values()],observations,validations:(input.invalidPolicies??[]).map(p=>retirementPolicySchema.safeParse(p).success)}));
}
