import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createKeycloakManagementAccounts} from "../src/identity/authentication/keycloak-management-accounts.mjs";
import {dispatchOperationsManagementAccounts} from '../src/adapters/http/operations-management-accounts-http.mjs';

// Native Keycloak and the domain service below are explicit transport doubles.
// This checks the new adapter/HTTP boundary, not a live realm or real user.
test('management realm adapter keeps writer/reader, first-password and standard service boundaries; HTTP authenticates before its closed body',{timeout:15000},async()=>{
 const issuer='https://auth.example/realms/operations',native='http://127.0.0.1:18080',sub=randomUUID(),subject={issuer,externalSubject:sub},sentinel='SYNTHETIC_SECRET_NOT_A_REAL_CREDENTIAL',
  users=new Map([[sub,{id:sub,username:'member',firstName:'真实',lastName:'来源',enabled:true,emailVerified:false,createdTimestamp:1893456000000,requiredActions:[]}]]),
  roles=new Map([[sub,['galaxy-operations-reader']]]),calls=[],gates=[],roleDefinitions=['galaxy-operations-reader','galaxy-operations-administrator'].map(name=>({id:randomUUID(),name,clientRole:false}));
 const transport=async(url,options={})=>{const u=new URL(url),method=options.method??'GET';
  if(u.pathname.endsWith('/token')){const c=new URLSearchParams(options.body).get('client_id');calls.push({kind:'token',c});return Response.json({access_token:c,expires_in:60});}
  assert.equal(u.origin,native);const selected=decodeURIComponent(u.pathname.split('/users/')[1]?.split('/')[0]??''),user=users.get(selected);
  if(method==='GET'){
   if(u.pathname.endsWith('/role-mappings/realm/available')){assert.equal(options.headers.authorization,'Bearer management-writer');return Response.json(roleDefinitions.filter(row=>!(roles.get(selected)??[]).includes(row.name)));}
   assert.equal(options.headers.authorization,'Bearer management-reader');
   if(u.pathname.endsWith('/users/count'))return Response.json(users.size);
   if(u.pathname.endsWith('/users'))return Response.json([...users.values()].slice(Number(u.searchParams.get('first')),Number(u.searchParams.get('first'))+Number(u.searchParams.get('max'))));
   if(u.pathname.includes('/roles/'))return Response.json({private:sentinel},{status:403});
   if(!user)return Response.json({private:sentinel},{status:404});
   if(u.pathname.endsWith('/role-mappings/realm/composite'))return Response.json(roleDefinitions.filter(row=>(roles.get(selected)??[]).includes(row.name)).map(row=>({...row,attributes:{private:sentinel}})));
   if(u.pathname.endsWith('/sessions'))return Response.json([{id:sentinel,token:sentinel}]);return Response.json({...user,credentials:[{secretData:sentinel}],attributes:{private:sentinel}});
  }
  assert.equal(options.headers.authorization,'Bearer management-writer');assert.equal(gates.at(-1),calls.filter(x=>x.kind==='write').length+1);
  calls.push({kind:'write',method,path:u.pathname,body:JSON.parse(options.body??'null')});
  if(method==='POST'&&u.pathname.endsWith('/users')){const input=JSON.parse(options.body),id=randomUUID();users.set(id,{id,...input,emailVerified:false,createdTimestamp:1893456000000});roles.set(id,[]);
   return new Response(null,{status:201,headers:{location:native+'/admin/realms/operations/users/'+id}});}
  if(u.pathname.endsWith('/reset-password')){assert.equal(JSON.parse(options.body).temporary,true);user.requiredActions=['UPDATE_PASSWORD'];return new Response(null,{status:204});}
  if(u.pathname.endsWith('/role-mappings/realm')){const name=JSON.parse(options.body)[0].name;roles.set(selected,method==='POST'?[...new Set([...(roles.get(selected)??[]),name])]:(roles.get(selected)??[]).filter(v=>v!==name));return new Response(null,{status:204});}
  return new Response(null,{status:204});
 };
 const directory=createKeycloakManagementAccounts({issuer,adminOrigin:native,reader:{clientId:'management-reader',clientSecret:sentinel},writer:{clientId:'management-writer',clientSecret:sentinel},fetch:transport});
 assert.equal(await directory.count(),1);const page=await directory.page({first:0,max:20});assert.equal(page.items[0].admission,'reader');assert(!JSON.stringify(page).includes(sentinel));
 await assert.rejects(directory.resetPassword(subject,sentinel),{code:'operations_authorization_unavailable'});assert.equal(calls.filter(c=>c.kind==='write').length,0);
 const authorize=async()=>gates.push(calls.filter(x=>x.kind==='write').length+1);
 const created=await directory.create({username:'new-member',firstName:'新',lastName:'成员',temporaryPassword:sentinel},{authorize});assert.equal(created.state,'confirmed');
 const createBody=calls.find(c=>c.kind==='write').body;assert.deepEqual(createBody.requiredActions,['UPDATE_PASSWORD']);assert.equal(createBody.credentials[0].temporary,true);assert(!Object.hasOwn(createBody,'email'));
 assert.equal((await directory.get(created)).admission,'none');await directory.admission(created,'reader',{authorize});assert.equal((await directory.get(created)).admission,'reader');
 await directory.admission(created,'administrator',{authorize});assert.equal((await directory.get(created)).admission,'administrator');
 await directory.admission(created,'reader',{authorize});assert.equal((await directory.get(created)).admission,'reader');
 await directory.resetPassword(subject,sentinel,{authorize});assert.deepEqual((await directory.get(subject)).requiredActions,['UPDATE_PASSWORD']);assert.equal((await directory.sessions(subject)).activeCount,1);
 assert.equal(await directory.emailChangeAvailability(),false);await assert.rejects(directory.requestEmailChange(subject,'new@example.invalid',{authorize}),{code:'management_email_verification_not_configured'});
 assert.throws(()=>createKeycloakManagementAccounts({issuer,reader:{clientId:'same',clientSecret:sentinel},writer:{clientId:'same',clientSecret:sentinel}}));
 const readerOnly=createKeycloakManagementAccounts({issuer,adminOrigin:native,reader:{clientId:'management-reader',clientSecret:sentinel},fetch:transport});
 await assert.rejects(readerOnly.create({username:'blocked'},{authorize}),{code:'management_writer_not_configured'});
 const root='/v1/operations/management-accounts',target='a'.repeat(64),op=randomUUID(),observed=[];
 const domain=new Proxy({},{get:(_,method)=>async(...args)=>{observed.push({method,args});return {metadataOnly:true};}});
 const request=(method,value)=>Object.assign(Readable.from(value===undefined?[]:[Buffer.from(JSON.stringify(value))]),{method,headers:{'content-type':'application/json'}});
 const dispatch=(path,method='GET',value,auth=async(_r,options)=>{observed.push({auth:options});return {kind:'business-operator'};})=>dispatchOperationsManagementAccounts({managementAccounts:domain,authorizeOperator:auth,
  request:request(method,value),requestId:randomUUID(),url:new URL(path,'https://api.example'),send:(status,result)=>observed.push({status,result})});
 await dispatch(root+'?page=2&pageSize=50&enabled=false');assert.equal(observed.find(v=>v.method)?.method,'list');assert.equal(observed.find(v=>v.method).args[1].page,2);
 await dispatch(root+'/'+target+'/assignments/operations/'+op);assert.equal(observed.filter(v=>v.method).at(-1).method,'assignmentOperation');
 for(const path of [root+'?page=1&page=2',root+'?arbitrary=sql',root+'/'+target+'?view=private',root+'/operations/'+op+'?anything=1'])await assert.rejects(dispatch(path),error=>[400,404].includes(error.status));
 const before=observed.filter(v=>v.method).length;let deniedReads=0;const denied=Object.assign(Readable.from((async function*(){deniedReads++;yield '{bad';})()),{method:'POST',headers:{'content-type':'application/json'}});
 await assert.rejects(dispatchOperationsManagementAccounts({managementAccounts:domain,authorizeOperator:async()=>{throw Object.assign(Error('closed'),{code:'csrf_denied'});},request:denied,
  requestId:randomUUID(),url:new URL(root,'https://api.example'),send:()=>{}}),{code:'csrf_denied'});assert.equal(deniedReads,0);assert.equal(observed.filter(v=>v.method).length,before);
 await dispatch(root+'/'+target+'/commands','POST',{operationId:op,kind:'sessions-revoke',expectedVersion:'b'.repeat(64)});
 assert.equal(observed.filter(v=>v.method).at(-1).method,'command');assert.equal(observed.filter(v=>v.auth).at(-1).auth.write,true);
});
