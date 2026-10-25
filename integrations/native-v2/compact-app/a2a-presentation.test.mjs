import test from 'node:test';
import assert from 'node:assert/strict';
import {a2aParticipantContent,describeNativeChoice} from '../../../packages/galaxy-edge-mcp/src/native-v2/interaction/presentation.mjs';
import {workerPanelText} from './worker-result.mjs';
test('A2A separates only the exact matching system source prefix and retains authored limits and protocol bytes',()=>{
 const associationId='a3d7f7e1-4765-4262-9b99-71a549b78f69',responseHash='b'.repeat(64),prefix=`External A2A participant report; no independent Verification, acceptance or Resolution. Association ${associationId}; response SHA256 ${responseHash}; artifacts remain selected summaries/hashes in the private local journal.`;
 const preview={action:'result',associationId,exact:{source:{responseHash},payload:{schemaVersion:2,kind:'result-recorded',reportedOutcome:'partial',summary:'合计：42',limitations:prefix+' 仅完成所选计算。'}}},bytes=JSON.stringify(preview);
 assert.equal(a2aParticipantContent(preview).limitations,'仅完成所选计算。');assert.equal(JSON.stringify(preview),bytes);
 const text=workerPanelText({kind:'galaxy-a2a-panel',preview});assert.match(text,/部分完成/);assert.match(text,/仅完成所选计算/);assert.doesNotMatch(text,/Association|independent Verification/);
 assert.equal(describeNativeChoice('galaxy_a2a_work_execute',{preview}).rows.find(r=>r.label==='限制').text,'仅完成所选计算。');
 assert.equal(a2aParticipantContent({...preview,associationId:'0170c583-3539-4e0e-9fc4-e63d5a470ba4'}).limitations,preview.exact.payload.limitations);
 const genuine={...preview,exact:{...preview.exact,payload:{...preview.exact.payload,limitations:'External A2A participant report is the user-authored limitation.'}}};assert.equal(a2aParticipantContent(genuine).limitations,genuine.exact.payload.limitations);
 const output={state:'completed',operation:'sum',value:42,inputCount:2,workerVersion:'0.1.0'};
 assert.equal(workerPanelText({kind:'galaxy-a2a-panel',selected:{association:{purpose:'当前合计'},peer:{peer:{state:'completed',text:JSON.stringify(output)}}}}),'当前合计\n\n合计：42');
});
