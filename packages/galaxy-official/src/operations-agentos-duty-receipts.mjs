import {z} from 'zod';

const types={post:'content-post',reply:'content-reply',section:'content-section',account:'account','public-case':'community-report',case:'community-report','community-report':'community-report','chat-report':'chat-report',feedback:'feedback',
 project:'project',projects:'project',method:'method',methods:'method','chat-file':'file-chat','forum-file':'file-forum','file-cleanup-plan':'file-cleanup-plan','message-plan':'messaging-plan','messaging-plan':'messaging-plan',
 'recommendation-theme':'recommendation-policy','recommendation-policy':'recommendation-policy','search-configuration':'search-quality','search-quality':'search-quality',rule:'rule-key','rule-key':'rule-key',
 strategy:'strategy','strategy-configuration':'strategy-configuration','strategy-run':'strategy-run'};

export function originalOperationTarget(target,request){
 const targetType=target?.kind==='file'?(request?.targetKind==='chat'?'file-chat':request?.targetKind==='forum'?'file-forum':null):types[target?.kind]??null;
 return targetType&&typeof target?.id==='string'&&target.id.length>0&&target.id.length<=160?{targetType,targetId:target.id}:{targetType:null,targetId:null};
}

const count=z.number().int().nonnegative().max(25),safeCode=z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/);
const batchDetails=z.strictObject({counts:z.strictObject({applied:count,rejected:count}),items:z.array(z.strictObject({
 kind:z.enum(['post','reply']),id:z.uuid(),status:z.enum(['applied','rejected']),code:safeCode.nullable(),revision:z.number().int().nonnegative().nullable()
})).min(1).max(25)}).superRefine((value,ctx)=>{
 if(new Set(value.items.map(item=>item.kind+':'+item.id)).size!==value.items.length
  ||value.counts.applied!==value.items.filter(item=>item.status==='applied').length
  ||value.counts.rejected!==value.items.filter(item=>item.status==='rejected').length)ctx.addIssue({code:'custom',message:'Original batch receipt counts do not match its items'});
});

/** Closed metadata from an immutable original domain receipt, never a model
 * count or a reconstructed list of requested objects. It remains one operation.
 */
export function originalBatchReceiptDetails(receipt){
 if(!receipt||!Array.isArray(receipt.items))return null;
 const value={counts:receipt.counts,items:receipt.items.map(item=>({kind:item?.kind,id:item?.id,status:item?.status,code:item?.code,revision:item?.revision}))};
 const parsed=batchDetails.safeParse(value);return parsed.success?parsed.data:null;
}
