import {spawnSync} from 'node:child_process';
import {discoverCheckTests} from './test-discovery.mjs';

// The public CLI supplies the repository root. Commands remain fixed local
// Node checks; no command manifest or arbitrary executable is accepted.
export function runChecks({root,mode='all',env=process.env,testFiles=[]}){
 if(!['all','test','core','official','a2a','lint'].includes(mode)||(mode==='lint'&&testFiles.length)){
  console.error('Usage: node scripts/check.mjs [all|test|core|official|a2a|lint] [related.test.mjs ...]');
  return 2;
 }
 const [major,minor]=process.versions.node.split('.').map(Number);
 const official=!['core','lint'].includes(mode);
 if(major<(official?24:22)||(major===(official?24:22)&&minor<13)){
  console.error(official?'Combined checks require Node >=24.13.0.':'Core checks require Node >=22.13.0.');
  return 2;
 }
 function run(label,args){
  console.log(`\n[galaxy-check] ${label}`);
  const childEnv={...env};
  // A parent node:test context must not suppress this fresh CLI discovery.
  delete childEnv.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',shell:false,env:childEnv});
  if(result.error||result.status!==0){
   console.error(`[galaxy-check] ${label} failed${result.signal?` (${result.signal})`:''}`);
   return result.status??1;
  }
  return 0;
 }
 if(mode!=='lint'){
  let selection;
  try{selection=discoverCheckTests(root,mode,env,testFiles);}
  catch(error){console.error('[galaxy-check] '+error.message);return 2;}
  const {packages,files,separate}=selection;
  if(separate.length)console.log('[galaxy-check] separate environment/artifact acceptance (not executed by this run): '+separate.join(', '));
  // Bound file processes only; individual tests retain their own concurrency.
  const status=run(`tests (${packages.join(', ')}; ${files.length} files; concurrency 4)`,['--import','tsx','--experimental-test-module-mocks','--test','--test-concurrency=4',...files]);
  if(status!==0)return status;
 }
 if(mode==='all'||mode==='lint'){
  const status=run('lint',['node_modules/oxlint/bin/oxlint','app','packages','scripts','lib/browser-demo.mjs']);
  if(status!==0)return status;
 }
 console.log('[galaxy-check] requested checks passed.');
 return 0;
}
