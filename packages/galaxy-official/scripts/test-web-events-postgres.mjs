import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';

const bin=process.env.GALAXY_TEST_PG_BIN;
if(!bin)throw new Error('GALAXY_TEST_PG_BIN required; no external database accepted');
const executable=name=>join(resolve(bin),name+(process.platform==='win32'?'.exe':''));
await access(executable('initdb'));
const prefix=join(resolve(tmpdir()),'galaxy-web-event-test-');
const root=await mkdtemp(prefix),data=join(root,'data'),pwfile=join(root,'password');
if(!resolve(root).startsWith(prefix))throw new Error('Unsafe test cleanup target');
const password=randomBytes(32).toString('hex');await writeFile(pwfile,password,{mode:0o600});
const socket=createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const command=(name,args)=>{const result=spawnSync(executable(name),args,{stdio:name==='initdb'?['ignore','pipe','pipe']:'ignore',encoding:'utf8',windowsHide:true,timeout:60000});if(result.status!==0)throw new Error(`${name} failed (exit ${result.status})${name==='initdb'?': '+result.stderr:''}`);};
let attempted=false,failure;
try{
 command('initdb',['-D',data,'-U','galaxy_test','--auth=scram-sha-256','--pwfile',pwfile,'--encoding=UTF8','--locale=C']);await rm(pwfile);
 attempted=true;command('pg_ctl',['-D',data,'-l',join(root,'server.log'),'-w','start','-o',`-h 127.0.0.1 -p ${port}`]);
 const env={...process.env,PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:'galaxy_test',PGPASSWORD:password,PGDATABASE:'postgres',GALAXY_TEST_PG_ISOLATED:'1'};
 delete env.NODE_TEST_CONTEXT;
 const files=process.argv.includes('--http-only')?['test/postgres/web-events-http.test.mjs']:process.argv.includes('--session-events-only')?['test/postgres/web-session-events.test.mjs']:process.argv.includes('--consumers-only')?['test/postgres/web-event-consumers.test.mjs']:['test/postgres/web-events.test.mjs',...process.argv.includes('--events-only')?[]:['test/portal-sessions.test.mjs']];
 const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,stdio:'inherit',windowsHide:true,timeout:180000});
 if(result.status!==0)throw new Error(`Isolated event/session tests failed (${result.status})`);
}catch(error){failure=error;}
try{
 if(attempted){const status=spawnSync(executable('pg_ctl'),['-D',data,'status'],{stdio:'ignore',windowsHide:true,timeout:10000});
  if(status.status===0)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);else if(status.status!==3)throw new Error('Cluster status unknown; preserving fixture');}
 await rm(root,{recursive:true,force:true});
}catch(error){if(failure)throw new AggregateError([failure,error],'Isolated test failed and cleanup could not complete');throw error;}
if(failure)throw failure;
