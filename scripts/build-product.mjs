import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {existsSync,readdirSync} from 'node:fs';
import {packWebsiteRuntime} from './website-artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),siteOnly=args.includes('--site-only');
const forwarded=args.filter(arg=>!['--site-only','--web-only'].includes(arg));
const option=name=>{const at=forwarded.indexOf(name);if(at<0)return null;const value=forwarded[at+1];if(!value||value.startsWith('--'))throw Error('Missing '+name);forwarded.splice(at,2);return path.resolve(root,value);};
const artifact=option('--web-output'),previousRuntime=option('--previous-runtime');
if(previousRuntime&&!artifact)throw Error('--previous-runtime requires --web-output');
if(forwarded.includes('--web-dist'))throw Error('The dynamic website consumes shared source; --web-dist is retired.');
const index=forwarded.indexOf('--output');
const content=index<0?path.join(root,'apps/galaxy-site/dist'):path.resolve(root,forwarded[index+1]);
if(artifact){if(artifact===root||root.startsWith(artifact+path.sep)||artifact===content||content.startsWith(artifact+path.sep))throw Error('Choose a separate runtime artifact directory.');if(existsSync(artifact)&&readdirSync(artifact).length)throw Error('Runtime artifact directory must be empty.');}
const candidates=process.platform==='win32'?[['py','-3'],['python']]:[['python3'],['python']];
const python=candidates.find(([cmd,...flags])=>spawnSync(cmd,[...flags,'--version'],{stdio:'ignore',windowsHide:true}).status===0);
if(!python)throw Error('Public data preparation requires Python 3.11+.');
function run(command,argv,cwd=root,env=process.env){const result=spawnSync(command,argv,{cwd,env,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
run(python[0],[...python.slice(1),'-X','utf8','apps/galaxy-site/build.py','--runtime-data','--node',process.execPath,...forwarded]);
if(!siteOnly){
 run(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'build'],path.join(root,'apps/galaxy-site'),{...process.env,GALAXY_SITE_BASELINE_ROOT:content});
 if(artifact)await packWebsiteRuntime({root,artifact,content,previousRuntime});
}
