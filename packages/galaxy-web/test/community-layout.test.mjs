import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {buildSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Compile the production components in memory; no generated file or replacement business module.
function component(name){
 const filename=fileURLToPath(new URL('../src/'+name,import.meta.url));
 const result=buildSync({entryPoints:[filename],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',loader:{'.css':'empty'},jsx:'automatic',logLevel:'silent'});
 const loaded=new Module(filename);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(dirname(filename));loaded._compile(result.outputFiles[0].text,filename);
 return loaded.exports;
}
const {communitySelection,communityBrowsePath,CommunityLayout}=component('community-navigation.tsx');
const {contentCoverFromLinks,safeContentImageSource,ContentCover}=component('community-content-visuals.tsx');

test('community source and external format survive a keyword route without entering signed publication fields',()=>{
 const route=communityBrowsePath({topic:'technology',query:'硬件',source:'external',format:'work'});
 assert.deepEqual(communitySelection(route.split('?')[1]),{topic:'technology',query:'硬件',source:'external',format:'work'});
 const write=new URL(communityBrowsePath({topic:'technology',query:'硬件',source:'external',format:'work',compose:true}),'https://galaxy.invalid');
 assert.equal(write.searchParams.get('compose'),'post');assert.equal(write.searchParams.has('source'),false);assert.equal(write.searchParams.has('format'),false);
 assert.equal(communitySelection('?topic=invalid&source=invalid&format=work').topic,'');
 assert.equal(communitySelection('?format=work').format,'all');
});

test('the production layout preserves full function navigation and clearly labels child links as channel searches',()=>{
 const html=renderToStaticMarkup(React.createElement(CommunityLayout,{path:'/app/community',search:'?topic=technology&q=硬件&source=external',navigate:()=>{}},React.createElement('p',null,'实际列表')));
 for(const label of ['发现','社区','消息','我的工作','账户中心','收藏','技术与工具','艺术与创作','阅读与学习','生活与兴趣','银河反馈','接入','设置'])assert.ok(html.includes(label),label);
 assert.ok(html.includes('在技术与工具中搜索“硬件”'));assert.ok(html.includes('source=external'));
 assert.ok(html.includes('实际列表'));assert.ok(html.includes('aria-labelledby='));
 assert.equal(html.includes('GALAXY'),false,'the community rail must not create another brand header');
});

test('covers come only from author image links; missing pictures remain a text row',()=>{
 assert.equal(contentCoverFromLinks(['https://example.org/article'],'正文'),undefined);
 assert.deepEqual(contentCoverFromLinks(['https://example.org/article','https://images.example.org/original.jpg?size=640'],'作者图片'),{src:'https://images.example.org/original.jpg?size=640',alt:'文中配图：作者图片'});
 assert.equal(renderToStaticMarkup(React.createElement(ContentCover,{})),'');
 const image=renderToStaticMarkup(React.createElement(ContentCover,{image:{src:'/images/examples/reading-lamp.png',alt:'明确示例配图'}}));
 assert.ok(image.includes('alt="明确示例配图"'));assert.ok(image.includes('referrerPolicy="no-referrer"'));assert.ok(image.includes('loading="lazy"'));
 const linked=renderToStaticMarkup(React.createElement(ContentCover,{image:{src:'/images/examples/reading-lamp.png',alt:'明确示例配图'},href:'/app/community/posts/11111111-1111-4111-8111-111111111111',navigate:()=>{}}));
 assert.ok(linked.includes('href="/app/community/posts/11111111-1111-4111-8111-111111111111"'));
});

test('image covers reject active schemes, credential URLs, non-images and private remote hosts',()=>{
 for(const url of ['javascript:alert(1)','data:image/png;base64,abc','https://name:password@example.org/a.png','https://example.org/a.svg','http://example.org/a.jpg','https://127.0.0.1/private.png','https://192.168.1.2/private.png','/images/../private.png'])assert.equal(safeContentImageSource(url),null,url);
 assert.equal(safeContentImageSource('https://images.example.org/content.webp'),'https://images.example.org/content.webp');
});
