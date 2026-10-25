// A fixed server catalog, not an expression language or a client supplied ACL.
const groups = [
 ['workbench','工作台',[['read','读取工作台']]],
 ['accounts','业务账户',[['read','读取账户资料'],['identity.read','读取邮件身份资料',true],['type.change','修改主体类型',false,true],['restriction.apply','限制参与'],['restriction.release','解除参与限制'],
  ['registered.read','读取注册用户目录'],['password.reset','发送用户密码重置邮件',false,true],['login.disable','停用用户登录',false,true],['login.restore','恢复用户登录',false,true],['sessions.revoke','撤销用户会话',false,true],['profile.correct','更正用户资料',false,true]]],
 ['management.accounts','管理账户',[
  ['read','读取管理账户',true,false,'读取独立管理身份域的账户、当前资格和获准角色来源，不开放账户修改。'],
  ['create','创建管理账户',true,true,'由人工创建管理账户并设置首次必须修改的临时密码；不能创建或授予根管理员资格。'],
  ['profile.write','修改管理账户资料',true,true,'由人工修改获准的管理资料；新登录邮箱须完成验证，根管理员按独立安全规则保护。'],
  ['login.disable','停用管理账户登录',true,true,'由人工停用获准目标的后台登录，并按真实结果处理现有会话。'],
  ['login.restore','恢复管理账户登录',true,true,'由人工恢复获准目标的后台登录；不恢复已撤回的业务角色或其他授权。'],
  ['password.reset','重置管理账户临时密码',true,true,'由人工设置首次必须修改的临时密码；密码不返回目录、审计或操作回执。'],
  ['sessions.revoke','撤销管理账户会话',true,true,'由人工撤销获准目标的管理会话，不影响网站用户身份域。'],
  ['delete','删除管理账户登录身份',true,true,'由人工删除获准目标的管理登录身份；保留真实历史主体及审计关联。']]],
 ['ai.use','工作台 AI 使用',[
  ['overview','使用总控 AI',false,true,'允许本人使用总控岗位，不增加业务资料读取或自动执行权限。'],
  ['governance','使用治理 AI',false,true,'允许本人使用治理岗位，不增加业务资料读取或自动执行权限。'],
  ['messaging','使用消息 AI',false,true,'允许本人使用消息岗位，不增加业务资料读取或自动执行权限。'],
  ['discovery','使用数据与发现 AI',false,true,'允许本人使用数据与发现岗位，不增加业务资料读取或自动执行权限。'],
  ['maintenance','使用运维 AI',false,true,'允许本人使用运维岗位，不增加业务资料读取或自动执行权限。']]],
 ['ai.accounts','AI 工作账户',[
  ['read','读取 AI 工作账户',true,true,'由人工读取五个稳定 AI 工作身份及其当前业务角色、授权来源和运行关联，不提供登录凭据或继承人员权限。'],
  ['profile.write','修改 AI 工作账户资料',false,true,'由人工修改已有 AI 工作账户的名称与职责说明，不改变稳定身份、模型或业务授权。'],
  ['state.write','启停 AI 工作账户',false,true,'由人工启用或停用已有 AI 工作账户；启用不自动分配业务角色或执行授权。'],
  ['roles.write','分配 AI 工作账户角色',true,true,'由人工在当前可授范围内分配或撤回已有业务角色，AI 权限不超过当前岗位、动作及执行授权的交集。']]],
 ['ai.roles','AI 专用角色委派',[
  ['read','读取获准 AI 专用角色',true,false,'只读取当前人工委派范围内的 AI 专用角色和目标岗位，仍须实际角色读取权限。'],
  ['create','创建获准 AI 专用角色',true,false,'仅在人工指定目标及可授上限内创建 AI 专用角色，不增加自身权限。'],
  ['update','修改获准 AI 专用角色',true,false,'仅修改当前委派范围内的 AI 专用角色；共享角色与自身使用角色不允许修改。'],
  ['assign','分配获准 AI 专用角色',true,false,'只给人工指定的其他 AI 分配上限内的 AI 专用角色，不给管理人员赋权。'],
  ['revoke','撤回获准 AI 专用角色',true,false,'只撤回当前委派范围内其他 AI 的 AI 专用角色分配。']]],
 ['ai.delegation','AI 角色管理范围',[
  ['read','读取 AI 角色管理范围',true,true],
  ['configure','设置 AI 角色管理范围',true,true,'由人工明确总控可管理的其他 AI、可授予权限上限和允许动作，不自动启用值守。']]],
 ['analytics','账户汇总',[['read','读取账户汇总']]],
 ['autonomy','自动运行',[
  ['read','读取自动运行与共同任务',true],
  ['configure','配置岗位值守与提示词',true,true],
  ['control','启停、接管或接续共同任务',true,true]]],
 ['sections','版块',[['read','读取版块'],['classify','分类版块'],['hide','下架版块'],['restore','恢复版块']]],
 ['content','公开内容',[['read','读取公开内容'],['hide','下架内容'],['restore','恢复内容'],['curate','编排内容'],['batch.hide','批量下架'],['batch.restore','批量恢复'],['tags.read','读取标签'],['tags.manage','维护标签']]],
 ['recommendations','推荐运营',[['read','读取推荐运营'],['configure','调整推荐方向与主题映射']]],
 ['cases','公开举报申诉',[['read','读取举报申诉'],['resolve','复核举报申诉']]],
 ['chat-reports','私聊案件',[['read','读取案件元数据',true],['materials.read','读取明确选入材料',true],['attachments.read','读取选入附件',true],['moderate','处理案件',true]]],
 ['chat-messages','私聊单消息',[['hide','屏蔽选入消息',true],['restore','恢复本案屏蔽',true],['keep','维持本案屏蔽',true]]],
 ['resources','项目与方法',[['read','读取资源'],['hide','下架资源'],['restore','恢复资源']]],
 ['files','文件处理',[['read','读取文件元数据',true],['scan.retry','重排扫描'],['access.stop','停止单个文件访问',true],['access.restore','解除单个文件访问停止',true],['cleanup.plan','准备或取消具体文件清理计划',true,true],['cleanup.approve','批准具体文件清理计划',true,true]]],
 ['feedback','用户反馈',[['read','读取反馈',true],['attachments.read','读取反馈附件',true],['update','处理反馈']]],
 ['notices','公告与系统邮件',[['read','读取公告'],['create','创建草稿'],['update','编辑草稿'],['publish','发布公告'],['withdraw','撤回公告']]],
 ['smtp','发信配置',[['read','读取发信配置',true],['configure','维护发信配置',true,true],['test.connection','测试发信连接',true,true],['test.delivery','测试发信提交',true,true]]],
 ['rules','业务规则',[['read','读取规则'],['write','修改规则',false,true]]],
 ['strategies','目标与策略',[['read','读取目标与策略'],['configure','保存目标与策略草稿',false,true],['publish','发布目标与策略',false,true],['run','启动或继续获准策略事项',false,true],['control','暂停或恢复策略执行',false,true],['ordinary.configure','在明确范围内修改普通策略'],['ordinary.publish','在明确范围内发布普通策略']]],
 ['audit','业务审计',[['read','读取审计元数据']]],
 ['jobs','任务队列',[['read','读取任务'],['cancel','取消任务'],['retry','重试任务']]],
 ['search','搜索处理',[['read','读取搜索状态'],['retry','重试索引']]],
 ['search-quality','搜索质量',[['read','读取搜索质量',true],['configure','保存搜索草稿'],['publish','应用搜索配置'],['restore','恢复搜索配置']]],
 ['maintenance','整站维护',[['read','读取运行与备份',true],['logs.read','读取故障日志',true],['backups.create','创建整站备份',false,true],['backups.verify','检查备份点',false,true],['restore.plan','准备或取消恢复方案',false,true],['restore.approve','批准具体恢复方案',false,true],['restore.execute','执行获准恢复方案',false,true]]],
 ['system.settings','系统设置',[
  ['read','读取系统设置',true,true,'由人工读取常规设置、邮件和业务服务的非秘密配置与实际生效状态，不返回凭据。'],
  ['configure','修改系统设置',true,true,'由人工编辑已纳入的常规、邮件及业务服务配置草稿，不自动授予应用或凭据维护权限。'],
  ['test','测试服务连接',true,true,'由人工测试已保存的固定连接；不调用模型供应商或代替实际配置应用。'],
  ['apply','应用系统设置',true,true,'由人工应用已保存的常规、邮件和业务服务配置，按真实采用结果记录。'],
  ['credentials.write','更新服务凭据',true,true,'由人工向受保护主机更新已纳入服务的凭据；原值不返回页面、版本或审计。']]],
 ['models','人工模型设置',[['read','读取模型设置与基础用量',true,true],['configure','保存模型与场景草稿',true,true],['apply','应用模型与场景设置',true,true]]],
 ['retention','保留与清理',[['read','读取保留记录'],['request','提交既有清理计划',false,true]]],
 ['cms','站点内容',[['read','读取站点内容'],['edit','编辑站点草稿'],['publish','发布站点',false,true]]],
 ['permissions','管理授权',[['read','读取业务授权'],['roles.write','维护业务角色',false,true],['assignments.write','授予和撤销人员角色',false,true],['automation.write','维护自动执行授权',false,true]]],
];
export const operationsPermissionCatalog=Object.freeze(groups.flatMap(([group,groupLabel,actions])=>actions.map(([action,label,sensitive=false,humanOnly=false,description=''])=>Object.freeze({code:group+'.'+action,label,group,groupLabel,sensitive,humanOnly,...(description?{description}:{})}))));
export const operationsPermissionCodes=Object.freeze(operationsPermissionCatalog.map(item=>item.code));
const codes=new Set(operationsPermissionCodes);
export const isOperationsPermission=code=>codes.has(code);
// This helper is only for response capabilities. Enforcement always reloads PG.
export const hasOperationsPermission=(actor,code)=>actor?.businessAuthorization?.permissions?.includes(code)===true;
const fixed={
 'operations-summary-read':'workbench.read','users-query':'accounts.read','user-read':'accounts.read','audit-read':'audit.read',
 'restriction-set':'accounts.restriction.apply','restriction-release':'accounts.restriction.release','type-change':'accounts.type.change',
 'registered-user-password-reset':'accounts.password.reset','registered-user-login-disable':'accounts.login.disable','registered-user-login-restore':'accounts.login.restore',
 'registered-user-sessions-revoke':'accounts.sessions.revoke','registered-user-profile-correct':'accounts.profile.correct','registered-user-profile-preset':'accounts.profile.correct',
 'management-account-create':'management.accounts.create','management-account-profile-update':'management.accounts.profile.write',
 'management-account-login-disable':'management.accounts.login.disable','management-account-login-restore':'management.accounts.login.restore',
 'management-account-password-reset':'management.accounts.password.reset','management-account-sessions-revoke':'management.accounts.sessions.revoke','management-account-delete':'management.accounts.delete',
 // Admission changes additionally require the current fixed root identity in
 // the management service; this read gate is not a grantable promotion action.
 'management-account-admission-change':'management.accounts.read','management-account-email-change':'management.accounts.profile.write',
 'ai-work-profile-save':'ai.accounts.profile.write','ai-work-state-save':'ai.accounts.state.write','ai-work-assignment-save':'ai.accounts.roles.write',
 'system-settings-save':'system.settings.configure','system-settings-test':'system.settings.test',
 'system-settings-apply':'system.settings.apply','system-settings-credential-provision':'system.settings.credentials.write',
 'community-posts-query':'content.read','community-post-read':'content.read','community-sections-query':'sections.read','community-section-read':'sections.read',
 'community-section-classify':'sections.classify','community-reports-query':'cases.read','community-report-read':'cases.read','community-report-resolve':'cases.resolve',
 'community-content-query':'content.read','community-content-read':'content.read','community-content-curation':'content.curate','community-content-batch-preview':'content.read',
 'community-tags-query':'content.tags.read','community-tag-create':'content.tags.manage','community-tag-update':'content.tags.manage',
 'resources-query':'resources.read','resource-read':'resources.read','files-query':'files.read','file-read':'files.read','file-retry':'files.scan.retry',
 'file-cleanup-read':'files.read','file-cleanup-create':'files.cleanup.plan','file-cleanup-cancel':'files.cleanup.plan','file-cleanup-approve':'files.cleanup.approve',
 'file-access-read':'files.read','file-access-stop':'files.access.stop','file-access-restore':'files.access.restore',
 'feedback-query':'feedback.read','feedback-read':'feedback.read','feedback-update':'feedback.update',
 'rule-save':'rules.write','notice-create':'notices.create','notice-save':'notices.update','notice-publish':'notices.publish','notice-withdraw':'notices.withdraw',
 'notice-delivery':'notices.publish','retention-request':'retention.request','retention-complete':'retention.request','retention-failed':'retention.request',
 'smtp-query':'smtp.read','smtp-config-save':'smtp.configure','smtp-connection-test':'smtp.test.connection','smtp-delivery-test':'smtp.test.delivery','smtp-dns-check':'smtp.read',
 'chat-reports-query':'chat-reports.read','chat-report-read':'chat-reports.read','chat-report-attachment':'chat-reports.attachments.read',
 'job-cancel':'jobs.cancel','job-retry':'jobs.retry','search-retry':'search.retry',
};
export function operationActionPermissions(action,selection={}){
 if(isOperationsPermission(action))return [action];
 if(action==='community-section-visibility')return ['sections.'+(selection.kind==='restore'?'restore':'hide')];
 if(action==='resource-visibility')return ['resources.'+(selection.command?.kind==='restore'?'restore':'hide')];
 if(action==='community-content-visibility')return ['content.'+(selection.kind==='restore'?'restore':'hide')];
 if(action==='community-content-batch-visibility')return ['content.batch.'+(selection.kind==='restore'?'restore':'hide')];
 if(action==='community-content-batch-preview')return ['content.read','content.batch.'+(selection.kind==='restore'?'restore':'hide')];
 if(action==='chat-report-event')return [selection.kind==='message-hide'?'chat-messages.hide':selection.kind==='message-restore'?'chat-messages.restore':selection.kind==='message-keep'?'chat-messages.keep':'chat-reports.moderate'];
 if(action==='users-query'&&selection.view==='directory-summary'||action==='user-read'&&selection.view==='usage-summary')return ['analytics.read'];
 return fixed[action]?[fixed[action]]:[];
}
