import { historyRebuildSchema,historyContentHash } from '../shared/history-rebuild.mjs';
import { ServiceError } from '../shared/service-error.mjs';

export function createHistoryRebuild(item,rows,{endpoint,view}){
  if(rows.length!==item.sourceVersion||rows.some((row,index)=>row.version!==index+1)||rows[0]?.kind!=='case'
    ||rows[0]?.id!==item.caseId)throw new ServiceError('history_source_inconsistent',503);
  const ruleVersion=item.moderationContext?4:item.fieldPolicy?3:item.collaborationContext?2:1;
  return historyRebuildSchema.parse({rule:{id:'case-history',version:ruleVersion},endpoint,caseId:item.caseId,sourceVersion:item.sourceVersion,view,
    contentHash:historyContentHash(item,ruleVersion),sources:{events:rows.map(({id,kind,version})=>({id,kind,version})),
      proofIds:item.proofs.map(proof=>proof.proofId),capsuleUseIds:(item.capsuleReuse?.items??[]).map(use=>use.id),
      ...(ruleVersion>=2?{assistanceIds:(item.collaborationContext?.items??[]).map(item=>item.assistanceId)}:{})}});
}
