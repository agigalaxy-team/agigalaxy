export class OperationsRequestError extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
export const state={queue:[] as any[],requests:[] as any[]};
export function operationsFailure(_error:unknown,fallback:string){return fallback;}
export function operationsMayRetryRead(){return false;}
export function operationsRequest<T>(path:string,{signal}:{signal:AbortSignal}):Promise<T>{
 const plan=state.queue.shift()??{delay:15000,text:'fresh-current'},item={id:state.requests.length,path,startedAt:Date.now(),aborted:false,settled:false,finishedAt:null as number|null};state.requests.push(item);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{item.settled=true;item.finishedAt=Date.now();resolve({text:plan.text??'fresh-current',checkedAt:Math.floor(Date.now()/1000),readExpiresAt:Math.floor(Date.now()/1000)+(plan.expired?-1:30)} as T);},plan.delay);
  signal.addEventListener('abort',()=>{item.aborted=true;if(!plan.ignoreAbort){clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));}},{once:true});
 });
}
