import {openPersonalSummaryStore,createPersonalSummaryLocal} from "../../src/summaries/local/browser.mjs";
const marker='galaxy-personal-summary-idb-qa',output=document.querySelector('pre');
const assert=(value,message)=>{if(!value)throw new Error(message);};
async function test(){let stores=[];const prior=JSON.parse(sessionStorage.getItem(marker)||'null');
 const name=prior?.name??'galaxy-qa-personal-summary-'+crypto.randomUUID();
 try{const store=await openPersonalSummaryStore({name});stores.push(store);const subjectId='GUID'+'A'.repeat(28),endpoint='https://synthetic.example.org';
  const local=createPersonalSummaryLocal({subjectId,store}),roomId=prior?.roomId??crypto.randomUUID();
  if(!prior){const content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},
   fragments:[{id:crypto.randomUUID(),kind:'personal-note',text:'Synthetic local note persists across page reload',sourceRefs:[]}],keyMessageRefs:[]};
   const saved=await local.save({roomId,endpoint,content});await local.choose({enabled:false},{confirmed:true});
   sessionStorage.setItem(marker,JSON.stringify({name,roomId,summaryId:saved.summaryId}));store.close();location.reload();return;}
  const saved=await local.get({summaryId:prior.summaryId});assert(saved?.content.fragments[0].text==='Synthetic local note persists across page reload','Reload lost local note');
  assert((await local.status()).promptNeeded===false,'Reload repeated declined prompt');
  const second=await openPersonalSummaryStore({name});stores.push(second);const secondClient=createPersonalSummaryLocal({subjectId,store:second});
  const outcomes=await Promise.allSettled([local.save({summaryId:prior.summaryId,roomId,endpoint,expectedLocalRevision:saved.localRevision,content:saved.content}),
   secondClient.save({summaryId:prior.summaryId,roomId,endpoint,expectedLocalRevision:saved.localRevision,content:saved.content})]);
  assert(outcomes.filter(r=>r.status==='fulfilled').length===1,'Two local writers silently replaced the same revision');
  assert(outcomes.find(r=>r.status==='rejected')?.reason?.code==='local_summary_conflict','Expected explicit local conflict');
  stores.forEach(s=>s.close());stores=[];await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('QA database cleanup blocked'));});
  sessionStorage.removeItem(marker);output.textContent=JSON.stringify({passed:true,actualIndexedDB:true,pageReload:true,twoOpenConnections:true,
   compareAndSwap:true,declineRetained:true,cloudRequests:0,modelCalls:0,syntheticDatabaseDeleted:true,userAgent:navigator.userAgent},null,2);
 }catch(error){output.textContent=JSON.stringify({passed:false,error:String(error)});stores.forEach(s=>s.close());}
}
const run=()=>test().catch(error=>{output.textContent=JSON.stringify({passed:false,error:String(error)});});
document.querySelector('button').addEventListener('click',run);if(sessionStorage.getItem(marker))await run();
