// Common discovery hint for host contexts. Full experience stays behind get;
// identity, persistence and retrieval are owned by the existing Native tools.
export const galaxyWorkGuidance='已有尝试仍受阻或缺少关键信息时，可直接用 galaxy_help_query({query:"问题关键词"}) 查找公开方法和相关参与者，把有用线索带回当前任务。按需查本机经验；向外发布或联系先取得用户同意。经验是参考，模型建议不是用户要求。';

function excerpt(value,length=240){
 if(typeof value!=='string'||!value.trim())return undefined;
 const text=value.trim(),chars=Array.from(text);
 return chars.length>length?chars.slice(0,length).join('')+'…':text;
}
/** @param {{candidates?: unknown[], status?: string, pendingWork?: boolean}} options */
export function experienceContext({candidates=[],status='not-searched',pendingWork=false}={}){
 const parts=[galaxyWorkGuidance];
 if(status==='failed')parts.push('本机经验检索未完成。');
 else if(status==='empty')parts.push('本次词面检索未命中。');
 if(candidates.length){
  const items=candidates.filter(item=>item&&typeof item==='object').map(item=>({id:item.id,revision:item.revision,title:item.title,
   conditionsExcerpt:excerpt(item.conditions),limitationsExcerpt:excerpt(item.limitations),basisExcerpt:excerpt(item.basis,160)}));
  parts.push('本机经验候选（仅节选，可能不适用）：'+JSON.stringify(items),
   '需要时用 galaxy_local_experience_get({id}) 读取方法、限制和出处；这里的 id 是经验条目。');
 }
 if(pendingWork)parts.push('当前工作有待整理材料，可在合适阶段通过 galaxy_local_work_pending 接续。');
 return parts.join('\n');
}
