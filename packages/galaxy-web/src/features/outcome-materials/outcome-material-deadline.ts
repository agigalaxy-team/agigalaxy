type Clock={now:()=>number;later:(fn:()=>void,milliseconds:number)=>ReturnType<typeof setTimeout>;cancel:(timer:ReturnType<typeof setTimeout>)=>void};
const systemClock:Clock={now:Date.now,later:(fn,ms)=>setTimeout(fn,ms),cancel:timer=>clearTimeout(timer)};
/** An external clock store for the exact source deadline, including a renewed deadline. */
export function createMaterialDeadline(deadline:string|number|null|undefined,clock:Clock=systemClock){
 const at=deadline===null||deadline===undefined?Infinity:typeof deadline==='number'?deadline*1000:Date.parse(deadline);
 const read=()=>at===Infinity||Number.isFinite(at)&&at>clock.now();
 return{read,subscribe:(changed:()=>void)=>{
  let timer:ReturnType<typeof setTimeout>|undefined,closed=false,previous=read();
  const schedule=()=>{if(closed)return;const current=read();if(previous!==current){previous=current;changed();}if(current&&Number.isFinite(at))timer=clock.later(schedule,Math.max(0,Math.min(at-clock.now(),2147483647)));};
  schedule();return()=>{closed=true;if(timer!==undefined)clock.cancel(timer);};
 }};
}
