const maximumTimerDelay=2147483647;

// Browser timers cannot represent a whole long-lived business deadline. Wait
// in bounded pieces and act only after the original absolute deadline arrives.
export function scheduleOperationsDeadline(deadline:number,onExpire:()=>void):()=>void{
  if(!Number.isFinite(deadline))return()=>{};
  let cancelled=false,timer:ReturnType<typeof setTimeout>;
  const arm=()=>{
    timer=setTimeout(()=>{
      if(cancelled)return;
      if(Date.now()<deadline)arm();else onExpire();
    },Math.max(0,Math.min(maximumTimerDelay,deadline-Date.now())));
  };
  arm();
  return()=>{cancelled=true;clearTimeout(timer);};
}
