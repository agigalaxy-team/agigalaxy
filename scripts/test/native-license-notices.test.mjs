import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,cp,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyNativeLicenseNotices,generateNativeLicenseNotices} from '../native-license-notices.mjs';
const candidate=process.env.GALAXY_NATIVE_LICENSE_CANDIDATE;
test('actual locked package original mixed licenses survive; read-only verification rejects omission and tampering',{skip:!candidate},async()=>{
 const first=await verifyNativeLicenseNotices({candidate});assert.ok(first.components>=6);assert.equal(first.readOnly,true);
 const inventory=JSON.parse(await readFile(join(candidate,'license-inventory.json'),'utf8'));
 const mcp=inventory.components.find(c=>c.name==='@modelcontextprotocol/server');
 assert.equal(mcp.version,'2.0.0');assert.equal(mcp.declaredPackageLicense,'MIT');
 assert.equal(mcp.licenseInterpretation,'upstream-license-transition-and-retained-original-terms');
 const text=await readFile(join(candidate,mcp.notices[0].path));
 assert.deepEqual(text,await readFile(join(candidate,mcp.notices[0].sourcePath)));
 assert.match(text.toString(),/MIT License/);assert.match(text.toString(),/Apache/);assert.match(text.toString(),/CC-BY-4\.0/);
 const original=await readFile(join(candidate,'license-inventory.json')),mtime=(await stat(join(candidate,'license-inventory.json'))).mtimeMs;
 assert.deepEqual(await verifyNativeLicenseNotices({candidate}),first);
 assert.equal((await stat(join(candidate,'license-inventory.json'))).mtimeMs,mtime);
 const temporary=await mkdtemp(join(tmpdir(),'galaxy-native-license-check-'));
 try{
  const copy=join(temporary,'candidate');await cp(candidate,copy,{recursive:true,errorOnExist:true});
  await assert.rejects(generateNativeLicenseNotices({candidate:copy}),{code:'EEXIST'});
  const copiedLicense=join(copy,mcp.notices[0].path);
  await writeFile(copiedLicense,text+'\nChanged test text');
  await assert.rejects(verifyNativeLicenseNotices({candidate:copy}),/original text changed/);
  await writeFile(copiedLicense,text);await rm(copiedLicense);
  await assert.rejects(verifyNativeLicenseNotices({candidate:copy}),{code:'ENOENT'});
  await writeFile(copiedLicense,text);
  const lockPath=join(copy,'package-lock.json'),lock=JSON.parse(await readFile(lockPath,'utf8'));
  lock.packages['node_modules/@modelcontextprotocol/server'].version='2.0.1';await writeFile(lockPath,JSON.stringify(lock));
  await assert.rejects(verifyNativeLicenseNotices({candidate:copy}),/dependency differs/);
  assert.deepEqual(await readFile(join(copy,'license-inventory.json')),original,'verification does not rewrite stale reports');
 }finally{
  const path=resolve(temporary);assert.ok(path.startsWith(resolve(tmpdir())+sep));assert.match(path.split(sep).at(-1),/^galaxy-native-license-check-/);
  await rm(path,{recursive:true,force:true});
 }
});
