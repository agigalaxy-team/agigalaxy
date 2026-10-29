import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyNativeCandidate} from './verify-native-v2-candidate.mjs';
// Check a prepared candidate without touching the user's installed host.
export async function testClientInstall(candidate){return verifyNativeCandidate(candidate);}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length>3||(process.argv[2]&&!isAbsolute(process.argv[2])))throw Error('Usage: node scripts/test-client-install.mjs [ABSOLUTE_PREPARED_CANDIDATE]');
 if(process.argv[2])console.log(JSON.stringify(await testClientInstall(process.argv[2])));
 else {const {prepareClientCandidate}=await import('./prepare-client-candidate.mjs');console.log(JSON.stringify(await prepareClientCandidate()));}
}
