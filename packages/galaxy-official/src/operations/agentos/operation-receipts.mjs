// Read original receipts for every connected card kind, without preparing or
// replaying an action. Prose is never evidence of a completed business effect.
const fields=new Set(['operationId','phase','state','version','revision','publishedVersion','themeKey','direction','enabled','hidden','planId','strategyId','versionId','feedbackId','accountId','reportId','messageId','action']);
const scalarReceipt=value=>Object.fromEntries(Object.entries(value??{}).filter(([key,item])=>fields.has(key)&&(item===null||['string','number','boolean'].includes(typeof item))));
const currentReads=kind=>kind.startsWith('search-')?{module:'search',view:'overview'}:kind==='recommendation-direction'?{module:'recommendations',view:'overview'}:kind.startsWith('rule-')?{module:'rules',view:'overview'}:null;

export async function conversationOperationReceipts(tools,operator,domain,context){
 const result={basis:'same-owner-fixed-ai-original-domain-receipts',valuesCurrent:false,availability:'available',items:[],checkedAt:tools.now(),readExpiresAt:tools.now()+30};
 if(!context)return result;
 const current=await tools.conversations.current(context.conversationId,{operator});
 if(current.row.domain!==domain)throw Object.assign(new Error('operations_agentos_domain_mismatch'),{code:'operations_agentos_domain_mismatch',status:403});
 const turn=(await tools.db.query('SELECT created_at FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4',[tools.endpoint,context.turnId,context.conversationId,operator.operatorId])).rows[0];
 if(!turn)throw Object.assign(new Error('operations_agentos_scope_denied'),{code:'operations_agentos_scope_denied',status:403});
 const rows=(await tools.db.query(`SELECT c.* FROM operations_agentos_conversation_cards_v1 c
  JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id AND s.endpoint=c.endpoint
  WHERE c.endpoint=$1 AND c.operator_id=$2 AND c.domain=$3 AND s.operator_id=$2 AND s.domain=$3 AND s.ai_account_id=$4
   AND c.created_at<=$5 ORDER BY c.created_at DESC,c.id DESC LIMIT 20`,[tools.endpoint,operator.operatorId,domain,current.row.ai_account_id,turn.created_at])).rows;
 for(const row of rows){
  try{
   const actor=await tools.cardActor(operator,row);
   if(row.state==='prepared'){
    const card=await tools.cardView(actor,row);
    result.items.push({cardId:row.id,operationId:row.operation_id,kind:row.proposal.kind,state:card.state,canConfirm:card.capability.canConfirm,effectExecuted:false});
    continue;
   }
   if(row.result?.state==='cancelled'){
    result.items.push({cardId:row.id,operationId:row.operation_id,kind:row.proposal.kind,state:'cancelled',effectExecuted:false});continue;
   }
   const original=await tools.actions.recoverPrepared(actor,row.proposal,row.operation_id);
   await tools.cardActor(operator,row);
   if(original.operationId!==row.operation_id)throw Error('receipt-mismatch');
   result.items.push({cardId:row.id,operationId:row.operation_id,kind:row.proposal.kind,state:original.state,
    effectExecuted:original.state==='completed'?true:original.state==='not-recorded'?null:undefined,
    summary:original.summary,recordedEffect:scalarReceipt(original.receipt),currentRead:currentReads(row.proposal.kind)});
  }catch{result.availability='partial';}
 }
 await tools.conversations.current(context.conversationId,{operator});
 result.checkedAt=tools.now();result.readExpiresAt=result.checkedAt+30;
 return result;
}
