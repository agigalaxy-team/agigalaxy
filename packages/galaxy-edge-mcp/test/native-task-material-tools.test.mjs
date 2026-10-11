import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeHttpDefinitions} from '../src/native-v2/http-tools.mjs';

test('Native retains published task material schemas and maps exact prepare/status without leaking body in status',async()=>{
 const calls=[],definitions=nativeHttpDefinitions({call:async(path,input,options)=>{calls.push({path,input,options});return {available:false,materials:[]};}});
 const taskId=randomUUID(),input={source:{postId:randomUUID(),versionId:randomUUID()},selections:[{materialId:randomUUID(),field:'body',start:0,end:5}],expiresAt:Math.floor(Date.now()/1000)+3600};
 assert.equal(definitions.galaxy_task_material_prepare.write,false);assert.equal(definitions.galaxy_task_material_status.write,false);
 await definitions.galaxy_task_material_prepare.run(definitions.galaxy_task_material_prepare.inputSchema.parse(input));
 assert.deepEqual(calls[0],{path:'/v2/task-materials/prepare',input,options:undefined});
 const current=await definitions.galaxy_task_material_status.run({taskId});assert.deepEqual(calls[1],{path:'/v2/tasks/'+taskId+'/materials/status',input:undefined,options:{method:'GET'}});assert.deepEqual(current,{available:false,materials:[]});
 const create=definitions.galaxy_task_v2_create.inputSchema;
 assert.ok(create.safeParse({consentId:randomUUID(),payloadJson:'{}'}).success);
 assert.ok(create.safeParse({signedIntent:'synthetic-signed-intent',payloadJson:'{}',materialBodies:[{materialId:input.selections[0].materialId,text:'first'}]}).success);
 assert.equal(create.safeParse({signedIntent:'synthetic-signed-intent',payloadJson:'{}',materialBodies:[]}).success,false);
 assert.equal(create.safeParse({consentId:randomUUID(),payloadJson:'{}',materialBodies:[{materialId:randomUUID(),text:'outside-original-schema'}]}).success,false);
});
