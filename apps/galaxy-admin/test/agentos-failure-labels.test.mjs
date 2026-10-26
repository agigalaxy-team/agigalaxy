import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeConversationFailureLabel} from "../src/lib/workbench/agentos-client.ts";

test('reply failure text separates model failure, positively unstarted business, and existing or unknown effects',()=>{
 const run={runId:'owned-run',operationId:'owned-turn',status:'ERROR',content:null,userInput:null,createdAt:1,events:[],awaitingHuman:false,errorCode:'operations_agentos_model_request_failed'};
 assert.equal(nativeConversationFailureLabel({...run,businessActivity:{state:'not-started',basis:'same-owner-turn-tool-and-card-ledger'}}),'这次没有取得答复。模型服务未返回完整结果，具体原因尚未记录。本轮没有发起业务处理。');
 const existing=nativeConversationFailureLabel({...run,businessActivity:{state:'check-records',basis:'same-owner-turn-tool-and-card-ledger'}});
 assert.match(existing,/原结果/);assert.doesNotMatch(existing,/未发起|已取消|已回滚/);
 const unknown=nativeConversationFailureLabel(run);assert.match(unknown,/以原记录为准/);assert.doesNotMatch(unknown,/未发起|处理已完成/);
 const old=nativeConversationFailureLabel({...run,errorCode:'operations_agentos_run_failed'});assert.match(old,/这次回复暂未生成/);assert.doesNotMatch(old,/模型服务/,'an unclassified old run is not retrospectively classified');
});
