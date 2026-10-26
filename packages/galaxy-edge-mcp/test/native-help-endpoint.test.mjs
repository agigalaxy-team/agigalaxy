import test from 'node:test';
import assert from 'node:assert/strict';
import {createConfiguredHelpEndpointValidator} from '../src/native-v2/configured-help-endpoint.mjs';
import {createLocalHelpStoreV2} from "../../galaxy-official/src/clients/local/help-store-v2.mjs";
import {createHelpRuntimeV2} from "../../galaxy-official/src/clients/flows/help-runtime-v2.mjs";
import {createTaskClientV2} from "../../galaxy-official/src/clients/task-v2.mjs";
import {createSearchClient} from "../../galaxy-official/src/clients/search.mjs";
import {createProjectDiscoveryClient} from "../../galaxy-official/src/clients/project-discovery.mjs";
import {createHelpSourcesV2} from "../../galaxy-official/src/clients/flows/help-sources-v2.mjs";
import {tmpdir} from 'node:os';

const endpoint='https://127.0.0.1:5242',subjectId='GUID'+'A'.repeat(28);
const sessions={readAuthorization:async()=>null,matchesAuthorization:()=>false,isAuthorizationCurrent:async()=>false,invalidateAuthorization(){}};
const factories=[createLocalHelpStoreV2,createHelpRuntimeV2,createTaskClientV2,createSearchClient,createProjectDiscoveryClient,createHelpSourcesV2];

test('all Help construction paths retain default public endpoint validation',()=>{
 for(const factory of factories)assert.throws(()=>factory({dataDirectory:tmpdir(),endpoint,subjectId,sessions}),undefined,factory.name);
});

test('explicit Native Help configuration accepts only the selected canonical HTTPS origin',()=>{
 const validateEndpoint=createConfiguredHelpEndpointValidator(endpoint);
 assert.equal(validateEndpoint(endpoint).origin,endpoint);
 for(const value of ['https://127.0.0.1:5243','https://foreign.invalid',endpoint+'/',endpoint+'/v2',endpoint+'?redirect=https://foreign.invalid',
  'https://user:pass@127.0.0.1:5242','http://127.0.0.1:5242'])assert.throws(()=>validateEndpoint(value),/native_help_endpoint_changed/);
 for(const value of ['http://127.0.0.1:5242',endpoint+'/',endpoint+'/v2','https://user:pass@127.0.0.1:5242'])assert.throws(()=>createConfiguredHelpEndpointValidator(value),/native_help_endpoint_invalid/);
 for(const factory of factories){
  assert.doesNotThrow(()=>factory({dataDirectory:tmpdir(),endpoint,subjectId,sessions,validateEndpoint}),factory.name);
  assert.throws(()=>factory({dataDirectory:tmpdir(),endpoint:'https://foreign.invalid',subjectId,sessions,validateEndpoint}),/native_help_endpoint_changed/,factory.name);
 }
});
