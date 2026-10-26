import assert from 'node:assert/strict';
import test from 'node:test';
import {fileBytes,fileHistory,fileStatus,fileTitle,filesHref,filesLocation,filesQuery,nextFilesPage,previousFilesPage} from "../src/lib/files/files-view-model.ts";

const first='1a111111-1111-4111-8111-111111111111';
const second='2b222222-2222-4222-8222-222222222222';
const stamp='2026-10-23T01:00:00.000Z';

test('file API queries contain only supported metadata filters and never UI or selected object context',()=>{
 const location=filesLocation({kind:'all',state:'expired',processing:'cleanup',issue:'cleanup',view:'exceptions',id:first,fileKind:'forum',after:'chat:'+second,trail:'start,forum:'+first,query:'private-name.zip',body:'private-text',roomId:first});
 const query=new URLSearchParams(filesQuery(location)),summary=new URLSearchParams(filesQuery(location,{summary:true}));
 assert.deepEqual([...query.keys()].sort(),['after','issue','limit','processing','state']);
 assert.deepEqual([...summary.keys()].sort(),['issue','processing','state']);
 assert.equal(query.get('after'),'chat:'+second);
 for(const denied of ['id','fileKind','trail','view','query','body','roomId'])assert.equal(query.has(denied),false);
 assert.equal(summary.has('after'),false);assert.equal(summary.has('limit'),false);
});

test('file selection is independent from source filtering and unsupported deep links do not become API input',()=>{
 const location=filesLocation({kind:'all',id:first,fileKind:'forum'});
 assert.equal(location.kind,'all');assert.equal(location.fileKind,'forum');assert.equal(location.selected,first);
 assert.equal(new URLSearchParams(filesQuery(location)).has('kind'),false);
 const href=filesHref(location);
 assert.equal(new URL(href,'https://admin.invalid').searchParams.get('fileKind'),'forum');
 const legacy=filesLocation({kind:'forum',id:first});assert.equal(legacy.fileKind,'forum');
 const invalid=filesLocation({kind:['forum','chat'],fileKind:'https://else.invalid',id:first,after:'chat:'+first+'&roomId='+second,state:'deleted',processing:'erase',trail:'bad'});
 assert.equal(invalid.selected,'');assert.equal(invalid.after,'');assert.equal(invalid.state,'');assert.equal(invalid.processing,'');assert.deepEqual(invalid.trail,[]);
});

test('real cursor trail and rule-page context preserve filters without treating a cursor as a total',()=>{
 const location=filesLocation({kind:'forum',view:'exceptions',issue:'scan',state:'scan-pending',id:first,fileKind:'forum'});
 const patch=nextFilesPage(location,'forum:'+second),next={...location,...patch};
 assert.deepEqual(patch,{after:'forum:'+second,trail:['start']});
 assert.deepEqual(previousFilesPage(next),{after:'',trail:[]});
 assert.deepEqual(nextFilesPage(location,'not-a-cursor'),{});
 const rules=filesLocation(Object.fromEntries(new URL(filesHref(next,{view:'rules'}),'https://admin.invalid').searchParams));
 assert.equal(rules.view,'rules');assert.equal(rules.issue,'scan');assert.equal(rules.after,'forum:'+second);assert.equal(rules.selected,first);
});

test('unknown storage is different from zero or reserved byte metadata',()=>{
 assert.equal(fileBytes(null),'未确认');assert.equal(fileBytes(undefined),'未确认');assert.equal(fileBytes(Number.NaN),'未确认');
 assert.equal(fileBytes(0),'0 B');assert.equal(fileBytes(1048576),'1 MiB');
 assert.equal(fileTitle({name:'计划稿.pdf',id:first}),'计划稿.pdf');
 assert.equal(fileTitle({name:null,id:first}),'文件记录 '+first.slice(0,8));
});

test('expiry, unknown cleanup results and object removal retain distinct meanings',()=>{
 const base={state:'available',expiresAt:stamp,removedAt:null,scan:{state:'clean'},cleanup:{state:'not-requested',objectRemoved:false}};
 assert.deepEqual(fileStatus(base,Date.parse(stamp)-1),{label:'附件状态可用',tone:'positive'});
 assert.deepEqual(fileStatus(base,Date.parse(stamp)),{label:'已到期',tone:'neutral'});
 const unknown={...base,activeLease:true,cleanup:{state:'result-unknown',objectRemoved:false}};
 assert.deepEqual(fileStatus(unknown,Date.parse(stamp)),{label:'已到期 · 清除结果未确认',tone:'negative'});
 assert.doesNotMatch(fileStatus(unknown,Date.parse(stamp)).label,/执行中|已移除|清除失败/);
 const pending={...base,cleanup:{state:'pending',objectRemoved:false}};
 assert.equal(fileStatus(pending,Date.parse(stamp)).label,'已到期 · 待清除');
 assert.deepEqual(fileStatus({...unknown,removedAt:stamp,cleanup:{state:'removed',objectRemoved:true}},Date.parse(stamp)),{label:'对象已移除',tone:'neutral'});
});

test('history uses only returned recorded events and does not invent upload completion or cleanup timing',()=>{
 const file={history:{items:[{kind:'prepared',at:'2026-10-23T00:00:00.000Z'},{kind:'upload-started',at:stamp},{kind:'scan-retry',at:'2026-10-23T02:00:00.000Z',operationId:second},{kind:'scan-result',at:null,scanState:'clean'}]}};
 const rows=fileHistory(file);
 assert.equal(rows.length,4);assert.equal(rows[0].label,'重新安排扫描');assert.equal(rows[1].label,'开始上传');assert.equal(rows[3].at,null);
 assert.doesNotMatch(rows.map(row=>row.label).join(' '),/上传完成|清除开始|释放完成/);
 assert.deepEqual(fileHistory({history:{items:[]}}),[]);
});

