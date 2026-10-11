import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {nativeArtifactFilename,downloadedLocal} from '../native-download-inputs.mjs';

test('native artifact selection follows exact numeric component version, preserving old 0.2.0 filenames',()=>{
 for(const version of ['0.1.0','0.1.1','0.2.0'])assert.equal(nativeArtifactFilename({name:'@galaxy/native-client',version,filename:`galaxy-native-client-${version}.tgz`}),`galaxy-native-client-${version}.tgz`);
 for(const [version,filename]of [['0.1.0','galaxy-native-client-0.2.0.tgz'],['01.1.0','galaxy-native-client-01.1.0.tgz'],['0.1.0','../private-key']])
  assert.throws(()=>nativeArtifactFilename({name:'@galaxy/native-client',version,filename}));
 assert.throws(()=>nativeArtifactFilename({name:'@galaxy/official',version:'0.1.0',filename:'galaxy-native-client-0.1.0.tgz'}));
});

test('download verification reads bounded regular local members and rejects path/size escapes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-download-input-'));
 try{
  await writeFile(join(directory,'release.json'),'{}');
  assert.equal((await downloadedLocal(directory,'release.json',2)).toString(),'{}');
  await assert.rejects(downloadedLocal(directory,'release.json',1));
  await assert.rejects(downloadedLocal(directory,'../release.json',100));
  await assert.rejects(downloadedLocal(directory,'.',100));
 }finally{
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep));
  assert.ok(target.split(sep).at(-1).startsWith('galaxy-download-input-'));
  await rm(target,{recursive:true,force:true});
 }
});
