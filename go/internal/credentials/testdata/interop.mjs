// Original-service signed fixtures. Only a disposable loopback test database
// and an explicitly named OS temporary artifact are accepted; no real issuer.
import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {generateKeyPair,exportJWK,SignJWT} from '../../../../packages/galaxy-official/node_modules/jose/dist/webapi/index.js';
import {migrate,transaction} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../../../../packages/galaxy-official/src/accounts/uid.mjs';
import {createExternalCredentialsService} from '../../../../packages/galaxy-official/src/identity/authentication/external-credentials.mjs';
import {createExternalCredentialVerifier} from '../../../../packages/galaxy-official/src/identity/authentication/external-credentials-verifier.mjs';
import {validateExternalCredentialsConfiguration} from '../../../../packages/galaxy-official/src/identity/authentication/external-credentials-config.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(url.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(url.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='credential-fixture.json')throw Error('explicit disposable fixture file required');
const db=new pg.Pool({connectionString:url.href}),endpoint='https://credentials.example.invalid',issuer='https://credential-source.example.invalid',accountIssuer='https://login.example.invalid',clock=2000000000;
try{
 if(mode==='setup'){
  await migrate(db,{roles:['api']});const account=await transaction(db,async tx=>{const a=await upsertOfficialAccountWithin(tx,{endpoint,issuer:accountIssuer,externalSubject:'external-main',verificationMethod:'email',verifiedAt:clock});await ensureOfficialAccountProfileWithin(tx,a.id,{subjectType:'person',now:clock});return a});
  const pairs={},keys=[];for(const alg of ['EdDSA','RS256','PS256','ES256','ES384']){const pair=await generateKeyPair(alg,{extractable:true});pairs[alg]=pair;keys.push({...await exportJWK(pair.publicKey),kid:'fixture-'+alg,use:'sig'});}
  const configuration=validateExternalCredentialsConfiguration({version:1,issuers:[{id:'source',name:'Controlled external issuer',issuer,keys,algorithms:['EdDSA','Ed25519','RS256','PS256','ES256','ES384'],formats:['vc-jwt-1.1','vc+jwt-2.0'],subjectBinding:{kind:'verified-external-account',accountIssuer},revocation:{kind:'signed-list',url:issuer+'/status',maxAgeSeconds:300},conditions:[{id:'publish',label:'Controlled source condition',type:'SyntheticQualification',claim:{path:'/credentialSubject/canPublish',equals:true}}]}]});
  const uri=endpoint+'/v1/account/public/'+account.id;
  async function token({alg='EdDSA',id='urn:controlled:owned',subject=uri,expires=clock+3600,direct=false,audience,extraHeader={},extraPayload={}}={}){const vc={'@context':[direct?'https://www.w3.org/ns/credentials/v2':'https://www.w3.org/2018/credentials/v1'],type:['VerifiableCredential','SyntheticQualification'],credentialSubject:{id:subject,canPublish:true,privateStatement:'Controlled private issuer claim excluded from public output'}};const payload=direct?{...vc,issuer}: {vc};const pair=alg==='Ed25519'?pairs.EdDSA:pairs[alg];const jwt=new SignJWT({...payload,iss:issuer,sub:subject,jti:id,iat:clock-10,nbf:clock-10,exp:expires,...extraPayload}).setProtectedHeader({alg,kid:'fixture-'+(alg==='Ed25519'?'EdDSA':alg),typ:direct?'vc+jwt':'JWT',...extraHeader});if(audience!==undefined)jwt.setAudience(audience);return jwt.sign(pair.privateKey);}
  const tokens={owned:await token(),expired:await token({id:'urn:controlled:expired',expires:clock-1}),foreign:await token({id:'urn:controlled:foreign',subject:'urn:another-holder'}),otherAccount:await token({id:'urn:controlled:other-account',subject:endpoint+'/v1/account/public/11111111-1111-4111-8111-111111111111'}),external:await token({id:'urn:controlled:external',subject:'external-main'}),vc2:await token({id:'urn:controlled:vc2',direct:true}),ed25519:await token({id:'urn:controlled:ed25519',alg:'Ed25519'}),rsa:await token({id:'urn:controlled:rsa',alg:'RS256'}),pss:await token({id:'urn:controlled:pss',alg:'PS256'}),es256:await token({id:'urn:controlled:es256',alg:'ES256'}),es384:await token({id:'urn:controlled:es384',alg:'ES384'}),badAudience:await token({audience:'https://wrong-audience.example.invalid'}),inlineKeyServer:await token({extraHeader:{jku:'https://submitted-key-server.example.invalid'}}),badNumericDate:await token({extraPayload:{nbf:null}})};
  const tampered=tokens.owned.split('.');tampered[1]=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(tampered[1],'base64url')),sub:'urn:tampered'})).toString('base64url');tokens.tampered=tampered.join('.');
  async function status(at,revoked=[]){return new SignJWT({purpose:'revocation',complete:true,revoked}).setIssuer(issuer).setIssuedAt(at-1).setExpirationTime(at+240).setProtectedHeader({alg:'EdDSA',kid:'fixture-EdDSA',typ:'credential-status+jwt'}).sign(pairs.EdDSA.privateKey);}
  const documents={current:{jwt:await status(clock)},revoked:{jwt:await status(clock+301,['urn:controlled:owned'])}},verifier=createExternalCredentialVerifier({configuration,endpoint,now:()=>clock,fetchStatus:async()=>documents.current}),checks={};for(const[name,raw]of Object.entries(tokens)){try{checks[name]={metadata:await verifier.verify(raw)}}catch(e){checks[name]={error:e.code}}}
  const service=createExternalCredentialsService({db,endpoint,configuration,now:()=>clock,fetchStatus:async()=>documents.current}),actor={kind:'official-account',endpoint,accountId:account.id},owned=await service.importCredential(actor,{credential:tokens.owned});
  // Only public keys, synthetic signed materials and public test proofs are
  // persisted; private signing keys remain inside this short-lived process.
  await writeFile(path,JSON.stringify({endpoint,configuration,account,ownedID:owned.id,tokens,documents,checks}),{mode:0o600});console.log(JSON.stringify({accountId:account.id,ownedID:owned.id,owned}));
 }else if(mode==='owner-read'){
  const f=JSON.parse(await readFile(path,'utf8')),service=createExternalCredentialsService({db,endpoint,configuration:f.configuration,now:()=>clock,fetchStatus:async()=>f.documents.current}),actor={kind:'official-account',endpoint,accountId:f.account.id};console.log(JSON.stringify({list:await service.list(actor,{})}));
 }else if(mode==='read'){
  const f=JSON.parse(await readFile(path,'utf8')),at=Number(process.argv[4]??clock),service=createExternalCredentialsService({db,endpoint,configuration:f.configuration,now:()=>at,fetchStatus:async()=>at>clock?f.documents.revoked:f.documents.current}),actor={kind:'official-account',endpoint,accountId:f.account.id};console.log(JSON.stringify({owned:await service.get(actor,f.ownedID),public:await service.publicForAccount(f.account.id,{limit:50}),list:await service.list(actor,{})}));
 }else throw Error('fixture mode required');
}finally{await db.end();}
