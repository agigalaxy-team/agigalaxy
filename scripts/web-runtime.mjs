import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {cp,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mode=process.argv[2]??'dev';if(!['dev','start'].includes(mode))throw Error('Expected dev or start');
const port=Number(process.env.GALAXY_PREVIEW_PORT??5179);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid website port');
const app=path.join(root,'apps/galaxy-site'),standalone=path.join(app,'.next/standalone/apps/galaxy-site');
if(mode==='start'){
 if(!existsSync(path.join(standalone,'server.js')))throw Error('Build the website before starting it');
 await mkdir(path.join(standalone,'.next'),{recursive:true});
 await cp(path.join(app,'.next/static'),path.join(standalone,'.next/static'),{recursive:true});
 if(existsSync(path.join(app,'public')))await cp(path.join(app,'public'),path.join(standalone,'public'),{recursive:true});
}
const command=mode==='start'?[path.join(standalone,'server.js')]:[path.join(root,'node_modules/next/dist/bin/next'),'dev','--hostname',process.env.GALAXY_SITE_HOST??'127.0.0.1','--port',String(port)];
const child=spawn(process.execPath,command,{cwd:app,env:{...process.env,PORT:String(port),HOSTNAME:process.env.GALAXY_SITE_HOST??'127.0.0.1',GALAXY_SITE_BASELINE_ROOT:process.env.GALAXY_SITE_BASELINE_ROOT??path.join(app,'dist')},stdio:'inherit',windowsHide:true});
child.on('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
