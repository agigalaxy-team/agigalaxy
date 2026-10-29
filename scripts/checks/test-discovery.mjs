import {existsSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {basename,isAbsolute,relative,resolve} from 'node:path';

const isolatedChatTests=new Set(['chat-attachments-real.test.mjs','chat-prosody.test.mjs',
 'outcome-material-real.test.mjs','chat-shared-summary-prosody.test.mjs']);

// Preserve the explicit package/top-level scope. Tests requiring an isolated
// environment must never fall back to a live/default service.
export function discoverCheckTests(root,mode,env=process.env,selectedFiles=[]){
 const separate=[];
 const selfContained=(file,available,external)=>{
  if(available||!external.has(file))return true;
  separate.push(file);return false;
 };
 const packages=mode==='a2a'?['galaxy-a2a']:['galaxy-contracts','galaxy-client','galaxy-a2a','galaxy-web'];
 const extraRoots=mode==='a2a'?[]:['integrations/host-adapters/opencode-stable/test/',
  'packages/galaxy-official/deploy/test/','packages/galaxy-official/scripts/test/'];
 if(selectedFiles.length){
  const prefixes=[...packages.map(name=>'packages/'+name+'/test/'),...extraRoots];
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
   return local;
  });
  return {packages:[...new Set(files.map(file=>file.startsWith('packages/')?file.split('/')[1]:'scripts'))],files,separate};
 }
 const files=packages.flatMap(name=>{
  if(!existsSync(resolve(root,'packages',name,'test')))return [];
  const discovered=readdirSync(resolve(root,'packages',name,'test'))
   .filter(file=>file.endsWith('.test.mjs'))
   .filter(file=>selfContained(file,env.GALAXY_TEST_CHAT_ISOLATED==='1',isolatedChatTests)).sort();
  if(!discovered.length&&mode==='a2a')throw new Error(`No tests discovered in ${name}`);
  return discovered.map(file=>`packages/${name}/test/${file}`);
 });
 for(const area of extraRoots){
  if(!existsSync(resolve(root,area)))continue;
  files.push(...readdirSync(resolve(root,area)).filter(file=>file.endsWith('.test.mjs')).sort().map(file=>area+file));
 }
 if(mode==='all'||mode==='test'){
  files.push(...readdirSync(resolve(root,'scripts/test'))
   .filter(file=>file.endsWith('.test.mjs'))
   .sort().map(file=>`scripts/test/${file}`));
 }
 return {packages,files,separate};
}
