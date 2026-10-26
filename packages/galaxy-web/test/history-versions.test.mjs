import test from 'node:test';
import assert from 'node:assert/strict';
import {groupHistoryVersions} from "../src/features/work-records/history-versions.mjs";

test('one attempt stays one reading group while earlier authorized versions remain in order',()=>{
 const first={id:'attempt-a',version:1,strategy:'初次尝试'},updated={id:'attempt-a',version:3,strategy:'修订内容'},middle={id:'attempt-a',version:2,strategy:'补充内容'},other={id:'attempt-b',version:1,strategy:'另一项尝试'};
 const records=Object.freeze([first,other,updated,middle]);
 const groups=groupHistoryVersions(records);
 assert.equal(groups.length,2);assert.equal(groups[0].latest,updated);assert.deepEqual(groups[0].previous,[first,middle]);
 assert.equal(groups[1].latest,other);assert.deepEqual(records,[first,other,updated,middle]);
});
test('missing fact identity never merges unrelated records and unseen versions are never constructed',()=>{
 const visible={id:'attempt-a',version:1,supersededInVisibleHistory:true},unidentified={strategy:'同名尝试'},other={strategy:'同名尝试'};
 assert.deepEqual(groupHistoryVersions([visible,unidentified,other]),[
  {latest:visible,previous:[]},{latest:unidentified,previous:[]},{latest:other,previous:[]}
 ]);
});
