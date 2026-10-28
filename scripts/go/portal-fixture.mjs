// Cross-language ciphertext fixture, using only random temporary test material.
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PortalSessions} from '../../packages/galaxy-official/src/identity/authentication/portal-session.mjs';
const directory=resolve(process.argv[2]);
if(!directory.startsWith(resolve(tmpdir())+'\\')&&!directory.startsWith(resolve(tmpdir())+'/'))throw Error('fixture_requires_os_temporary_directory');
await mkdir(directory,{recursive:true});
const keyPath=join(directory,'portal-key'),hash='b'.repeat(64),scope=['a'.repeat(64)],token='temporary-fixture-refresh-token';
if(process.argv[3]==='create')await writeFile(keyPath,randomBytes(32).toString('base64url'),{flag:'wx',mode:0o600});
const key=Buffer.from((await readFile(keyPath,'utf8')).trim(),'base64url');
const portal=new PortalSessions({db:null,kind:'account',scope,policy:{key},provider:null});
if(process.argv[3]==='create')console.log(JSON.stringify({keyPath,hash,scope,token,cipher:portal.crypt(token,hash)}));
else if(process.argv[3]==='decrypt')console.log(JSON.stringify({token:portal.decrypt(await readFile(join(directory,'go-cipher'),'utf8'),hash)}));
else throw Error('fixture command required');
