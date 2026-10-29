import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath,operationsRequestBodyLimit} from '../src/lib/proxy-policy.mjs';

test('management account BFF keeps exact scoped routes, query and write origin',()=>{
  const publicOrigin='https://admin.example.test',id='a'.repeat(64),operation='12d75129-b639-46ee-b549-786eb5675a6a';
  const root='/v1/operations/management-accounts';
  const check=(path,method='GET',origin=publicOrigin)=>operationsProxyPolicy({url:publicOrigin+path,method,
    headers:new Headers(origin?{origin}:{}),publicOrigin});
  const reads=[root+'?page=2&pageSize=50&query=member&roleId='+operation+'&aiDomain=governance&enabled=true&sort=created-desc',
    root+'/'+id,root+'/'+id+'/history?after=12&limit=20',root+'/operations/'+operation,
    root+'/'+id+'/assignments/operations/'+operation];
  for(const path of reads){
    assert.equal(operationsReadPath(path),true,path);
    assert.equal(check(path).allowed,true,path);
  }
  for(const path of [root,root+'/'+id+'/commands',root+'/'+id+'/assignments']){
    assert.equal(check(path,'POST').allowed,true,path);
    assert.deepEqual(check(path,'POST','https://unrelated.example.test'),{allowed:false,status:403});
    assert.deepEqual(check(path,'POST',null),{allowed:false,status:403});
    assert.equal(operationsRequestBodyLimit(path),16384);
    assert.equal(check(path+'?role=administrator','POST').allowed,false);
  }
  for(const path of [root+'?page=1&page=2',root+'?raw=1',root+'/'+id+'?include=password',root+'/'+id+'/history?sql=1',
    root+'/'+id+'/assignments/operations/'+operation+'?target=other',root+'/operations/'+operation+'?all=1',root+'/../keys',root+'/'+id+'/credentials']){
    assert.equal(check(path).allowed,false,path);
  }
  assert.equal(check(root,'DELETE').allowed,false);
  assert.equal(check(root+'/operations/'+operation,'POST').allowed,false);
});
