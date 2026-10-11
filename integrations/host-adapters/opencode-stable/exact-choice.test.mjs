import test from 'node:test';
import assert from 'node:assert/strict';
import {exactChoiceText,showExactChoice} from './exact-choice.mjs';

test('native Dialog shows authored scope and retains the exact original confirmation only after an actual selection',()=>{
 const preview={payloadJson:JSON.stringify({title:'合成：分享当前方法',summary:'只发送这一段',visibility:'Private',viewerIds:['GUID'+'1'.repeat(28)]}),intentJson:JSON.stringify({visibility:'Private',viewers:['GUID'+'1'.repeat(28)],expiresAt:2000000000}),confirmation:'exact-original-authorization'};
 let page,detail,back,selected=[],cancelled=0,current=true;
 showExactChoice({preview,title:'分享',select:p=>page=p,info:(_title,text,cb)=>{detail=text;back=cb;},isCurrent:()=>current,onConfirm:value=>selected.push(value),onCancel:()=>cancelled++});
 assert.equal(page.title,'分享');assert.match(page.options[0].description,/只发送这一段/);assert.match(page.options[0].description,/自己与所选接收方/);assert.equal(JSON.stringify(page).includes('exact-original-authorization'),false);
 const firstAllow=page.routes[1];page.routes[2]();assert.deepEqual(selected,[]);assert.equal(detail,[preview.payloadJson,preview.intentJson].join('\n\n'));firstAllow();assert.deepEqual(selected,[]);
 back();page.routes[1]();page.routes[1]();assert.deepEqual(selected,[preview.confirmation]);assert.equal(cancelled,0);
 current=false;back();assert.deepEqual(selected,[preview.confirmation]);
});

test('cancel, stale view and missing original confirmation cannot approve another operation',()=>{
 let page,current=true,allows=0,cancels=0;
 const show=preview=>showExactChoice({preview,title:'本次内容',select:p=>page=p,info(){},isCurrent:()=>current,onConfirm:()=>allows++,onCancel:()=>cancels++});
 const control=show({payloadJson:'{"text":"合成：当前选择"}',confirmation:'original'});const old=page.routes[1];control.close();old();assert.equal(allows,0);
 show({payloadJson:'{"text":"合成：当前选择"}',confirmation:'original'});page.onBack();page.routes[1]();assert.equal(cancels,1);assert.equal(allows,0);
 show({payloadJson:'{"text":"合成：未准备"}'});assert.equal(page.options[0].disabled,true);page.routes[1]();assert.equal(allows,0);
 show({confirmation:'original'});current=false;page.routes[1]();page.onBack();assert.equal(allows,0);assert.equal(cancels,1);
});

test('identity and selected device effects are explicit without granting business data access',()=>{
 assert.match(exactChoiceText({previewJson:'{"action":"link","target":{"issuer":"https://issuer.example","externalSubject":"selected-account"}}'}),/不授予业务资料读取权/);
 const revoked=exactChoiceText({previewJson:'{"action":"revoke-binding","target":{"installationId":"selected-device","bindingId":"selected-binding"},"currentSession":true}'});
 assert.match(revoked,/selected-device/);assert.match(revoked,/selected-binding/);assert.match(revoked,/本机会话会断开/);
});

test('a help deadline stays readable while the original authorization expiry remains in source details',()=>{
 const intentJson=JSON.stringify({visibility:'Private',viewers:[],expiresAt:2000000000}),preview={payloadJson:'{"title":"Current help","scope":"Only this work"}',intentJson,confirmation:'original'};
 let page,detail,confirmation;
 showExactChoice({preview,title:'Current help',showAuthorizationExpiry:false,note:'求助有效至：2033-05-19',select:p=>page=p,info:(_title,text)=>detail=text,isCurrent:()=>true,onConfirm:value=>confirmation=value,onCancel(){}});
 assert.match(page.options[0].description,/求助有效至：2033-05-19/);assert.doesNotMatch(page.options[0].description,/\n有效至：/);page.routes[2]();assert.ok(detail.includes(intentJson));assert.equal(confirmation,undefined);
 assert.match(exactChoiceText(preview),/有效至：/);
});

test('reading a complete professional preview does not approve or replace its original choice',()=>{
 let page,readBack,readText,selected=[],current=true;
 const preview={payloadJson:'{"summary":"Original participation","visibility":"Private"}',confirmation:'original-choice'};
 showExactChoice({preview,title:'Save participation',readBeforeChoice:true,note:'Original result: partial',select:p=>page=p,info:(_title,text,back)=>{readText=text;readBack=back;},isCurrent:()=>current,onConfirm:value=>selected.push(value),onCancel(){}});
 assert.equal(page,undefined);assert.match(readText,/Original participation/);assert.match(readText,/Original result: partial/);assert.deepEqual(selected,[]);
 readBack();assert.equal(page.title,'Save participation');page.routes[1]();page.routes[1]();assert.deepEqual(selected,['original-choice']);
 page=undefined;showExactChoice({preview,title:'Save participation',readBeforeChoice:true,select:p=>page=p,info:(_title,_text,back)=>readBack=back,isCurrent:()=>current,onConfirm:value=>selected.push(value),onCancel(){}});
 current=false;readBack();assert.equal(page,undefined);assert.deepEqual(selected,['original-choice']);
});
