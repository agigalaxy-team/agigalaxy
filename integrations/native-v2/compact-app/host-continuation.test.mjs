import test from 'node:test';
import assert from 'node:assert/strict';
import {hostWorkContinuation,hostDirectionContinuation} from './host-continuation.mjs';

test('the original host receives current authored content separately from exact references, without unsent editors or unselected offers',()=>{
 const refs={taskId:'exact-current-task',method:'continue-current-work'},view={object:{kind:'task',id:refs.taskId},source:{title:'继续核对导出',summary:'原段落与当前允许的结果'},
  draft:{text:'PRIVATE_NOTE'},replyDraft:{text:'PRIVATE_UNSENT'},preview:{payload:{text:'UNSENT_PUBLICATION'}},
  help:{selectedHelpIds:['selected'],offers:[{id:'selected',state:'current',helpDescription:'按当前段落检查',userFacingReason:'只处理已选范围'},{id:'other',state:'current',helpDescription:'UNSELECTED_OFFER'}]}};
 const result=hostWorkContinuation(refs,view);assert.match(result.content[0].text,/原段落与当前允许的结果/);assert.match(result.content[0].text,/按当前段落检查/);
 assert.ok(!result.content[0].text.includes(refs.taskId));assert.equal(result.structuredContent.taskId,refs.taskId);
 for(const privateText of ['PRIVATE_NOTE','PRIVATE_UNSENT','UNSENT_PUBLICATION','UNSELECTED_OFFER'])assert.ok(!JSON.stringify(result).includes(privateText));
 assert.equal(result.structuredContent.businessMutation,false);assert.equal(result.structuredContent.permissionExpanded,false);
 const unavailable=hostWorkContinuation(refs,{...view,sourceError:'no-current-permission'});assert.ok(!JSON.stringify(unavailable).includes(view.source.summary));
});

test('a Worker result returns its actual output; direction selection is not a publication or successful method reuse',()=>{
 const output={state:'completed',operation:'sum',value:42,inputCount:2,workerVersion:'0.1.0'};
 const result=hostWorkContinuation({associationId:'original-association'},{kind:'galaxy-worker-panel',selected:{association:{purpose:'把当前数字相加'},peer:{peer:{state:'completed',text:JSON.stringify(output)},resultImportV2:{draft:{summary:'PRIVATE_IMPORT_DRAFT'}}}},preview:{purpose:'UNSENT_NEW_ACTION'}});
 assert.match(result.content[0].text,/合计：42/);assert.equal(result.structuredContent.associationId,'original-association');assert.ok(!JSON.stringify(result).includes('UNSENT_NEW_ACTION'));assert.ok(!JSON.stringify(result).includes('PRIVATE_IMPORT_DRAFT'));
 const direction=hostDirectionContinuation({path:'methods',taskId:'original-task'});assert.match(direction.content[0].text,/查找可用方法/);assert.equal(direction.structuredContent.permissionExpanded,false);
});
