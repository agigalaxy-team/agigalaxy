/** Submit one retained account operation; a retry first resolves the original receipt. */
export const accountPayloadDigest=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(n=>n.toString(16).padStart(2,'0')).join('');

type AccountOperation={id:string};
type Call=(path:string,input:unknown)=>Promise<unknown>;
export async function sendAccountOperation<T extends AccountOperation>({pending,payload,call,receiptPath,eventPath,remember,release,isAcknowledged}:{pending:T|null;payload:T;call:Call;receiptPath:string;eventPath:string;remember:(payload:T)=>void;release:()=>void;isAcknowledged:(result:unknown)=>boolean}):Promise<unknown>{
 if(pending){const receipt=await call(receiptPath,{id:pending.id,payloadHash:await accountPayloadDigest(pending)});
  if(isAcknowledged(receipt))return receipt;
  if(!receipt||typeof receipt!=='object'||!('state'in receipt)||receipt.state!=='absent')throw Error('receipt_unavailable');
 }else remember(payload);
 try{return await call(eventPath,payload);}catch(reason){
  const error=reason&&typeof reason==='object'?reason as {outcome?:string;status?:number;code?:string}:null;
  // A matching operation with conflicting bytes is not proof that the original is absent.
  if(error?.outcome==='rejected'&&typeof error.status==='number'&&error.status>=400&&error.status<500&&!['comment_conflict','comment_governance_conflict'].includes(error.code??''))release();
  throw reason;
 }
}
