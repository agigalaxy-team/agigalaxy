// Runs beside the one API-owned XEP-0114 connection. A second worker component
// must not displace it. This handles data retention only, never Agent heartbeats.
export function createChatMaintenance({chat,accountChatGovernance,summaries,sharedSummaries,choices,transport,logger=()=>{},intervalMs=60000}){
  let timer=null,running=null,stopped=false,privateAfter=null,sharedAfter=null,choiceAfter=null;
  const log=input=>{try{logger(input);}catch{}};
  async function attempt(name,work){
    const startedAt=performance.now();
    try{return await work();}
    catch(error){log({event:'chat_retention_deferred',stage:name,startedAt,error});return null;}
  }
  async function work(){
    if(transport&&!transport.available){
      await attempt('transport-reconnect',async()=>{
        let timeout;
        try{await Promise.race([transport.start(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('timeout')),4000);})]);}
        catch(error){await transport.stop().catch(failure=>log({event:'chat_transport_unavailable',stage:'chat-stop',error:failure}));throw error;}
        finally{clearTimeout(timeout);}
      });
    }
    if(stopped)return;
    if(chat&&transport?.available)await attempt('archive',()=>chat.purgeExpired({limit:20}));
    if(accountChatGovernance)await attempt('account-reports',()=>accountChatGovernance.purgeExpired({limit:100}));
    if(stopped)return;
    if(summaries){
      await attempt('personal-expiry',()=>summaries.purgeExpired());
      if(stopped)return;
      const page=await attempt('personal-sources',()=>summaries.purgeInvalidSources({after:privateAfter,limit:20}));
      if(page)privateAfter=page.nextAfter;
    }
    if(stopped)return;
    if(sharedSummaries){
      await attempt('shared-expiry',()=>sharedSummaries.purgeExpired());
      if(stopped)return;
      const page=await attempt('shared-sources',()=>sharedSummaries.purgeInvalidSources({after:sharedAfter,limit:20}));
      if(page)sharedAfter=page.nextAfter;
    }
    if(stopped)return;
    if(choices){
      await attempt('choice-expiry',()=>choices.purgeExpired());
      if(stopped)return;
      const page=await attempt('choice-sources',()=>choices.purgeInvalidSources({after:choiceAfter,limit:20}));
      if(page)choiceAfter=page.nextAfter;
    }
  }
  function tick(){
    if(stopped||running)return running??Promise.resolve();
    const startedAt=performance.now();
    running=work().catch(error=>log({event:'chat_retention_deferred',stage:'chat-maintenance',startedAt,error})).finally(()=>{running=null;});return running;
  }
  return Object.freeze({
    tick,
    start(){if(stopped||timer)return;timer=setInterval(()=>{void tick();},intervalMs);timer.unref();void tick();},
    quiesce(){stopped=true;clearInterval(timer);timer=null;},
    async drain(){if(running)await running;},
  });
}
