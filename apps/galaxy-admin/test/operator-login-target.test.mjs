import test from 'node:test';
import assert from 'node:assert/strict';
import {operatorLoginTarget}from'../src/lib/operator-login-target.mjs';
import {NextRequest}from'next/server';
import {proxy}from'../src/proxy.ts';
test('management login preserves the original local task and cannot loop or redirect outside management',()=>{
 assert.equal(operatorLoginTarget('/admin/operations/models?tab=bindings'),'/admin/operations/models?tab=bindings');
 assert.equal(operatorLoginTarget('/preview/pages/123?draft=true'),'/preview/pages/123?draft=true');
 for(const value of [null,'https://other.invalid/','//other.invalid/','/admin/login','/admin/login/?redirect=/admin/login','/admin/../outside','/admin\\outside','/admin\r\nLocation: https://other.invalid'])assert.equal(operatorLoginTarget(value),'/admin');
});
test('management login uses a document redirect and lets React render the navigation bridge',()=>{
 const request=new NextRequest('https://admin.example/admin/login?redirect=%2Fadmin%2Foperations%2Fmodels');
 const document=proxy(request),target=new URL(document.headers.get('location'));
 assert.equal(document.status,307);
 assert.equal(target.pathname,'/v1/operations/login');
 assert.equal(target.searchParams.get('returnTo'),'/admin/operations/models');
 const react=proxy(new NextRequest(request.url,{headers:{rsc:'1'}}));
 assert.equal(react.headers.get('x-middleware-next'),'1');
 assert.equal(react.headers.has('location'),false);
 const signedOut=proxy(new NextRequest('https://admin.example/admin/login?signedOut=1'));
 assert.equal(signedOut.headers.get('x-middleware-next'),'1');
});
