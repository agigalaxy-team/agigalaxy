import {readdirSync,realpathSync,statSync} from 'node:fs';
import {basename,isAbsolute,relative,resolve} from 'node:path';

const candidateTests=new Set(['native-candidate-case-receipts.test.mjs','native-candidate-full-review.test.mjs',
 'native-candidate-moderation-receipt.test.mjs','native-owner-candidate.test.mjs','native-retained-receipt-candidate.test.mjs']);
const isolatedChatTests=new Set(['chat-attachments-real.test.mjs','chat-prosody.test.mjs',
 'outcome-material-real.test.mjs','chat-shared-summary-prosody.test.mjs']);

// Preserve the existing explicit package/top-level test scope. Environment or
// captured-artifact acceptance must never fall back to a live/default service.
export function discoverCheckTests(root,mode,env=process.env,selectedFiles=[]){
 const separate=[];
 if(!!env.GALAXY_NATIVE_TEST_SOURCE!==!!env.GALAXY_NATIVE_TEST_CANDIDATE)
  throw new Error('Captured artifact acceptance requires both GALAXY_NATIVE_TEST_SOURCE and GALAXY_NATIVE_TEST_CANDIDATE.');
 const selfContained=(file,available,external)=>{
  if(available||!external.has(file))return true;
  separate.push(file);return false;
 };
 const packages=mode==='core'?['galaxy-core']:mode==='official'?['galaxy-official']
  :mode==='a2a'?['galaxy-a2a']:['galaxy-core','galaxy-official','galaxy-a2a','galaxy-web','galaxy-edge-mcp'];
 if(selectedFiles.length){
  const prefixes=packages.map(name=>'packages/'+name+'/test/');
  if(mode==='all'||mode==='test')prefixes.push('scripts/test/');
  const realRoot=realpathSync(root);
  const files=[...new Set(selectedFiles)].map(file=>{
   const local=relative(root,resolve(root,file)).replaceAll('\\','/');
   if(file.startsWith('-')||!local.endsWith('.test.mjs')||!prefixes.some(prefix=>local.startsWith(prefix)))
    throw new Error('Select a .test.mjs file within the requested package scope: '+file);
   const absolute=resolve(root,file);
   const realLocal=relative(realRoot,realpathSync(absolute));
   if(realLocal==='..'||realLocal.startsWith('..\\')||realLocal.startsWith('../')||isAbsolute(realLocal)||!statSync(absolute).isFile())
    throw new Error('Test must be a repository file: '+file);
   const name=basename(absolute);
   if(isolatedChatTests.has(name)&&env.GALAXY_TEST_CHAT_ISOLATED!=='1')
    throw new Error('Selected test requires GALAXY_TEST_CHAT_ISOLATED=1: '+file);
   if(candidateTests.has(name)&&!env.GALAXY_NATIVE_TEST_CANDIDATE)
    throw new Error('Selected test requires captured GALAXY_NATIVE_TEST_SOURCE and GALAXY_NATIVE_TEST_CANDIDATE: '+file);
   return local;
  });
  return {packages:[...new Set(files.map(file=>file.startsWith('packages/')?file.split('/')[1]:'scripts'))],files,separate};
 }
 const files=packages.flatMap(name=>{
  const discovered=readdirSync(resolve(root,'packages',name,'test'))
   .filter(file=>file.endsWith('.test.mjs'))
   .filter(file=>selfContained(file,env.GALAXY_TEST_CHAT_ISOLATED==='1',isolatedChatTests)).sort();
  if(!discovered.length)throw new Error(`No tests discovered in ${name}`);
  return discovered.map(file=>`packages/${name}/test/${file}`);
 });
 if(mode==='all'||mode==='test'){
  files.push(...readdirSync(resolve(root,'scripts/test'))
   .filter(file=>file.endsWith('.test.mjs'))
   .filter(file=>selfContained(file,!!env.GALAXY_NATIVE_TEST_CANDIDATE,candidateTests))
   .sort().map(file=>`scripts/test/${file}`));
 }
 return {packages,files,separate};
}
