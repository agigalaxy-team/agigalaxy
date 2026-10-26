import {spawnSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {resolve,join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2),options=new Map();
for(let i=0;i<args.length;i+=2){
 if(!['--keycloak-dir','--jdk-dir','--output'].includes(args[i])||!args[i+1]||options.has(args[i]))throw Error('Expected explicit --keycloak-dir, --jdk-dir and --output.');
 options.set(args[i],resolve(args[i+1]));
}
if(options.size!==3)throw Error('Expected explicit --keycloak-dir, --jdk-dir and --output.');
const keycloak=options.get('--keycloak-dir'),jdk=options.get('--jdk-dir'),output=options.get('--output');
await mkdir(output);
function run(executable,argumentsList){
 const result=spawnSync(executable,argumentsList,{cwd:root,stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error('Provider command failed with status '+result.status);
}
const email=join(output,'email-code'),management=join(output,'management-email-change');
run(process.execPath,[join(root,'apps/galaxy-auth/providers/email-code/build.mjs'),'--keycloak-dir',keycloak,'--jdk-dir',jdk,'--out',email,'--with-tests','true']);
const java=join(jdk,'bin','java'+(process.platform==='win32'?'.exe':''));
const classpath=[join(email,'classes'),join(email,'test-classes'),join(keycloak,'lib/lib/main/*'),join(keycloak,'lib/lib/boot/*')].join(delimiter);
for(const name of ['EmailCodeChallengeStoreTest','EmailCodeTemplateProviderTest','EmailCodeRequiredActionTest','RegistrationContinuationTest'])
 run(java,['-cp',classpath,'org.agigalaxy.keycloak.emailcode.'+name]);
run(process.execPath,[join(root,'apps/galaxy-auth/providers/management-email-change/build.mjs'),'--keycloak-dir',keycloak,'--jdk-dir',jdk,'--out',management,'--with-tests','true','--run-tests','true']);
console.log(JSON.stringify({keycloakVersion:'26.7.3',javaRelease:21,email,management,javaMainEntrypoints:5,smtp:'explicit-double'}));
