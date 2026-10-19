import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT,CompactSign} from 'jose';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {createExternalCredentialsService} from '../src/external-credentials.mjs';
import {createExternalCredentialVerifier} from '../src/external-credentials-verifier.mjs';
import {validateExternalCredentialsConfiguration} from '../src/external-credentials-config.mjs';

async function fixture() {
  const {privateKey,publicKey}=await generateKeyPair('EdDSA',{extractable:true});
  const publicJwk={...await exportJWK(publicKey),kid:'fixture-issuer-key',alg:'EdDSA',use:'sig'};
  const endpoint='https://official.example.org',issuer='https://issuer.example.org',statusUrl=issuer+'/status';
  let clock=2000000000,revoked=[],statusAvailable=true,fetches=0;
  const configuration=validateExternalCredentialsConfiguration({version:1,issuers:[{id:'fixture-issuer',name:'Synthetic test issuer',issuer,keys:[publicJwk],
    revocation:{kind:'signed-list',url:statusUrl,maxAgeSeconds:300},conditions:[{id:'fixture-qualification',label:'Synthetic exact condition',type:'FixtureQualification',claim:{path:'/credentialSubject/qualification',equals:'fixture-active'}}]}]});
  const sign=async({subjectId,id='urn:fixture:'+randomUUID(),expires=clock+3600,claim='fixture-active',extra={}}={})=>new SignJWT({vc:{'@context':['https://www.w3.org/2018/credentials/v1'],
    type:['VerifiableCredential','FixtureQualification'],credentialSubject:{qualification:claim},...extra}})
    .setProtectedHeader({alg:'EdDSA',kid:publicJwk.kid,typ:'JWT'}).setIssuer(issuer).setSubject(subjectId).setJti(id).setIssuedAt(clock-10).setNotBefore(clock-10).setExpirationTime(expires).sign(privateKey);
  const fetchStatus=async url=>{fetches++;assert.equal(url,statusUrl);if(!statusAvailable)throw Error('fixture offline');
    return {jwt:await new SignJWT({purpose:'revocation',complete:true,revoked}).setIssuer(issuer).setIssuedAt(clock-1).setExpirationTime(clock+240)
      .setProtectedHeader({alg:'EdDSA',kid:publicJwk.kid,typ:'credential-status+jwt'}).sign(privateKey)};};
  return {privateKey,publicJwk,endpoint,issuer,statusUrl,configuration,sign,fetchStatus,now:()=>clock,
    setClock:value=>{clock=value;},setRevoked:value=>{revoked=value;},setAvailable:value=>{statusAvailable=value;},fetches:()=>fetches};
}

test('the supported VC profiles verify issuer signatures while dates, arbitrary URLs and OIDC tokens stay distinct',async()=>{
  const f=await fixture(),verify=createExternalCredentialVerifier({...f}),subjectId=f.endpoint+'/v1/account/public/'+randomUUID();
  const jwt=await f.sign({subjectId}),legacy=await verify.verify(jwt);
  assert.equal(legacy.format,'vc-jwt-1.1');assert.equal(legacy.subjectId,subjectId);assert.equal(verify.validity(legacy),'valid');
  const expired=await verify.verify(await f.sign({subjectId,expires:f.now()-1}));assert.equal(verify.validity(expired),'expired','expiry is not mislabeled a bad signature');
  const vc={'@context':['https://www.w3.org/ns/credentials/v2'],id:'urn:fixture:direct',issuer:f.issuer,type:['VerifiableCredential','FixtureQualification'],
    validFrom:new Date((f.now()-10)*1000).toISOString(),validUntil:new Date((f.now()+1000)*1000).toISOString(),credentialSubject:{id:subjectId,qualification:'fixture-active'}};
  const direct=await new CompactSign(Buffer.from(JSON.stringify(vc))).setProtectedHeader({alg:'EdDSA',kid:f.publicJwk.kid,typ:'vc+jwt'}).sign(f.privateKey);
  assert.equal((await verify.verify(direct)).format,'vc+jwt-2.0');
  const oidc=await new SignJWT({email:'synthetic@example.org'}).setIssuer(f.issuer).setSubject(subjectId).setProtectedHeader({alg:'EdDSA',kid:f.publicJwk.kid,typ:'JWT'}).sign(f.privateKey);
  await assert.rejects(verify.verify(oidc),{code:'external_credential_format_unsupported'});
  const parts=jwt.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  await assert.rejects(verify.verify(parts.join('.')),{code:'external_credential_signature_invalid'});
  const unsupported=await verify.verify(await f.sign({subjectId,extra:{credentialStatus:{id:'https://untrusted.example/never-fetch',type:'UnknownStatus'}}}));
  assert.equal((await verify.revocation(unsupported)).state,'unknown');assert.equal(f.fetches(),0,'a submitted status URL never selects a fetch target');
  const privateJwk=await exportJWK(f.privateKey);
  assert.throws(()=>validateExternalCredentialsConfiguration({version:1,issuers:[{id:'bad',name:'Bad',issuer:f.issuer,keys:[{...privateJwk,kid:'private'}]}]}));
});

test('an account without a Galaxy identity imports private source material and only exact current conditions can grant access',{timeout:60000},async t=>{
  const f=await fixture(),db=new PGlite();t.after(()=>db.close());await migrate(db);
  const ids=[randomUUID(),randomUUID()],actors=ids.map(accountId=>({kind:'official-account',accountId,endpoint:f.endpoint}));
  for(const id of ids)await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    VALUES($1::uuid,$2,'https://login.example.org',$3::text,'external-account',$4,$4)`,[id,f.endpoint,id,new Date(f.now()*1000).toISOString()]);
  const service=createExternalCredentialsService({...f,db}),condition={accountId:ids[0],issuerId:'fixture-issuer',conditionId:'fixture-qualification'};
  const credentialId='urn:fixture:owned',token=await f.sign({subjectId:f.endpoint+'/v1/account/public/'+ids[0],id:credentialId});
  const imported=await service.importCredential(actors[0],{credential:token});
  assert.equal(imported.signature.state,'valid');assert.equal(imported.subject.binding,'bound');assert.equal(imported.revocation.state,'not-revoked');
  assert.equal(imported.galaxyIssued,false);assert.equal(imported.eligibility.usable,true);
  assert.equal((await service.importCredential(actors[0],{credential:token})).id,imported.id,'an exact retry does not duplicate a credential');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM subjects')).rows[0].count,0,'no local ID is created or required');
  assert.equal(await service.hasConditionWithin(db,condition),true);
  const fetches=f.fetches();assert.equal(await service.hasConditionWithin(db,condition),true);assert.equal(f.fetches(),fetches,'protected reads use the current signed snapshot without network');
  await assert.rejects(service.get(actors[1],imported.id),{code:'not_found'});
  assert.equal((await service.list(actors[1])).items.length,0);
  const wrong=await service.importCredential(actors[1],{credential:token});assert.equal(wrong.subject.binding,'mismatch');assert.equal(wrong.eligibility.usable,false);
  const unconfirmed=await service.importCredential(actors[0],{credential:await f.sign({subjectId:'urn:unproven-holder'})});
  assert.equal(unconfirmed.subject.binding,'unconfirmed');assert.equal(unconfirmed.eligibility.usable,false,'holding a signed document is not proof of the current account subject');
  const expired=await service.importCredential(actors[0],{credential:await f.sign({subjectId:f.endpoint+'/v1/account/public/'+ids[0],expires:f.now()-1})});
  assert.equal(expired.validity.state,'expired');assert.equal(expired.eligibility.usable,false);
  f.setClock(f.now()+301);assert.equal(await service.hasConditionWithin(db,condition),false,'an expired revocation snapshot cannot grant access');
  f.setRevoked([credentialId]);const revoked=await service.recheck(actors[0],imported.id);
  assert.equal(revoked.revocation.state,'revoked');assert.equal(await service.hasConditionWithin(db,condition),false);
  await service.withdraw(actors[0],imported.id);const detail=await service.get(actors[0],imported.id);
  assert.equal(detail.credential.withdrawnAt!==null,true);assert.equal(detail.issuerClaims,null);assert.equal(detail.rawMaterialReturned,false);
  const stored=(await db.query('SELECT credential_jws,metadata FROM account_external_credentials_v1 WHERE id=$1',[imported.id])).rows[0];
  assert.equal(stored.credential_jws,null);assert.equal(Object.hasOwn(stored.metadata,'vc'),false);
  const empty=createExternalCredentialsService({db,endpoint:f.endpoint,now:f.now});assert.equal(empty.capabilities().available,false);
  assert.deepEqual(empty.supportedConditions(),[]);assert.equal(await empty.hasConditionWithin(db,condition),false);
  await assert.rejects(empty.importCredential(actors[0],{credential:token}),{code:'external_credentials_unavailable'});
});
