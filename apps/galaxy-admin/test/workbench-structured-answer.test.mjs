import test from 'node:test';
import assert from 'node:assert/strict';
import {readReplyForm,diagramSourceAllowed} from '../src/components/workbench/workbench-answer-guards.ts';

test('reply forms accept bounded text and choices without URLs, actions or unknown fields',()=>{
 const source={title:'分析范围',fields:[{id:'period',label:'时间范围',type:'select',options:['7天','30天']},{id:'topic',label:'关注方向',type:'text'}]};
 assert.deepEqual(readReplyForm(JSON.stringify(source)),source);
 for(const value of [{...source,action:'execute'}, {...source,fields:[{id:'x',label:'口令',type:'password'}]}, {...source,fields:[source.fields[0],source.fields[0]]}, {...source,fields:[{...source.fields[0],options:['7天','7天']}]}, {...source,fields:Array(9).fill(source.fields[0])}])assert.equal(readReplyForm(JSON.stringify(value)),null);
 for(const id of ['constructor','__proto__','toString'])assert.equal(readReplyForm(JSON.stringify({...source,fields:[{id,label:'关注方向',type:'text'}]})),null);
 assert.equal(readReplyForm('unfinished'),null);assert.equal(readReplyForm('x'.repeat(9000)),null);
});

test('flowchart and hierarchy diagrams reject model configuration, HTML, links and style directives',()=>{
 for(const value of ['flowchart LR\n A[读取] --> B{结果}\n B -->|有效| C[说明结果]','mindmap\n  root((工作台))\n    工具\n    操作卡'])assert.equal(diagramSourceAllowed(value),true);
 for(const value of ['flowchart LR\n click A "https://example.com"','flowchart TD\n A[<script>bad</script>]','%%{init:{}}%%\nflowchart TD\n A-->B','---\nconfig:\n---\nflowchart TD','flowchart TD\n classDef x fill:red','flowchart TD\n style A fill:red','sequenceDiagram\nA->>B: foo','x'.repeat(9000)])assert.equal(diagramSourceAllowed(value),false);
});
