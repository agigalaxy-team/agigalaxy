import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const file=new URL('../src/lib/operations-client.ts',import.meta.url),module={exports:{}};
runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{fileName:file.pathname,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:module.exports});
const {OperationsRequestError,operationsFailure}=module.exports;

test('request failure display separates permission, origin and verification without changing session expiry or leaking unknown codes',()=>{
  const display=(status,code)=>operationsFailure(new OperationsRequestError(status,code),'当前内容暂时无法读取。');
  assert.equal(display(401,'operations_login_required'),'管理登录已到期，请重新登录。');
  assert.equal(display(403,'operations_permission_denied'),'当前身份没有这项操作权限。');
  assert.equal(display(403,'operations_csrf_invalid'),'本次请求的来源未通过校验。');
  assert.equal(display(403,'operations_access_denied'),'本次请求未通过安全核验。');
  assert.equal(display(403,'operations_request_denied'),'本次请求未获准。');
  assert.equal(display(403,'business_admin_denied'),'当前管理身份未通过核验。');
  for(const unknown of ['unrecognized-private-code','toString','constructor','__proto__']){
    assert.equal(display(403,unknown),'本次操作未获准。');
    assert.equal(display(503,unknown),'当前内容暂时无法读取。');
  }
  assert.equal(display(409,'search_recovery_conflict'),'来源或任务状态已变化，请读取当前记录。');
  assert.equal(operationsFailure(new Error('private-error-text'),'读取未完成。'),'读取未完成。');
});
