import test from 'node:test';
import assert from 'node:assert/strict';
import {contentItem} from '../src/operations-agentos-query-view.mjs';

test('current public content exposes the actual author topic, while hidden and unavailable sources expose neither topic',()=>{
 const current={kind:'post',id:'a71473b1-2a8d-87e0-a6d8-7d16b5ee4837',version:1,sourceState:'available',
  topic:'learning',originalTopic:'technology',title:'A current public title',body:'Current public text',
  visibility:{hidden:false,version:6},curation:{revision:1,sourceVersion:1,appliesToCurrent:true,topic:'learning',pinned:false,featured:false,tags:[]}};
 const publicProjection=contentItem(current,{body:true});
 assert.equal(publicProjection.topic,'learning');
 assert.equal(publicProjection.originalTopic,'technology','author topic comes from the current source field, not the effective curation');
 assert.equal(publicProjection.body,current.body);
 for(const source of [
  {...current,visibility:{...current.visibility,hidden:true}},
  {...current,sourceState:'unavailable'},
 ]){
  const value=contentItem(source,{body:true});
  assert.equal(value.publiclyReadable,false);
  assert.equal(value.originalTopic,null,'do not revive the raw source topic after current reading qualification is lost');
  assert.equal(value.topic,null);
  assert.equal(value.title,null);
  assert.equal(value.body,null);
 }
 assert.equal(current.originalTopic,'technology');
 assert.equal(current.topic,'learning');
});
