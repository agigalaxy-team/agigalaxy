# 系统设置：范围、真实配置来源与部署

本模块按用户已确认的 B 方案组织为四个固定页签：常规设置、邮件服务、服务接入、高级设置。模型、业务规则、额度及数据策略仍由原业务页面管理。登录服务器、数据库、域名和证书不在此页面编辑。

2026-10-24 批次记录的 API71/Admin55/Web75 是历史观察，当前发行边界见[项目状态](project-status.md)。常规设置已经实际保存、由原publisher任务完成发布、前台回读并恢复原品牌文案和页尾链接；这项结果不代表三用途邮件及五服务的新配置都已逐一采用。Logo/favicon更换仍未接。

初次接入的历史快照（2026-10-24 12:04Z）：API0.1.64/schema124、管理端0.1.47、网站软件基底0.1.70。正常运行与AI测试清理证据在项目 `07-logs/development/admin-implementation-20261024-settings-review/system-settings/deployment/live-system-120402.json`。这是当时的回读，不代替之后的状态检查。管理页面为 `/admin/operations/system-settings`。

## 页面与权限

常规设置使用原 Payload `SiteSettings` 真源；没有第二份品牌库。当前可编辑网站标题、说明和底部链接。已确认 logo/favicon 的展示来源，但本版仍为只读，未接上传、更换或跨客户端品牌同步。不能将页面显示正式图标理解为更换功能已完成。

邮件服务把运营邮件、注册与密码邮件、运行告警的连接统一呈现，允许共用连接或分别指定。NULL 绑定表示沿用现有来源，不表示停用。五类发件身份、Reply-To、正文模板、收件人和认证流程仍由原合同约束。旧 SMTP 的身份、DNS、队列、测试与记录仍走原接口及权限；未取得这些权限只影响对应分区。

服务接入覆盖 OpenPanel 分析、Gorse 推荐、Meilisearch 搜索、Agno 执行、ClamAV 扫描。高级设置编辑同一个邮件配置中的实际超时、并发、速率和 DKIM selector，不新建参数库、不引入模型温度或预算管理。

System 的五项人工专有权限为：`system.settings.read/configure/test/apply/credentials.write`。保留初次路由检查和事务内当前权限复核。原 CMS/SMTP URL 兼容保留，不给缺新 System 权限的旧角色强行重定向，也不自动扩大既有角色或 AI 账户权限。

## 保存、测试与采用

保存产生不可变版本与 CAS revision；测试和应用引用已保存的具体版本。每次操作绑定原 operationId、操作者及原输入。请求失败或响应丢失后只能读取原结果，不能自动换编号重放。凭据值只写主机保护存储，PG、浏览器草稿、日志和公开回执只保引用与元数据。

保存成功不等于生效。运营邮件及五服务的采用要求当前 PID、同一版本和实际构造的消费者连接回执匹配。健康正常、JSON 已写或主机响应成功都不能代替采用证明。第一次接入之前的原有来源显示 observed/unknown，不伪称已由 System 应用。认证与告警则回读原生实际配置。

General 仅替换正式 publication 的 settings，保留 pages/media，并校验发布基底。基底变化返回可理解的“官网内容已有更新，请读取后应用”，保留草稿，不无限重试。旧 NULL 基底的既有发布路径不被新逻辑改写。

## AI-agent 部署与配置发现

先按[部署说明](deployment.md)确认本次环境、准确发行和受保护配置来源。下列路径来自 2026-10-24 的运维记录；新安装必须显式配置自己的路径与权限，不从历史地址或旧日志猜配置，也不把文件路径开放为页面任意参数。

- API/worker：`/etc/galaxy/pilot/{api,worker}.env`。两端显式设置 `GALAXY_SERVICE_CONNECTIONS_METADATA_FILE`、`GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE` 与 `GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE`。
- 原生维护：`/etc/galaxy/maintenance/service.env` 与 `agent.json`；同一 UDS/HMAC 执行通道，不创建新 daemon、端口或 worker 维护密钥。System 控制文件为 `/etc/galaxy/system-settings/control.json`，root0600；凭据和执行日志为 root 私有。
- 运营邮件 API catalog：`/etc/galaxy/operations-pilot/system-mail-api.json`，root:API组0640。
- 运营邮件 worker catalog：`/etc/galaxy/system-settings-consumers/mail-worker.json`，root:worker组0640，父目录root0755。原 `/etc/galaxy/operations-pilot` 保持原0750，不把 worker 加入管理组。
- 服务连接的永久源、两端固定采用文件、原生 SMTP 来源见项目同批 `backend/DEPLOYMENT.md` 及 `service-connections-deployment-successor/DEPLOYMENT_PLAN.md`。不要覆写 `/run/credentials` 的运行副本。

历史批次先冻结源码与资源，再安装 API 依赖、构建管理端；当时 API schema124 排除暂停的120。当前源码注册到131，120仍未注册；不得从本文旧版号推导可跳过后续迁移。CMS 还须执行 `20261024_110000_system_settings_general`，仅扩原 SiteSettings/versions 元数据列。真实维护入口必须含新 System 可选分支，并保留原 model/maintenance 分支和生产恢复边界。固定源原子替换需要其父目录的受限 `ReadWritePaths`。

管理端独立安装需要显式 Zod4.5.4。Next alias 不影响 Payload 原生配置 CLI；部署器把同一发行内已声明安装的 app Zod 以受限相对链接放到仓库解析层，验证版本及目标仍在该发行内。不要复制另一份合同或在 admin 安装全后端依赖。

部署后一次性回读版本、五服务 active/running、API readiness、CMS migration与正式 publication 保留；然后用实际 API OS 身份读取原生 UDS，最后以 normal OIDC 的独立 Headless Chromium操作四页签。不能使用用户个人浏览器、导出 storageState，或记录密码、密钥、cookie与 SMTP 原值。

## 已保留的真实失败与限制

首次管理45构建暴露原生 CLI 找不到共享 Zod，补齐同发行解析层后，Next 编译又发现类型/数值转换问题；失败45保留，三个受影响源修正后46完整构建与类型检查通过。首次 API64批次 worker启动失败为目录不可遍历，保留原错误并迁移该 worker 文件引用，未放宽管理目录权限。该批12:04Z快照最终五服务均 active/running、NRestarts0/ExecMainStatus0；并非当前长期可用率或本轮重新检查。

初批原生回读证明当时现有邮件和五服务来源可读，不代表已应用一个新的 System 版本，也不代表 SMTP 发信送达。分析写入认证和 AI 执行签名没有在只读连接检查中被触发，明确保留“未测试”。Logo/favicon更换、跨端品牌采用、未定文件缓存期限/容量及外部 Agent 代行管理员 API，不能由本模块实施状态推定完成。

管理47进一步修正身份列表的邮箱拆尾和来信状态归属，1366/1920真实无头显示检查通过。AI未知操作增加明确人工重试：只在完整原body仍在、同身份和CSRF有效、原GET新鲜not-recorded、当前权限及所有原版本仍一致时显示；点击重新核原回执和当前资料，再以原ID/body提交一次。自动链仍只GET，locator-only不得重构body。四个必要React场景通过；没有在生产制造500或以此声称真实故障重试已运行。

源码同步已把94处已审增量及47的三处UI尾写入主项目，写前核对全部原件/应缺失条件，保留账户文档与四个在途维护文件；权限两文件保留原有“从角色复制到草稿”的控件，并采用新AI账户绑定/根身份合同。该主目录仍保留未部署候选，不能整树拿来冒充64/47发行。该64/47批次的精确冻结源为 `05-build/deployment-candidates/admin-system-settings-final-20261024`，最终 `CAPTURE.json` 记录当时来源；当前71/55沿experience-batch7冻结源及成功激活回执，不以旧CAPTURE代替当前发行。部署和维护不得从主目录自动带入暂停120或未来生产恢复功能。
