import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryFieldPolicy } from '../src/domain/history-fields.mjs';
import { verifyHistoryPresentation } from './history-presentation-workflow.mjs';
test('history views retain reported outcomes and corrections, hide private fields, and recompute after grant or binding revocation',()=>verifyHistoryPresentation());
test('explicit view policies omit unexpected fields at projection and nested configuration boundaries',()=>{
  const candidate={privateFuture:'do not disclose',attempts:[{id:'attempt',sequence:1,privateFuture:'secret',configuration:{environment:'private',version:'1',tools:[],futureSecret:'hidden'}}],
    results:[{id:'result',outcome:'failed',futureSecret:'hidden'}],corrections:[],reviews:[],participants:[{subjectId:'owner',role:'requester',futureSecret:'hidden'}],source:{kind:'local',reference:'local',futureSecret:'hidden'}};
  const before=structuredClone(candidate);
  for(const view of ['owner','authorized','public']){
    const projected=applyHistoryFieldPolicy(candidate,view);
    assert.ok(!JSON.stringify(projected).includes('hidden'));assert.equal(projected.privateFuture,undefined);
    assert.equal(projected.attempts[0].configuration!==undefined,view==='owner');
    assert.equal(projected.participants!==undefined,view==='owner');
  }
  assert.deepEqual(candidate,before);assert.throws(()=>applyHistoryFieldPolicy(candidate,'unknown'),/Unsupported/);
});
