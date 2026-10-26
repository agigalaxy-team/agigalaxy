import {createHash} from 'node:crypto';
import {lstat,readdir,readFile} from 'node:fs/promises';

const fail=code=>Object.assign(Error(code),{code});
// Compare current protected configuration before opening; these digests remain
// in the private restoration context. They are not a credential catalog/API.
export async function protectedConfigurationFingerprint({roots=['/etc/galaxy','/var/lib/galaxy/config'],maxFiles=10000}={}){
 const hash=createHash('sha256');let files=0;
 async function visit(path){
  const info=await lstat(path);if(info.isSymbolicLink())throw fail('maintenance_protected_configuration_symlink');
  if(info.isDirectory()){for(const entry of(await readdir(path)).sort())await visit(path+'/'+entry);return;}
  if(!info.isFile()||info.size>32*1024*1024||++files>maxFiles)throw fail('maintenance_protected_configuration_limit');
  hash.update(JSON.stringify([path,info.uid,info.gid,info.mode&0o777]));hash.update(await readFile(path));
 }
 for(const root of roots)await visit(root);
 return{sha256:hash.digest('hex'),fileCount:files,basis:'current-protected-configuration-and-key-files'};
}
