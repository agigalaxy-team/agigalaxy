import {createNotificationInboxClient} from "../../../../galaxy-official/src/clients/personal-summary.mjs";

// Read-only home projection. Listing never claims presentation or marks read.
export function createHomeContinuityClient(runtime) {
  const initial=runtime.api.snapshot(), endpoint=runtime.api.endpoint;
  const lease=initial?runtime.receiptStatus?.captureLease?.():null;
  let closed=false;
  const check=()=>{lease?.assertCurrent();const now=runtime.api.snapshot();
    if(closed||runtime.api.endpoint!==endpoint||['subjectId','bindingId','generation'].some(key=>initial?.[key]!==now?.[key]))
      throw Error('身份或连接已改变，请刷新首页。');};
  const call=async(path,input,options)=>{check();try{const result=await runtime.api.call(path,input,options);check();return result;}catch(error){check();throw error;}};
  const inbox=createNotificationInboxClient({call});
  return Object.freeze({check,close:()=>{closed=true;},async read(){
    check();const entries=[['open',()=>call('/v2/tasks/query',{view:'open',limit:4},{authenticated:false})]];
    if(initial)entries.push(['notifications',()=>inbox.query({unreadOnly:true,limit:5},{authenticated:true})],['requested',()=>call('/v2/tasks/query',{view:'requested',limit:4},{authenticated:true})],['participating',()=>call('/v2/tasks/query',{view:'participating',limit:4},{authenticated:true})]);
    const results=await Promise.all(entries.map(async([kind,action])=>{try{return[kind,{page:await action()}];}catch(error){check();return[kind,{error:error.message}];}}));
    check();return Object.fromEntries(results);
  }});
}
