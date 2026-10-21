export function createExternalCredentialsMaintenance(service,{intervalMs=60000,logger=()=>{}}={}) {
  let timer,running=null,closed=false;const controller=new AbortController();
  function tick(){if(closed||running)return;const startedAt=performance.now();running=service.refreshDue({signal:controller.signal}).catch(error=>{
    if(!controller.signal.aborted)try{logger({event:'external_credentials_status_unavailable',stage:'credentials-refresh',startedAt,error});}catch{}
  }).finally(()=>{running=null;});}
  return {start(){if(timer||closed)return;tick();timer=setInterval(tick,intervalMs);timer.unref?.();},
    async close(){closed=true;clearInterval(timer);controller.abort();await running;}};
}
