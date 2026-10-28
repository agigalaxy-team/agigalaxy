import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {serviceFixture} from '../../../../packages/galaxy-official/test/service-fixture.mjs';
import {migrate,transaction} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {IdentityControlService} from '../../../../packages/galaxy-official/src/identity/control.mjs';
import {ProfileService} from '../../../../packages/galaxy-official/src/profiles/profile.mjs';
import {AccessService} from '../../../../packages/galaxy-official/src/security/access.mjs';
import {ConsentReader} from '../../../../packages/galaxy-official/src/consents/consent-reader.mjs';
import {profileStatementSchema} from '../../../../packages/galaxy-official/src/shared/profile-schema.mjs';
import {digest} from '../../../../packages/galaxy-official/src/shared/digest.mjs';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='profile-fixture.json')throw Error('disposable fixture required');
const db=new pg.Pool({connectionString:address.href,max:8}),clock=2000000000,endpoint='https://profiles.example.invalid',scopes=['binding','consent','history','data-export'];
try{
 if(mode==='schema'){let raw='';for await(const b of process.stdin)raw+=b;console.log(JSON.stringify({checks:JSON.parse(raw).map(x=>{const p=profileStatementSchema.safeParse(x);return p.success?{accepted:true,value:p.data}:{accepted:false}})}));}
 else if(mode==='setup'){
  const owner=await serviceFixture(scopes,db,{endpoint,now:clock}),viewer=await serviceFixture(scopes,db,{endpoint,now:clock,migrateDatabase:false}),durable=await serviceFixture(scopes,db,{endpoint,now:clock,migrateDatabase:false}),legacy=await serviceFixture(scopes,db,{endpoint,now:clock,migrateDatabase:false});await migrate(db,{roles:['api']});
  // The retained declaration below originates from a real controlled device,
  // not a SQL metadata assertion. Private signing keys never leave this process.
  const publicKey=durable.genesis.genesisProof.publicKeyPem,deviceId=randomUUID(),control=new IdentityControlService({db,endpoint,now:()=>clock,allowedScopes:scopes}),bootstrap={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:durable.actor.subjectId,expectedEpoch:0,previousEventHash:null,signerKeyId:digest(publicKey),genesisProof:durable.genesis.genesisProof,newDevice:{deviceId,publicKeyPem:publicKey,scopes:['manage-identity',...scopes]}};
  const challenge=await control.challenge(bootstrap),signature=await durable.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');await control.commit({operationId:bootstrap.operationId,controllerSignature:signature,newDeviceProof:signature});
  const c=await durable.bindings.challengeV2({subjectId:durable.actor.subjectId,genesisProof:durable.genesis.genesisProof,installationId:randomUUID(),scopes,control:{deviceId,keyId:digest(publicKey),epoch:1}}),b=await durable.bindings.bind({challenge:c.challenge,clientSession:c.clientSession,signature:await durable.signForTest(c.challenge,'galaxy-binding-response+jws')});durable.credential=randomBytes(32).toString('base64url');const session=await durable.access.challenge({bindingId:b.bindingId,credentialHash:digest(durable.credential)});await durable.access.activate({...session,signature:await durable.signForTest(session.challenge,'galaxy-session-response+jws')});durable.actor=await durable.access.authenticate(durable.credential,'history');
  const make=(expectedRevision,selfDeclared,sharing={visibility:'Public',viewers:[],expiresAt:null})=>({id:randomUUID(),expectedRevision,selfDeclared,...(sharing?{sharing}:{})});
  const grant=async(who,p)=>{const payloadJson=JSON.stringify(p),visibility=p.sharing?.visibility??'Public',intent={version:1,id:randomUUID(),subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,endpoint,objectId:p.id,action:'profile.publish',purpose:visibility==='Public'?'public-profile':'operational',recipient:endpoint,fields:Object.keys(p),visibility,viewers:p.sharing?.viewers??[],payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:clock,expiresAt:clock+3600};await who.consents.create(who.actor,await who.signForTest(JSON.stringify(intent),'galaxy-consent+jws'));return{consentId:intent.id,payloadJson}};
  const seed=make(0,{displayName:'  Original ID declaration  ',about:'  Original own statement  ',claimedCapabilities:['  Claimed only  '],projects:[{id:randomUUID(),kind:'project',title:'  Private author introduction  ',summary:'  Not a certified capability  '}]});const seedGrant=await grant(owner,seed),seedReceipt=await owner.profiles.publish(owner.actor,seedGrant);
  const privateStatement=make(1,{displayName:'Selected private ID',about:'Only the selected ID may read this'},{visibility:'Private',viewers:[viewer.actor.subjectId],expiresAt:null}),privateGrant=await grant(owner,privateStatement);
  const finite=make(2,{about:'Finite latest replacement'},{visibility:'Public',viewers:[],expiresAt:clock+120}),finiteGrant=await grant(owner,finite);
  const stale=make(0,{about:'Stale statement must not overwrite'}),staleGrant=await grant(owner,stale);
  const durableStatement=make(0,{displayName:'Retained signed device statement'}),durableGrant=await grant(durable,durableStatement);await durable.profiles.publish(durable.actor,durableGrant);
  const legacyStatement=make(0,{displayName:'Legacy finite consent statement'},null),legacyGrant=await grant(legacy,legacyStatement);await legacy.profiles.publish(legacy.actor,legacyGrant);
  const actor=who=>({subject:who.actor.subjectId,token:who.credential,binding:who.actor.bindingId});
  await writeFile(path,JSON.stringify({endpoint,clock,owner:actor(owner),viewer:actor(viewer),durable:{...actor(durable),deviceId},legacy:actor(legacy),seed,seedGrant,seedReceipt,privateStatement,privateGrant,finite,finiteGrant,staleGrant,durableGrant,legacyGrant}),{mode:0o600});console.log('{}');
 }else if(mode==='sources'){
  const f=JSON.parse(await readFile(path,'utf8')),now=()=>Number(process.argv[4]??clock),access=new AccessService({db,endpoint,now}),profiles=new ProfileService(access,new ConsentReader({now}));console.log(JSON.stringify(await transaction(db,async tx=>({durable:await profiles.readWithin(tx,null,f.durable.subject),legacy:await profiles.readWithin(tx,null,f.legacy.subject)}))));
 }else if(mode==='views'){
  const f=JSON.parse(await readFile(path,'utf8')),now=()=>Number(process.argv[4]??clock),access=new AccessService({db,endpoint,now}),profiles=new ProfileService(access,new ConsentReader({now})),viewer=await access.authenticate(f.viewer.token,'history');
  console.log(JSON.stringify(await transaction(db,async tx=>({public:await profiles.readWithin(tx,null,f.owner.subject),selected:await profiles.readWithin(tx,viewer,f.owner.subject),durable:await profiles.readWithin(tx,null,f.durable.subject),legacy:await profiles.readWithin(tx,null,f.legacy.subject)}))));
 }else throw Error('mode required');
}finally{await db.end()}
