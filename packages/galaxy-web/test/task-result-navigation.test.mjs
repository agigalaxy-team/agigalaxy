import test from 'node:test';
import assert from 'node:assert/strict';
import {readTaskResult,taskResultPath,taskResultReturn,exactReadableResult} from '../src/task-result-navigation.mjs';
const taskId='651b3db6-0037-4c03-a2df-5a78fa99b78f',id='ee286cb2-6de1-4b3f-96bd-d72b209f92ce',delivery='253a3b24-6ce1-428f-8fa3-bc3c23479719';
test('a delivery keeps its exact result version and returns to that delivery after refresh',()=>{
 const path=taskResultPath(taskId,{id,version:2},delivery),selection=readTaskResult(new URL(path,'https://example.test').search);
 assert.deepEqual(selection,{selected:true,reference:{id,version:2},deliveryId:delivery});
 assert.equal(taskResultReturn(taskId,selection.deliveryId),`/app/tasks/${taskId}?section=collaboration&view=people#delivery-${delivery}`);
 const items=[{id,version:1,text:'original'},{id,version:2,text:'delivered'},{id,version:3,text:'later'}];
 assert.equal(exactReadableResult(items,selection.reference).text,'delivered');
 assert.equal(exactReadableResult(items.filter(item=>item.version!==2),selection.reference),null);
 const revised=readTaskResult(new URL(taskResultPath(taskId,{id,version:3},selection.deliveryId),'https://example.test').search);
 assert.equal(revised.reference.version,3);assert.equal(taskResultReturn(taskId,revised.deliveryId),taskResultReturn(taskId,selection.deliveryId));
});
test('incomplete or invalid deep links stay selected but never fall back to another result',()=>{
 for(const search of ['?result='+id,'?resultVersion=2','?result='+id+'&resultVersion=0','?result='+id+'&resultVersion=1.5','?result=other&resultVersion=2']){
  const selection=readTaskResult(search);assert.equal(selection.selected,true);assert.equal(selection.reference,null);
 }
 assert.equal(readTaskResult('?record=results').selected,false);
 assert.equal(readTaskResult('?delivery=//other.test').deliveryId,null);
 assert.equal(taskResultReturn(taskId,'//other.test'),taskResultPath(taskId));
});
