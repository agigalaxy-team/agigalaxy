import {mkdir,access} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildGoNativeCandidate} from './build-native-v2.mjs';
import {generateNativeLicenseNotices} from './native-license-notices.mjs';
import {verifyNativeCandidate} from './verify-native-v2-candidate.mjs';
import {prepareNativeClientRelease} from './native-client-release.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
async function npmCli(supplied){const paths=[supplied,join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')].filter(Boolean);for(const path of paths){if(!isAbsolute(path))continue;try{await access(path);return path;}catch{}}throw Error('An installed absolute npm-cli.js path is required');}
// Build one actual Go candidate, install the pinned Node host adapter graph
// offline, collect its notices and package the same inspected bytes. This does
// not install a user host, sign, publish, or establish platform acceptance.
export async function prepareClientCandidate({destination,sourceDirectory=root,npm,goExecutable=process.env.GALAXY_BUILD_GO??'go',tarExecutable='tar',version}={}){
 if(!destination){const outputs=join(root,'outputs');await mkdir(outputs,{recursive:true});destination=join(outputs,'native-go-candidate-'+randomUUID());}
 if(!isAbsolute(destination)||!isAbsolute(sourceDirectory))throw Error('Absolute new output and source paths required');
 await mkdir(destination);const candidate=join(destination,'candidate');
 const built=await buildGoNativeCandidate({destination:candidate,sourceDirectory,goExecutable,...(version?{version}:{})});
 const cli=await npmCli(npm??process.env.GALAXY_TEST_NPM_CLI),env={...process.env};
 for(const key of Object.keys(env))if(key.toLowerCase().startsWith('npm_config_'))delete env[key];
 const npmArgs=['--offline','--ignore-scripts','--no-audit','--no-fund','--bin-links=false'];
 for(const command of [['install','--package-lock-only'],['ci']])await run(process.execPath,[cli,...command,...npmArgs],{cwd:candidate,env,windowsHide:true,maxBuffer:16*1024*1024});
 const licenses=await generateNativeLicenseNotices({candidate});
 const installation=await verifyNativeCandidate(candidate,{sourceDirectory});
 const release=await prepareNativeClientRelease({source:candidate,destination:join(destination,'release'),sourceDirectory,tarExecutable});
 return{destination,candidate,release:release.destination,package:release.package,installation,licenses:{components:licenses.components},target:built.manifest.target,hostAcceptance:'pending',publicationReady:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length>1||(args[0]&&!isAbsolute(args[0])))throw Error('Usage: node scripts/prepare-client-candidate.mjs [ABSOLUTE_NEW_OUTPUT]');
 console.log(JSON.stringify(await prepareClientCandidate({destination:args[0]})));
}
