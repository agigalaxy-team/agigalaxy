// Original community-account/identity readers for a fresh loopback test cluster.
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {CompactSign,compactVerify,importSPKI} from '../../packages/galaxy-official/node_modules/jose/dist/webapi/index.js';
import {AccessService} from '../../packages/galaxy-official/src/security/access.mjs';
import {CommunityAccountRegistry,communityAccountView} from '../../packages/galaxy-official/src/accounts/community-accounts.mjs';
import {IdentityLinkService} from '../../packages/galaxy-official/src/identity/links.mjs';
import {controllerMappingLockKeys} from '../../packages/galaxy-official/src/identity/controller-mapping-lock.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.protocol!=='postgres:'||address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR;if(!isAbsolute(dir??''))throw Error('disposable device directory required');
const db=new pg.Pool({connectionString:address.href,max:3}),endpoint='https://device.example.invalid',now=()=>2000000000;
try{
 const action=process.argv[2],state=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8'));
 if(action==='sign'){
  const payload=await readFile(join(dir,'link-payload.txt'),'utf8');const signed=await new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({alg:'Ed25519',typ:'galaxy-identity-link+jws'}).sign(createPrivateKey(state.ownerPrivate));await writeFile(join(dir,'signed-link.txt'),signed,{mode:0o600});console.log('{"written":true}');
 }else if(action==='keys')console.log(JSON.stringify(controllerMappingLockKeys(endpoint,JSON.parse(process.argv[3]))));
 else{
  const descriptions=JSON.parse(process.env.GALAXY_GO_TEST_LINK_PROVIDERS??'[]'),providers=descriptions.map(d=>({describe:()=>d}));
  const access=new AccessService({db,endpoint,now}),token=await readFile(join(dir,'credential.txt'),'utf8'),actor=await access.authenticate(token,'binding'),registry=new CommunityAccountRegistry(access,providers);
  if(action==='available')console.log(JSON.stringify(await access.runAuthorized(actor,'binding',async tx=>(await registry.availableWithin(tx,actor)).map(row=>communityAccountView(row)))));
  else if(action==='query')console.log(JSON.stringify(await new IdentityLinkService(access,providers,{accountRegistry:registry}).query(actor,{})));
  else if(action==='verify'){
   const row=(await db.query('SELECT * FROM external_identity_links WHERE id=$1',[process.argv[3]])).rows[0],verified=await compactVerify(row.signature,await importSPKI(state.publicKeyPem,'Ed25519'),{algorithms:['Ed25519']});
   console.log(JSON.stringify({exactPayload:Buffer.from(verified.payload).toString('utf8')===row.payload_text,exactHash:digest(row.payload_text)===row.payload_hash,header:verified.protectedHeader,signer:row.signer_key_id===digest(state.publicKeyPem),epoch:Number(row.control_epoch)}));
  }else throw Error('fixture action required');
 }
}finally{await db.end();}
