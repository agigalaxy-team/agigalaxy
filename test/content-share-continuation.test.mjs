import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrustPackageWorkspaceClient} from '../packages/galaxy-web/src/trust-package-workspace-client.mjs';

test('returning to a completed content export keeps its exact file after another content was exported',async()=>{
  const subjectId='GUID10'+'A'.repeat(26),endpoint='https://example.test',values=new Map();let current=true;
  const assertCurrent=()=>{if(!current)throw Error('trust_identity_changed');};
  const container=id=>({format:'galaxy-readable-trust/v1',files:{'summary.md':'Synthetic export '+id,'objects.json':'{}','identity.json':'{}'},manifestJson:JSON.stringify({subjectId,packageId:id}),signature:'synthetic-cache-fixture'});
  const second={packageId:'2'.repeat(64),container:container('2'.repeat(64))};
  const runtime={api:{endpoint,snapshot:()=>({subjectId,bindingId:'current-native-session',generation:1})},taskDraftScope:()=>({key:'selected-native-device',deviceId:'synthetic-device'}),
    receiptStatus:{captureLease:()=>({assertCurrent})},async getLocal(key){return structuredClone(values.get(key));},async putLocal(key,value){values.set(key,structuredClone(value));return value;},
    trustPackages:{async lastExport(){return second;}}};
  const workspace=createTrustPackageWorkspaceClient(runtime,{subjectId,connected:true}),first={packageId:'1'.repeat(64),container:container('1'.repeat(64))};
  await workspace.rememberExport('work:first',first);await workspace.rememberExport('work:second',second);
  assert.deepEqual((await workspace.readExport('work:first')).container,first.container);
  assert.deepEqual(await workspace.exportReceipt({kind:'trust-package-export',contextKey:'work:first',packageId:first.packageId,subjectId,endpoint}),{state:'acknowledged',packageId:first.packageId});
  current=false;await assert.rejects(workspace.readExport('work:first'),/trust_identity_changed/);
});
