import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {loadOperationsConfiguration,loadOperationsWorkerAuthorization,loadOperationsAccountDirectory} from '../src/operations-config.mjs';

test('management email bridge uses only the protected management writer; workers do not load it',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-management-loader-'));
  t.after(async()=>{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));await rm(directory,{recursive:true,force:true});});
  const issuer='https://management.example.invalid/realms/galaxy-operations',endpoint='https://official.example.invalid';
  const externalSubject='synthetic-root',operatorId=createHash('sha256').update(issuer+'\0'+externalSubject).digest('hex');
  const write=async(name,value)=>{const path=join(directory,name);await writeFile(path,JSON.stringify(value),{mode:0o600});return path;};
  const rootOperatorFile=await write('root.json',{version:1,issuer,endpoint,externalSubject,operatorId});
  const directoryCredentialFile=await write('reader.json',{version:1,clientId:'management-reader',clientSecret:'synthetic-reader'});
  const businessCredentialFile=await write('business.json',{version:1,clientId:'business-reader',clientSecret:'synthetic-business'});
  const writerCredentialFile=await write('writer.json',{version:1,clientId:'galaxy-management-account-maintenance',clientSecret:'synthetic-writer'});
  let enabled=false;const requests=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    requests.push({path:req.url,method:req.method,body,authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    if(req.url==='/realms/galaxy-operations/protocol/openid-connect/token'){
      const values=new URLSearchParams(body);assert.equal(values.get('client_id'),'galaxy-management-account-maintenance');
      assert.equal(values.get('client_secret'),'synthetic-writer');
      res.end(JSON.stringify({access_token:'synthetic-access',expires_in:60}));
    }else if(req.url==='/realms/galaxy-operations/galaxy-management/email-change-capabilities'){
      assert.equal(req.headers.authorization,'Bearer synthetic-access');
      res.end(JSON.stringify({version:1,available:enabled,mode:'native-update-email',verificationBeforeChange:true,metadataOnly:true}));
    }else if(req.url==='/realms/galaxy-operations/galaxy-management/users/synthetic-member/email-change'){
      assert.equal(req.headers.authorization,'Bearer synthetic-access');res.statusCode=202;
      res.end(JSON.stringify({version:1,state:'submitted',code:null,operationId:JSON.parse(body).operationId,expiresAt:Math.floor(Date.now()/1000)+600,metadataOnly:true}));
    }else{res.statusCode=404;res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={version:1,adminOrigin:'https://admin.example.invalid',clientId:'management-browser',issuer,
    directoryOrigin:'http://127.0.0.1:'+server.address().port,directoryCredentialFile,rootOperatorFile,
    accountDirectory:{issuer:'https://community.example.invalid/realms/community',credentialFile:businessCredentialFile},
    managementAccounts:{writerCredentialFile},roles:{administrator:'administrator',reader:'reader'}};
  const path=await write('operations.json',config),db={query(){throw Error('Unexpected database access during construction.');}};
  const factory=async options=>({describe:()=>({issuer:options.issuer,clientId:options.clientId,redirectUri:options.redirectUri})});
  const loaded=await loadOperationsConfiguration(path,{db,endpoint,factory});
  assert.equal(requests.length,0,'construction never tests credentials or sends a message');
  assert.equal(await loaded.managementDirectory.emailChangeAvailability(),false);
  enabled=true;assert.equal(await loaded.managementDirectory.emailChangeAvailability(),true);
  let authorized=0;
  const operationId='11111111-1111-4111-8111-111111111111';
  const result=await loaded.managementDirectory.requestEmailChange({issuer,externalSubject:'synthetic-member'},'new@example.invalid',{
    operationId,authorize:async()=>{authorized++;}});
  assert.deepEqual(result,{state:'submitted',code:null});assert.equal(authorized,1);
  const submitted=requests.filter(row=>row.method==='POST'&&row.path.endsWith('/email-change'));
  assert.equal(submitted.length,1);assert.deepEqual(JSON.parse(submitted[0].body),{operationId,newEmail:'new@example.invalid'});
  await unlink(writerCredentialFile);
  const before=requests.length;
  assert.equal(typeof await loadOperationsWorkerAuthorization(path,{db,endpoint}),'function');
  assert.equal(typeof(await loadOperationsAccountDirectory(path)).get,'function');
  assert.equal(requests.length,before,'worker/read-only directory construction does not read or use a writer');
  await assert.rejects(()=>loadOperationsConfiguration(path,{db,endpoint,factory}),error=>error.code==='ENOENT');
});
