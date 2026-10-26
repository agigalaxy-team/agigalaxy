import {lstat,realpath,readlink,symlink,rename,lchown} from 'node:fs/promises';
import {posix} from 'node:path';
import {noSymlinkPath} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const operation=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Only this server-owned current pointer is switchable. The browser/model
// supplies neither a path nor a symlink target. Alternate roots are test-only
// direct construction, never read from a service/HTTP configuration.
export class MaintenanceWebsitePointer{
 constructor({root='/srv/galaxy/website'}={}){this.root=root;}
 target(value){if(typeof value!=='string'||posix.dirname(value)!==this.root+'/releases'||!/^[-a-zA-Z0-9._]+$/.test(posix.basename(value)))throw fail('maintenance_website_point_binding_invalid');return value;}
 async stage(context){
  if(!context.intent.moduleIds.includes('website'))return null;if(!operation.test(context.intent.operationId))throw fail('maintenance_operation_invalid');
  const item=context.point.manifest.files.find(x=>x.id==='website-release'),current=this.root+'/current',source=context.footprint.sources.find(x=>x.id==='website-release');
  if(!item||source?.path!==current||item.path!==current)throw fail('maintenance_website_current_pointer_not_recorded');
  const target=this.target(item.resolvedPath);if(!context.artifacts.fileTransfers?.some(x=>x.path===target))throw fail('maintenance_website_point_binding_invalid');
  await noSymlinkPath(this.root);const old=await lstat(current);if(!old.isSymbolicLink())throw fail('maintenance_website_current_pointer_changed');
  this.target(await realpath(current));const previous=current+'.galaxy-before-'+context.intent.operationId,candidate=current+'.galaxy-next-'+context.intent.operationId;
  for(const file of[previous,candidate])try{await lstat(file);throw fail('maintenance_restore_candidate_already_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  const before=await readlink(current);await symlink(target,candidate);await lchown(candidate,old.uid,old.gid);
  return{operationId:context.intent.operationId,current,target,before,candidate,previous};
 }
 validateRecord(record){
  if(!record||!operation.test(record.operationId)||record.current!==this.root+'/current'||record.candidate!==record.current+'.galaxy-next-'+record.operationId||record.previous!==record.current+'.galaxy-before-'+record.operationId)throw fail('maintenance_website_point_binding_invalid');this.target(record.target);
 }
 async activate(record){
  this.validateRecord(record);await noSymlinkPath(this.root);
  if(!(await lstat(record.current)).isSymbolicLink()||await readlink(record.current)!==record.before||!(await lstat(record.candidate)).isSymbolicLink()||await readlink(record.candidate)!==record.target||await realpath(record.target)!==record.target)throw fail('maintenance_website_current_pointer_changed');
  await rename(record.current,record.previous);await rename(record.candidate,record.current);
  return{accepted:true};
 }
 async verify(record){this.validateRecord(record);if(!(await lstat(record.current)).isSymbolicLink()||await readlink(record.current)!==record.target||await realpath(record.current)!==record.target)throw fail('maintenance_website_current_pointer_changed');return{ready:true};}
}
