// Independent JavaScript signature check for disposable Go identity-link fixtures.
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {CompactSign,compactVerify,importSPKI} from 'jose';
import {digest} from '../../packages/galaxy-contracts/src/digest.mjs';
const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR;if(!isAbsolute(dir??''))throw Error('disposable device directory required');
const action=process.argv[2],state=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8'));
if(action==='sign'){
 const payload=await readFile(join(dir,'link-payload.txt'),'utf8');const signed=await new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({alg:'Ed25519',typ:'galaxy-identity-link+jws'}).sign(createPrivateKey(state.ownerPrivate));await writeFile(join(dir,'signed-link.txt'),signed,{mode:0o600});console.log('{"written":true}');
}else if(action==='verify'){
 const row=JSON.parse(await readFile(join(dir,'link-stored.json'),'utf8')),verified=await compactVerify(row.signature,await importSPKI(state.publicKeyPem,'Ed25519'),{algorithms:['Ed25519']});
 console.log(JSON.stringify({exactPayload:Buffer.from(verified.payload).toString('utf8')===row.payload_text,exactHash:digest(row.payload_text)===row.payload_hash,header:verified.protectedHeader,signer:row.signer_key_id===digest(state.publicKeyPem),epoch:row.control_epoch}));
}else throw Error('unsupported action');
