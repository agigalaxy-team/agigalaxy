// Common discovery hint for host contexts. Full experience stays behind get;
// identity, persistence and retrieval are owned by the existing Native tools.
export const galaxyWorkGuidance='银河可为当前工作提供本机经验、资料和外部帮助。尝试后仍受阻时可自主求助；已有请求或房间可读取回应后继续。按需使用 galaxy Skill，不改变原任务。经验是参考，模型建议不是用户要求；外发沿当前授权办理。';

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
