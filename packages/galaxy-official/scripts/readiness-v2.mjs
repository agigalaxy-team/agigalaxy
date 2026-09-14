import { readFile,realpath,lstat,writeFile } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadinessReport,readinessInputSchema } from '../src/operations/readiness-v2.mjs';

const [rootArg,inputArg,outputArg]=process.argv.slice(2);
if(!rootArg||!inputArg||!outputArg||process.argv.length!==5){
 console.error('Usage: node readiness-v2.mjs PROJECT_ROOT INPUT_JSON NEW_OUTPUT_JSON');process.exitCode=2;
}else{
 try{
  const root=await realpath(rootArg);
  const within=p=>{const r=relative(root,p);if(!r||r==='..'||r.startsWith('..\\')||r.startsWith('../')||isAbsolute(r))throw new Error('readiness_path_outside_project');return p;};
  async function safeFile(p){const target=within(resolve(root,p));const stat=await lstat(target);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw new Error('invalid_readiness_file');
   within(await realpath(target));return target;
  }
  const inputPath=await safeFile(inputArg),input=readinessInputSchema.parse(JSON.parse(await readFile(inputPath,'utf8'))),verified=[];
  for(const e of input.evidence){
   if(/(?:^|[\\/])(?:\.env(?:\..*)?|auth(?:entication)?|credentials?|hermes(?:[^\\/]*)?)(?:[\\/]|$)/i.test(e.path))throw new Error('excluded_readiness_source');
   const path=await safeFile(e.path),hash=createHash('sha256').update(await readFile(path)).digest('hex');
   if(hash!==e.sha256)throw new Error('readiness_source_changed:'+e.id);verified.push(e.id);
  }
  const result=createReadinessReport(input,{verifiedEvidenceIds:verified}),output=within(resolve(root,outputArg));
  within(await realpath(resolve(output,'..')));
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({report:relative(root,output),evidenceVerified:verified.length,readiness:result.readiness}));
 }catch(e){console.error(JSON.stringify({error:e?.message??'readiness_failed'}));process.exitCode=1;}
}
