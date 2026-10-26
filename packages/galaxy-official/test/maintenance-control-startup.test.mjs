import test from 'node:test';
import assert from 'node:assert/strict';
import * as nativeFs from 'node:fs/promises';

test('maintenance startup accepts the current workbench native release while retaining fixed project, private file and path checks',async t=>{
 const controlFile='/etc/galaxy/model-settings/control.json',base='/opt/galaxy/operations-engines/releases/';
 let control,controlMeta,composeMeta,linkedParent=null;const reads=[];
 const reset=path=>{control={version:1,composeFile:base+path+'/compose.yaml',composeProject:'galaxy-model-runtime'};controlMeta={uid:0,mode:0o600,size:163};composeMeta={uid:0,mode:0o640,size:1835};linkedParent=null;reads.length=0;};
 reset('workbench-live-20261023-r1');
 // The actual startup validator runs unchanged except for its release-family
 // compatibility patch. Filesystem calls are explicit synthetic metadata;
 // no current protected files, credentials, journal or native engine is used.
 t.mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(nativeFs).filter(([key])=>key!=='default')),
  async readFile(path){assert.equal(path,controlFile,'only non-secret control JSON may be read');reads.push(path);return JSON.stringify(control);},
  async lstat(path){
   const isControl=path===controlFile,isCompose=path===control.composeFile;
   assert(path===linkedParent||isControl||isCompose||controlFile.startsWith(path+'/')||control.composeFile.startsWith(path+'/'),'fixed ancestor or declared file only');
   const values=isControl?controlMeta:isCompose?composeMeta:{uid:0,mode:0o755,size:4096};
   return{...values,isFile:()=>isControl||isCompose,isSymbolicLink:()=>path===linkedParent};
  },
 }});
 const {readModelConfigurationControl}=await import('../deploy/maintenance-agent/model-configuration.mjs');
 assert.deepEqual(await readModelConfigurationControl(),control);assert.deepEqual(reads,[controlFile]);
 for(const name of ['model-settings-20261023-r1','model-settings-p13-20261023-r1','model-settings-conversations-20261023-r1']){
  reset(name);assert.deepEqual(await readModelConfigurationControl(),control);
 }
 for(const path of ['/tmp/compose.yaml',base+'another-service-r1/compose.yaml',base+'workbench-live-20261023-r1/../other/compose.yaml',base+'workbench-live-20261023-r1/override.yaml']){
  reset('workbench-live-20261023-r1');control.composeFile=path;await assert.rejects(readModelConfigurationControl(),{code:'model_settings_private_file_invalid'});
 }
 for(const change of ['project','extra','control-owner','control-mode','compose-owner','compose-mode','compose-size','parent-symlink']){
  reset('workbench-live-20261023-r1');
  if(change==='project')control.composeProject='arbitrary-project';
  if(change==='extra')control.command='untrusted-command';
  if(change==='control-owner')controlMeta.uid=1000;
  if(change==='control-mode')controlMeta.mode=0o644;
  if(change==='compose-owner')composeMeta.uid=1000;
  if(change==='compose-mode')composeMeta.mode=0o666;
  if(change==='compose-size')composeMeta.size=65537;
  if(change==='parent-symlink')linkedParent=base+'workbench-live-20261023-r1';
  await assert.rejects(readModelConfigurationControl(),error=>change==='parent-symlink'?error.message==='operations_symlink_target_rejected':error.code==='model_settings_private_file_invalid');
 }
 await assert.rejects(readModelConfigurationControl('/etc/galaxy/other/control.json'),{code:'model_settings_private_file_invalid'});
});
