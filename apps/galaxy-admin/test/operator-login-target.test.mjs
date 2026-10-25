import test from 'node:test';
import assert from 'node:assert/strict';
import {operatorLoginTarget}from'../src/lib/operator-login-target.mjs';
test('management login preserves the original local task and cannot loop or redirect outside management',()=>{
 assert.equal(operatorLoginTarget('/admin/operations/models?tab=bindings'),'/admin/operations/models?tab=bindings');
 assert.equal(operatorLoginTarget('/preview/pages/123?draft=true'),'/preview/pages/123?draft=true');
 for(const value of [null,'https://other.invalid/','//other.invalid/','/admin/login','/admin/login/?redirect=/admin/login','/admin/../outside','/admin\\outside','/admin\r\nLocation: https://other.invalid'])assert.equal(operatorLoginTarget(value),'/admin');
});
