# 人类管理账户与AI工作账户

本模块复用独立Keycloak管理域、原业务角色与审计、Agno执行链；不建立另一套密码系统或外部Agent代行凭据。生产版本与真实验收结果以项目07-logs内相应发布记录为准。

## 身份、角色与执行

- 网站用户与人类管理账户属于不同认证目录。管理账户不开放注册；管理员设置临时密码，首次登录必须修改。管理域的邮箱可选，未填写时不能被原生资料补全强制阻断；填写时仍保留原生邮箱格式和长度验证。
- 根管理员由启动前受保护文件固定管理issuer、subject和不可变operatorId。邮箱变更不改变身份和权限；禁止后台新建、删除、停用或替换根资格。其他管理员资格仅由根提升或撤销。
- 管理账户维护要求根或当前被提升管理员资格，并有对应业务权限；普通账户误获维护code也不生效。业务角色不会把原生准入资格变成根权限。
- AI岗位是五个稳定业务主体，没有人类密码、邮箱或登录会话。初始化仅建身份，不预置角色、关联或自动授权。岗位启用允许获准人员进行普通文字沟通，不代表可读业务数据。
- AI取数和人工操作卡采用当前真人权限与当前岗位角色的交集。业务摘要在业务SQL前即受约束；直接查询、来源复核、操作准备与确认均重验。人工指令继续通过具体卡点击办理。
- 无人值守的已有专项执行另查真实岗位、当前角色、原grant、动作和对象范围。绑定编辑沿唯一权限页面，旧NULL不按领域自动补；不因出现账户管理而新增自动业务消费者。
- 新会话和AI执行写真实ai_account_id，旧NULL不复用原生执行或操作卡。角色撤回、岗位停用与原结果读取区分；已提交效果按原operationId查询，不重复提交。

## 邮箱验证

管理邮箱变更先提交原生验证邮件，旧邮箱保留；只有原生UpdateEmailActionTokenHandler验证成功才替换，同一subject和角色保持。submitted表示提交，不表示送达或验证完成。未知结果不自动重发。

Node仅通过受保护内部writer调用固定management realm的新原生路由。Keycloak26.7.3需在build阶段启用update-email feature；不为此启用整个realm的verifyEmail或UPDATE_EMAIL required action。原注册、重置密码与品牌模板保留。

## AI部署助手说明

1. 先查项目当前发行、服务、受保护配置引用及精确源码manifest，不从本文猜现网版本。历史未批准的schema120不应并入本批。
2. operations配置新增rootOperatorFile及managementAccounts.writerCredentialFile；读、业务写、管理写客户端分离，writer不注入worker或前端。秘密只在受保护主机进程消费，不能写入工作区、日志、URL或报告。
3. 使用与选定源码相同的release generator、迁移registry和SQL角色。schema122是人类管理目录/账本；schema123是AI主体、独立角色关联及不可变会话/执行绑定。禁止通过GET或服务构造偷偷建岗位。
4. 五岗位身份由部署上下文明确写入实际endpoint，version与authorization_version从1开始；角色和关联数必须为0。之后的角色分配通过真实业务命令办理，不能直接SQL制造人工授权历史。
5. 构造同一OperationsAiWorkAccountsService实例，注入P13StrategiesAuthority.aiWorkAccounts、OperationsPermissionsService.aiWorkAccounts及HTTP路由。唯一绑定编辑器接通后才启用其入口；不得混入已搁置的ai_domains方案。
6. Native provider升级前核旧image、compose散列及旧验证码JAR只读mount。优化索引的毫秒mtime必须与实际挂载文件一致；仅导出镜像文件的纳秒值不能替代实际mounted检查。保留私有checkpoint，单服务切换后核ready、专用writer capability及未鉴权拒绝。
7. 先核服务和目录源，再用独立Headless正常OIDC操作真实页面。新建仅使用明确合成账户；保留原ID和目标，未知结果只GET。不得重置根或收养同名现有人；测试密码仅在进程内使用。
8. 真实验证应包含空选择首次渲染、查询分页、角色来源和分配撤回、临时密码首次登录、当前停用/会话撤销、AI零角色与晚撤权。只有一页时明确多页未覆盖；本地Native/模型替身不构成实际投递或模型验收。
9. 前端只使用shared内的纯能力合同，不能从服务端校验schema导入而隐式引入后端依赖。五岗位能力清单由operations-ai-work-capabilities单处定义，服务端schema重导出同一合同。
