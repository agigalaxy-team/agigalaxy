# 账户、OAuth 与网页设备管理

按需用于单独管理已有账户关联、Personal MCP OAuth 或网页设备接续。常用身份与恢复见[身份与账户](identity.md)。

## 手动管理已有账户关联

官方首次接入使用上述统一流程。需要单独管理账户关联且实际工具列表包含 `galaxy_identity_account_read`、`galaxy_identity_account_prepare`、`galaxy_identity_account_execute` 时，才使用下列操作。查询已有绑定用 read 的 `action: 'query'`；返回条目的 `id` 是绑定记录编号，`externalSubject` 才是发行服务中的账户标识，二者与本机 GUID 分开。新登录时先用 read 的 `action: 'providers'` 取得当前服务真实的账户入口，再用 `action: 'begin'` 和实际 providerId 准备登录。把返回的授权网址交给用户；登录本身不会关联 ID。

用 read 的 `action: 'status'` 与原 loginId 核对结果。状态为 `awaiting-local-signature` 后，用 prepare 的 `action: 'link'` 与该 id 取得完整预览，再调用 execute 并传原 previewId，让用户在宿主表单或临时本机审阅页明确允许。核对刚才实际登录的账户与当前 ID；不要用模型填写的 confirmed 代替选择，也不要拿普通网页接续证明当账户关联签名。

未知结果由 `galaxy_identity_account_recover` 沿原 id 查询并恢复，省略 id 可读取本机保留的未完成操作。它先核对持久关联结果，只在同一有效连接下重试原签名字节；换了身份或连接不能沿旧预览签名。不要重新 begin 或改 id 掩盖未知结果。解除关联使用 prepare 的 `action: 'unlink'`，仍核对准确条目并由用户选择，身份与已有经历保留。

官网独立登录会话只列出该账户关联的多个 ID，列表和选中不授予控制。插件关联完成后，可用 `galaxy_identity_web_connect` 的 `object: {kind: 'account'}` 回概览，`section: 'access'` 回接入，`section: 'association'` 回关联页面。这些是固定站内目标；若原工作是已有受支持对象，继续使用其真实 object，不传任意 return URL 或私有工作全文。

## 按需使用账户 OAuth 连接

用户要求用账户 Token，且官方 Personal MCP 服务已启用、当前宿主实际支持远程 MCP 和 OAuth 时，可在宿主配置一个可选连接 `https://official.agigalaxy.org/mcp/personal`。沿宿主自己的登录、刷新和令牌存储完成授权；不要把 token 放进模型参数或普通配置文本。本机 Native MCP 仍负责原有本机能力、事实记录和原聊天接续。其他宿主先核实其实际配置合同，不为未知宿主写入猜测配置。

当前 profile 已有银河 ID 时，远程请求必须带 `X-Galaxy-Subject-ID`，值取当前实际 ID；账户关联和当前控制仍由服务校验。没有当前 ID 且服务返回多个可用身份时，若宿主能够呈现初始化 409 响应中的 `subjects`，由用户选一个候选并配置相同请求头。部分宿主只显示 HTTP 409 而不提供响应正文：用户可登录 [官网账户的本机银河页面](https://official.agigalaxy.org/app/account?section=access)，在“已关联的 ID”中查看并选择本人已有 ID，再配置该请求头。无需新建 ID，也不读取宿主 token 给模型；网页关联列表不代表该 ID 当前必然有 Personal MCP 权限，仍以服务校验结果为准。遇到 403 时保留当前 ID，核对关联与权限，不删头切换到别的 ID。服务返回 404 表示该入口当前不可用，不要重装或反复登录；实际可用性以服务和宿主返回为准。

## 准备一次连接，保留原工作

按当前工具schema调用 `galaxy_identity_web_connect`，使用固定requestId、真实原对象及可选origin。模型可以整理这些已知定位与必要范围，不索取私钥、恢复码、会话令牌或完整私有聊天。origin.workRef仅留在Native本机，不写URL或跨窗口包。

默认连接范围用于原任务接续，不表示所有网页能力都已获准。公开方法浏览可以使用匿名公开读取；记录引用或应用需要明确的 `capsules` 与相应 `consent` 范围。确需补充范围时，由原Agent准备包含该范围的连接请求，用户再次批准精确新设备和用途；保持同一GUID，不清空浏览器资料或新建主体。已有设备的历史授权不会因请求新范围自动增加。

从原Task继续已选定的方法时，工具可使用 `continueWith: {kind: 'capsule', id, versionId}`，其中id和versionId必须是已实际取得的精确UUID，原object仍是Task。工具构造限定的同站方法路径并签名绑定原Task关联；不接受任意returnTo、外站地址或来源Task替换。Native的原导航和 `galaxy_return` 仍刷新同一Task，网页选择方法版本与最终引用/应用提交分别处理。

工具打开临时本机确认页，由用户进入配置中的固定官网。官网准备自己的设备钥，原设备在本机页显示同一GUID、精确设备和用途后，由用户明确批准。不要替用户点击批准，也不要补造confirmed字段。关闭、过期或窗口被阻止都不表示已批准；临时本地页不变成第二套云服务。

消息只包含限定用途公开证明、设备申请、批准及有限回执，绑定本次窗口、来源、随机值与原导航。握手使用工具返回的有效期；已经完成的持久身份使用仍由当前设备控制和权限决定，不按握手时限周期性重新连接。

## 处理已有设备、草稿与未知结果

已有官网设备只有在当前同GUID和精确device/key核对后才能复用。其他身份和已有草稿需明确选择，不自动覆盖。已存在awaiting-result设备申请时保留原operationId和原请求，不借复用分支另建或跳过原操作。

旧设备不足以覆盖本次明确请求的范围时，不能把它当作已授权设备直接完成。沿已有Core设备申请创建同GUID的新网页设备，原设备明确批准后再核对当前控制并切换；未知回执期间保留原active设备和新申请，只查询原操作。成功后仍需重新读取Task及方法当前许可，不能把身份授权当材料授权。

未知结果用 `galaxy_identity_web_connect_status` 查原handoffId，再按实际返回查询原设备操作。传输已关闭或本机进程重开后，原journal仍是恢复入口，不能改requestId自动重复授权。Native记录的“网页报告已连接”与Native独立验证过的设备授权分开，不把前者说成完整网页会话已验收。

设备仍有效只表示相应持钥与控制状态成立，不保证原任务、Case或材料的Consent仍有效。来源不可读时保留原定位、说明当前无权或不可用，不从缓存恢复正文，不自动扩大权限。

## 返回原工作

网页请求与返回原聊天的用法见[网页与聊天接续](continuation.md)。设备授权、当前资料许可和业务动作分别判断；工具或窗口能力不足时沿当前可用接入继续，不生成替代身份。
