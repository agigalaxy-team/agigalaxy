import test from 'node:test';import assert from 'node:assert/strict';
import {operatorMeResponse} from '../src/lib/operator-me.mjs';
import {executeAuthStrategies} from '../node_modules/payload/dist/auth/executeAuthStrategies.js';
test('Payload swallows unavailable strategy errors but Galaxy me preserves unknown as 503',async()=>{
 const payload={config:{loggingLevels:{}},authStrategies:[{name:'fixture',authenticate:async()=>{throw Error('temporary');}}],logger:{error(){}}};
 assert.equal((await executeAuthStrategies({payload,headers:new Headers()})).user,null);
 let projection=0;const deps={readSession:async()=>{throw Error('temporary');},project:async()=>{projection++;}};
 const unknown=await operatorMeResponse(new Headers(),deps);assert.equal(unknown.status,503);assert.deepEqual(await unknown.json(),{error:'operator_session_unavailable',state:'unknown'});assert.equal(projection,0);
 const out=await operatorMeResponse(new Headers(),{...deps,readSession:async()=>({state:'signed-out'})});assert.equal(out.status,200);assert.deepEqual(await out.json(),{user:null});
 const operator={id:'fixture-owner',displayName:'Fixture',role:'reader'};const current=await operatorMeResponse(new Headers(),{readSession:async()=>({state:'signed-in',operator}),project:async()=>({...operator,id:'cms-id',externalId:operator.id})});assert.equal(current.status,200);assert.equal((await current.json()).user._strategy,'galaxy-operations-session');
});
