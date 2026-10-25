import {readFile,lstat} from 'node:fs/promises';
import {posix} from 'node:path';
import {readOperationsConfiguration} from '../operations-stack/configuration.mjs';

const fail=()=>new Error('maintenance_private_configuration_invalid');
export async function readMaintenanceAgentConfiguration(file){
 if(typeof file!=='string'||!file.startsWith('/etc/galaxy/')||posix.normalize(file)!==file)throw fail();
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o077)||info.size>32768)throw fail();
 let x;try{x=JSON.parse(await readFile(file,'utf8'));}catch{throw fail();}
 if(x?.version!==1||Object.keys(x).some(k=>!['version','operationsConfigurationFile','socketPath','serviceKeyFile','apiGroupId','controlDirectory','production','authorizationUrl'].includes(k)))throw fail();
 if(!/^\/run\/galaxy-maintenance\/[a-z0-9-]+[.]sock$/.test(x.socketPath??'')||!/^\/etc\/galaxy\/[A-Za-z0-9._/-]+$/.test(x.serviceKeyFile??'')||!Number.isSafeInteger(x.apiGroupId)||x.apiGroupId<1||!/^\/var\/lib\/galaxy\/maintenance(?:\/[a-z0-9-]+)?$/.test(x.controlDirectory??''))throw fail();
 const keyInfo=await lstat(x.serviceKeyFile);if(!keyInfo.isFile()||keyInfo.isSymbolicLink()||keyInfo.uid!==0||(keyInfo.mode&0o027)||keyInfo.size>2048)throw fail();
 const serviceKey=(await readFile(x.serviceKeyFile,'utf8')).trim();if(serviceKey.length<32||serviceKey.length>1024||/[\p{Cc}\s]/u.test(serviceKey))throw fail();
 if(!/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}\/v1\/internal\/maintenance\/authorize$/.test(x.authorizationUrl??''))throw fail();
 const operations=await readOperationsConfiguration(x.operationsConfigurationFile);
 // This independent control journal must survive a rollback of business data.
 if([operations.directories.captures,operations.directories.restores].some(path=>x.controlDirectory===path||x.controlDirectory.startsWith(path+'/')))throw fail();
 if(x.production!==undefined&&(!x.production||Object.keys(x.production).some(k=>!['enabled'].includes(k))||x.production.enabled!==false))throw fail();
 return{...x,serviceKey,operations,production:{enabled:false}};
}
