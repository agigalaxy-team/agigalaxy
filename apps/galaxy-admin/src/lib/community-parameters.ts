export const communityParameterKind='community-parameter-adjustment';
const staleProposal='配置已有更新，请按当前版本重新拟定。';
export const communityParameterErrors={
  operations_agentos_review_changed:staleProposal,
  community_growth_version_conflict:staleProposal,
  recommendation_policy_changed:staleProposal,
};
export const communityParameterAreas={
  growth:'账户成长',
  'content-score':'帖子评分',
  recommendation:'推荐排序',
} as const;
export type CommunityParameterArea=keyof typeof communityParameterAreas;
export type CommunityParameterReceipt={operationId:string;version:number;area:CommunityParameterArea;scope:string};
export type CommunityParameterProposal={
  kind:typeof communityParameterKind;
  operationId:string;
  callId:string;
  area:CommunityParameterArea;
  scope:string;
  title:string;
  target:{label:string};
  canApprove:boolean;
  changes:{label:string;before:string|null;after:string|null}[];
  basis:{label:string;value:string}[];
  impact:string[];
  decision:'approved'|'rejected'|'cancelled'|'no-action'|null;
  receipt:CommunityParameterReceipt|null;
};

export function readCommunityParameterReceipt(value:unknown,operationId:string):CommunityParameterReceipt|null{
  if(!value||typeof value!=='object')return null;
  const receipt=value as Partial<CommunityParameterReceipt>;
  if(receipt.operationId!==operationId||typeof receipt.area!=='string'||!Object.hasOwn(communityParameterAreas,receipt.area)
    ||typeof receipt.scope!=='string'||!receipt.scope||typeof receipt.version!=='number'||!Number.isSafeInteger(receipt.version)||receipt.version<1)return null;
  return {operationId,version:receipt.version,area:receipt.area,scope:receipt.scope};
}
