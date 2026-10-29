import test from 'node:test';
import assert from 'node:assert/strict';
import {cloneConnection,recoveryCall} from './go-recovery.mjs';
import {executedObjectDeletionSubjects} from './object-deletion.mjs';
import {executedProsodyDeletionSubjects} from './prosody-current-state.mjs';

const id='11111111-1111-4111-8111-111111111111',subjectId='GUID'+'A'.repeat(28),endpoint='https://official.example.org';
const fixture=()=>({context:{artifacts:{directory:'/private/maintenance-'+id,databases:[{stanza:'business',socketDirectory:'/private/maintenance-'+id+'/sockets/business',network:'none',ports:[]}]},
 intent:{operationId:id},authority:{endpoint}},config:{directories:{restores:'/private'},postgres:[{id:'business',administrator:'postgres',database:'galaxy_pilot'}]}});
test('restore bridge accepts only the bound isolated business clone',()=>{
 const {context,config}=fixture();assert.equal(cloneConnection(context,config).socketDirectory,'/private/maintenance-'+id+'/sockets/business');
 for(const patch of [{network:'bridge'},{ports:[5432]},{socketDirectory:'/other/sockets/business'}]){
  const bad=structuredClone(context);Object.assign(bad.artifacts.databases[0],patch);
  assert.throws(()=>cloneConnection(bad,config),{code:'maintenance_private_recovery_socket_required'});
 }
});
test('the bridge transports exact input through stdin and rejects an invalid response',async()=>{
 const input={mode:'ledger-validate',ledger:{version:1}},binary={binary:'/fixed/galaxy-lifecycle',env:{GALAXY_RELEASE_DIRECTORY:'/fixed'}};
 let observed;
 assert.deepEqual(await recoveryCall(binary,input,async(file,args,options)=>{observed={file,args,options};return{stdout:'{"result":{"requests":1}}'};}),{requests:1});
 assert.equal(observed.file,binary.binary);assert.deepEqual(observed.args,['recovery-bridge']);assert.deepEqual(JSON.parse(observed.options.input),input);
 await assert.rejects(recoveryCall(binary,input,async()=>({stdout:'not-json'})),{code:'maintenance_recovery_bridge_invalid'});
});
test('object and chat restoration derive targets only after their ledger validator succeeds',async()=>{
 const ledger={endpoint,tables:{deletion_requests:[{id,subject_id:subjectId,execution_result:{}}]}};
 for(const read of [executedObjectDeletionSubjects,executedProsodyDeletionSubjects]){
  assert.deepEqual(await read(ledger,endpoint,{validate:async value=>assert.equal(value,ledger)}),[{subjectId,requestId:id}]);
  await assert.rejects(read(ledger,endpoint,{validate:async()=>{throw Error('bad signature');}}));
  await assert.rejects(read(ledger,endpoint));
 }
});
