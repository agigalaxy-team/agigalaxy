import test from 'node:test';
import assert from 'node:assert/strict';
import {hostReadingPages} from './host-reading-pages.mjs';
test('small real terminal pages preserve the full selected text and literal references',()=>{
 const text='原问题\n'+('中文与 English q · 所选结果\n\n').repeat(20)+'https://example.org/app/tasks/123#galaxy-work=qqq';
 const pages=hostReadingPages(text,{width:80,height:24});
 assert.ok(pages.length>1);assert.equal(pages.join(''),text);assert.ok(pages.every(page=>page.length<450));
 assert.deepEqual(hostReadingPages('只完成了一部分',{width:80,height:24}),['只完成了一部分']);
});
