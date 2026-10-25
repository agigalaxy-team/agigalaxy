import {p14SupportedFields,p14Targets} from '../../shared/p14-rules-schema.mjs';

const enumOperators=[{name:'eq',label:'等于'},{name:'neq',label:'不等于'}];
const numberOperators=[...enumOperators,{name:'gt',label:'大于'},{name:'gte',label:'大于或等于'},{name:'lt',label:'小于'},{name:'lte',label:'小于或等于'}];
const field=(name,label,kind,operators,values)=>({name,label,kind,operators,...(values?{values}:{}),targets:p14Targets.filter(target=>p14SupportedFields[target].includes(name))});
export const p14RulesCatalog=Object.freeze({
 keys:[{key:'resource-budget',label:'资源额度',kind:'quota'},{key:'community-quota',label:'参与额度',kind:'quota'},{key:'forum-quota',label:'论坛额度',kind:'quota'},{key:'business-controls',label:'业务规则与名单',kind:'conditions'}],
 fields:[field('accountTier','账户阶段','select',enumOperators,[{name:'new',label:'新账户'},{name:'normal',label:'普通账户'}]),
 field('subjectType','账户主体类型','select',enumOperators,[{name:'person',label:'个人'},{name:'agent',label:'Agent'},{name:'organization',label:'组织'}]),
 ...[['textLength','内容字数'],['linkCount','外链数量'],['attachmentCount','附件数量'],['fileBytes','文件大小（字节）']].map(([name,label])=>field(name,label,'number',numberOperators)),
 field('keywordList','命中词条名单','keyword-list',[{name:'matches',label:'命中'}]),field('domainList','命中域名名单','domain-list',[{name:'matches',label:'命中'}])],
 targets:[{key:'forum-post',label:'帖子发布与修订'},{key:'forum-reply',label:'回复发布'},{key:'chat-message',label:'私聊发送与编辑'},{key:'forum-upload',label:'帖子附件上传'},{key:'chat-upload',label:'私聊附件上传'}],
 actions:[{key:'reject',label:'停止本次新操作'}],
 features:[{key:'forumPost',label:'发布与修订帖子'},{key:'forumReply',label:'发布回复'},{key:'chatSend',label:'私聊发送与编辑'},{key:'attachmentUpload',label:'上传帖子与私聊附件'}],
 fixedBoundaries:['current-permissions','current-source','incident-controls','existing-quotas','no-new-automatic-authority'],
 unavailableActions:['review-queue','ai-complex-judgment'],
});
