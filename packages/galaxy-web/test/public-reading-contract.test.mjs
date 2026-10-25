import assert from 'node:assert/strict';
import test from 'node:test';
import {isPublicReadingRoute,loadPublicReadingPage,publicReadingDataUrl,validatePublicReadingPage} from '../src/features/public-reading/contract.mjs';

const page=(path,body=[])=>({version:1,path,title:'说明 · 银河',description:'说明',location:'文档',behaviors:[],sidebar:[],body,footer:[]});
const node=(tag,attrs={},children=[])=>({tag,attrs,children});

test('only current reading pages enter the shared App; home and original files keep their browser behavior',()=>{
  for(const path of ['/downloads/','/downloads/verification/','/privacy/','/docs/native-client/0.1.12/installation/','/docs/web/0.1.19/community/'])assert.equal(isPublicReadingRoute(path),true,path);
  for(const path of ['/','/app/community','/downloads/native-client/0.1.12/package.tgz','/docs/native-client/0.1.12/installation.md','/docs/v0.4/overview.md','/docs/../index/'])assert.equal(isPublicReadingRoute(path),false,path);
  assert.equal(publicReadingDataUrl('/downloads'),'/assets/public-pages/downloads/index.json');
});

test('public content rejects executable nodes, attributes, URLs, unregistered behavior and mismatched page data',()=>{
  const invalid=[node('script',{},['alert(1)']),node('iframe'),node('p',{onclick:'alert(1)'}),node('p',{style:'color:red'}),
    node('a',{href:'javascript:alert(1)'}),node('a',{href:'//another.test/'}),node('a',{href:'/\\another.test/'}),node('a',{href:'https://name:password@another.test/'})];
  for(const value of invalid)assert.throws(()=>validatePublicReadingPage(page('/docs/',[value]),'/docs/'));
  assert.throws(()=>validatePublicReadingPage({...page('/docs/'),behaviors:['execute-script']},'/docs/'));
  assert.throws(()=>validatePublicReadingPage(page('/network/'),'/docs/'));
  const text='<script>literal sample</script>',value=page('/docs/',[node('code',{},[text])]);
  assert.equal(validatePublicReadingPage(value,'/docs/').body[0].children[0],text);
});

test('reading data is loaded and cached by exact page without requiring a business runtime',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async url=>{calls.push(url);return new Response(JSON.stringify(page('/how-it-works/')),{headers:{'content-type':'application/json'}});};
  try{
    assert.equal((await loadPublicReadingPage('/how-it-works/')).path,'/how-it-works/');
    assert.equal((await loadPublicReadingPage('/how-it-works/')).path,'/how-it-works/');
    assert.deepEqual(calls,['/assets/public-pages/how-it-works/index.json']);
    await assert.rejects(loadPublicReadingPage('/network/'));
  }finally{globalThis.fetch=original;}
});
