import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareExperienceQuery} from './experience-query.mjs';

test('prepares bounded clues from a long request including later content',()=>{
 const request='普通说明 '.repeat(1200)+'数据库连接失败 PostgreSQL';
 const query=prepareExperienceQuery(request);
 assert.ok(Array.from(query).length<2000);
 assert.match(query,/数据库|连接失|postgresql/);
});
test('empty or punctuation only is not a search',()=>{
 assert.equal(prepareExperienceQuery('... ！'), '');
});

test('retains distinct problem clues after repeated long background',()=>{
 const request='我们正在迁移一个很长的请求链，需要沿用现有方案。'.repeat(130)+'当前真正的问题是 TLS 证书链不受信任，代理层认证头可能缺失。有没有本机经验能参考？';
 const query=prepareExperienceQuery(request);
 assert.ok(Array.from(query).length<=2000);
 assert.match(query,/(?:^| )tls(?: |$)/);
 assert.match(query,/(证书链|书链不|链不受)/);
 assert.match(query,/(认证头|证头可)/);
});

test('samples distinct clues throughout a long request',()=>{
 const sections=Array.from({length:8},(_,index)=>Array.from({length:40},(_,term)=>`topic${index}part${term}`).join(' '));
 const query=prepareExperienceQuery(sections.join(' '));
 for(let index=0;index<8;index++)assert.match(query,new RegExp(`topic${index}part`));
 assert.ok(Array.from(query).length<=2000);
});
