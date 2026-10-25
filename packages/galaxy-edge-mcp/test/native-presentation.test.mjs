import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeReview} from '../src/native-v2/interaction/review.mjs';
import {nativeResult} from '../src/native-v2/interaction/choice.mjs';
import {presentNativeResult,nativeChoiceText,authoredRows,nativeConnectionMessage} from '../src/native-v2/interaction/presentation.mjs';

test('connection restoration failures describe the actual recoverable state without exposing transport codes',()=>{
 const unavailable={identity:'existing-identity',connected:false,connectionError:'native_connection_unavailable'};
 const shown=presentNativeResult('galaxy_native_status',nativeResult(unavailable),{readOnly:true});
 assert.match(shown.content[0].text,/暂时无法恢复已选服务/);assert.match(shown.content[0].text,/原身份、使用范围和工作保留/);
 assert.equal(shown.content[0].text.includes(unavailable.connectionError),false);assert.deepEqual(shown.structuredContent,unavailable);
 assert.match(nativeConnectionMessage({...unavailable,connectionError:'current_device_control_required'}),/连接权限已变化/);
 assert.match(nativeConnectionMessage({...unavailable,connected:true}),/已连接银河/);
 assert.match(nativeConnectionMessage({identity:'existing-identity',connected:false}),/按当前工作需要连接服务/);
});

test('ordinary tool text shows authored content while exact references remain structured',()=>{
 const data={state:'unknown',operationId:'internal-operation-id',payloadHash:'f'.repeat(64),content:{title:'继续原工作',summary:'实际可用的结果'}};
 const result=presentNativeResult('galaxy_task_v2_get',nativeResult(data),{readOnly:true});
 assert.equal(result.content[0].text.includes('internal-operation-id'),false);assert.equal(result.content[0].text.includes(data.payloadHash),false);
 assert.match(result.content[0].text,/实际可用的结果/);assert.match(result.content[0].text,/正在确认原操作/);assert.deepEqual(result.structuredContent,data);
 const source={resultType:'input_required',requestState:'real-request-state'};assert.equal(presentNativeResult('write',source),source);
});

test('known reference arithmetic displays the returned total without reinterpreting another schema or losing original bytes',()=>{
 const data={state:'completed',operation:'sum',value:42,inputCount:2,workerVersion:'0.1.0'},text=JSON.stringify(data);
 const rows=authoredRows({artifacts:[{name:'Selected arithmetic output',parts:[{text}]}]});
 assert.deepEqual(rows,[{label:'合计',text:'42'},{label:'完整内容',text:'保留原始字段与格式。',download:text}]);
 const unknown=authoredRows({text:JSON.stringify({...data,workerVersion:'another-schema'})});
 assert.equal(unknown.some(row=>row.label==='合计'),false);assert.equal(unknown.some(row=>row.label==='输入数量'&&row.text==='2'),true);
 assert.equal(unknown.at(-1).download,JSON.stringify({...data,workerVersion:'another-schema'}));
});

test('exact local approval page displays selected content and scope, exports diagnostics and never treats opening as approval',async()=>{
 let clock=1000;const review=createNativeReview({now:()=>clock}),identity='GUID'+'A'.repeat(28);
 const input={requestId:'original-request',payloadJson:JSON.stringify({title:'实际求助',workContext:{goal:'修复解析问题',currentSituation:'<script>不可执行的用户正文</script>'}}),visibility:'Private',viewers:[]};
 try{
  assert.equal(nativeChoiceText('galaxy_native_authorize',input).includes('payloadJson'),false);
  const pending=await review.request({key:'exact-key',name:'galaxy_native_authorize',input,identity});assert.equal(pending.state,'pending');
  const html=await(await fetch(pending.url)).text();assert.match(html,/修复解析问题/);assert.match(html,/仅自己/);assert.ok(!html.includes('<pre>'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes(identity));
  assert.equal((await review.request({key:'exact-key',name:'galaxy_native_authorize',input,identity})).state,'pending');
  const exact=await(await fetch(pending.url+'?download=1')).json();assert.deepEqual(exact.input,input);assert.equal(exact.identity,identity);
  const foreign=await fetch(pending.url,{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(foreign.status,403);
  const chosen=await fetch(pending.url,{method:'POST',headers:{Origin:new URL(pending.url).origin,'Content-Type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(chosen.status,200);
  assert.equal((await review.request({key:'exact-key',name:'galaxy_native_authorize',input,identity})).state,'accepted');assert.equal(review.consume('exact-key'),true);assert.equal(review.consume('exact-key'),false);
  clock+=300001;assert.equal((await fetch(pending.url)).status,404);
 }finally{review.close();}
});
