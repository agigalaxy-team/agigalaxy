// Original public discovery verifier against the isolated Go HTTP service.
import {readFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {verifyKeyring} from '../../packages/galaxy-official/src/verification/keyring.mjs';
import {verifyNetworkManifest} from '../../packages/galaxy-official/src/verification/manifest.mjs';
import {ManifestService} from '../../packages/galaxy-official/src/manifest.mjs';
import {parseNetworkProfile} from '../../packages/galaxy-official/src/network/network-profile.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
if(process.argv[2]==='validate'){
 const cases=JSON.parse(await readFile(process.env.GALAXY_GO_TEST_METADATA_CASES,'utf8'));
 console.log(JSON.stringify(cases.map(({profile,endpoint})=>{try{new ManifestService({...parseNetworkProfile(profile),endpoint,kid:'fixture',operator:'Operator',region:'test',capabilities:['binding','sessions','docs-mcp'],signer:{}});return true}catch{return false}})));
 process.exit(0);
}
const origin=new URL(process.env.GALAXY_GO_TEST_DEVICE_ORIGIN??'');
if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1')throw Error('isolated loopback HTTP required');
const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR;if(!isAbsolute(dir??''))throw Error('absolute disposable directory required');
const endpoint='https://device.example.invalid',now=2000000000;
const roots=JSON.parse(await readFile(join(dir,'root-pins.json'),'utf8'));
const rootPins=new Map(roots.keys.map(k=>[k.kid,k]));
const keysResponse=await fetch(origin.origin+'/.well-known/galaxy-signing-keys.json');
assert.equal(keysResponse.status,200);
const ring=await keysResponse.json(),verifiedKeys=await verifyKeyring(ring,{endpoint,rootPins,now});
const response=await fetch(origin.origin+'/.well-known/galaxy-network.json');assert.equal(response.status,200);
const document=await response.json(),checked=await verifyNetworkManifest(document,{endpoint,trustedKeys:verifiedKeys.keys,networkType:process.argv[2]??'official',now});
assert.equal(response.headers.get('etag'),'"'+digest(document.signed)+'"');
assert.equal(response.headers.get('cache-control'),'public, max-age=60, must-revalidate');
assert.deepEqual(await (await fetch(origin.origin+'/v1/policy')).json(),checked.data.policy);
const status=await (await fetch(origin.origin+'/v1/signing-keys/status')).json();
assert.deepEqual(status,{keys:roots.keys.map(({kid,revoked,notBefore,notAfter})=>({kid,revoked,notBefore,notAfter})),trustSource:'client-pinned-configuration',checkedAt:now});
assert.equal((await fetch(origin.origin+'/.well-known/galaxy-network.json',{headers:{'If-None-Match':response.headers.get('etag')}})).status,304);
console.log(JSON.stringify({state:checked.state,networkType:checked.data.networkType,keys:status.keys.length}));
