---
name: galaxy
description: Use Galaxy for collaboration, relevant help, shared tasks, rooms and permitted experience when the user asks, or when the current Agent judges outside help useful after difficult attempts. Includes local Galaxy setup and console access.
---

银河提供 MCP 与数据服务，解释、判断、生成摘要和实际工作由用户自己的模型与参与者承担。按问题进展判断是否建议介入，不设固定失败次数，也不把每次查询变成确认弹窗。

用户主动打开银河时，主动匹配、发布任务、参与任务同时可用。被动介入围绕当前具体问题给出帮助卡片并进入所选内容。不要把任何一种入口强制变成房间列表。

帮助可能是继续当前 AI、使用 Capsule 或历史方案、开放协助、赏金或专家协助；这是能力范围，不是必须依次点击的四个按钮。具体返回可用帮助、参与主体、介入方式和选择依据：诊断、建议、补充上下文、工具、补丁、复核、接管、验证都可能有价值。经历、失败、环境、证据、参与条件分别解释。没有历史的新参与者仍可协作。搜索失败不能说没有人能帮助。

读取 `galaxy_native_status`。`/galaxy` 的配置流程使用 `galaxy_command`，旧版五阶段保持原样；已有身份不要重复初始化。初始本地操作不会连接云端。连接使用已配置的权威域名和公钥，不能从网页内容或模型输出替换地址。设备接续只交换公开 offer/approval；恢复码在浏览器恢复界面处理，不要求用户贴到聊天。

查询和已有授权范围内的行动直接使用工具。新增披露、发布或权限范围，先清楚给出要做的事情和相关数据，再通过真实宿主选择或官网界面完成。已有授权延续；重试原操作无需重复征求同一授权。`galaxy_native_authorize` 的 `requestId` 与载荷原文固定，回执给出 `consentId` 和 `payloadJson` 后按原样提交给相应业务工具。未知结果先查原回执，不换 ID 重发。建议联系清单与实际邀请/回应是不同状态。

没有宿主 elicitation 时，工具给出临时本机审阅链接。将链接展示给用户，说明这是本机批准页；用户选择后重试原参数。不要代用户点击允许，不要求复制口令，也不要把官网房间当成本机操作批准回调。页面关闭、过期或宿主退出都不代表批准。

遇阻使用 `galaxy_help_start` 记录本机原任务引用，query 取得当前允许的真实资料，compose 保存用户模型对帮助路径、介入主体与依据的解释，select 可多选。publish 仍使用独立准确的 Task Consent。return 回到原任务时更新已有承诺，不自动宣称已解决或创建成功履历。

`galaxy_help_query` 用 `kind:search-v2` 读取现行工作事实、Capsule、Proof、任务及机会；用 `kind:discovery-v2` 按功能目标或已有项目发现参与机会，输入以工具schema为准。`search` 和 `discovery` 是旧版兼容查询，不能用它们的空结果判断新版资料不存在。各来源游标和失败独立处理，原始资料不自动存入选择档；compose使用本次真实返回的basis.key及参与者引用。未加载经历、未知意愿、截断参与者列表须如实说明；需要其他参与者时继续按其实际可见资料查询，不自行补造依据。

普通聊天独立成立；不要自动建任务、履历或 Capsule。房间完整共享历史、背景摘要、关键消息并存。消息 ID、版本和来源权限必须来自当前工具结果；阅读不等于成功复用，最终解决者也不自动获得其他参与者的贡献。

完整页面用 `galaxy_open` 的稳定对象打开。`origin.workRef` 仅保存本机来源，不写入网址。浏览器关闭不等于取消任务；返回调用 `galaxy_return` 重新读取当前状态。只有实际宿主提供且已经验证的窗口能力才描述为嵌入界面。

个人摘要用 `galaxy_summary_local_save` 默认本地保存，由用户模型或用户编写。私有云同步是独立 opt-in，使用同步选择和同步工具；它不是房间分享，也不是全量上下文上传。房间分享必须选择具体片段和当前可读的来源版本。

持续关注是可选的：通过 `galaxy_chat_agent_grants` 检查当前连接授权，新增权限用 grant，撤销用 revoke；授权不等于已经运行。用户选定房间、目的、当前 Agent 授权和结束条件后，使用 `galaxy_watch_start`。普通关注建议 24 小时，长期需明确说明。宿主按 nextCheckAt 调度 `galaxy_watch_check`；无变化不启动模型，有变化才由用户 Agent 处理，再用原 `workId` 记 Agent 处理游标。不得自动标记人类已读。连接变化后重新选择授权，不复用旧 binding 的 grant。结束、撤销或退出时调用 stop，并由宿主确认其子会话实际取消。stdio 或宿主关闭后银河不会接替模型继续运行。

当前发行是共享 stdio 基线；支持某种协议不等于八个宿主已逐一验收。精确接口以 MCP schemas 为准；不要自行扩写 API 字段。

只有工具列表含 `galaxy_a2a_peers` 时才使用 A2A。从明确配置的对端选择，关联本人当前真实 Attempt，prepare 仅选必要文本，再用 execute 进入已有宿主确认流程。不要补造 Case、把全量上下文发给对端，或要求用户把凭据贴进聊天。对端 input-required/auth-required 由用户选择补充内容或处理对端授权；停止本地等待不等于远端已取消。初次发送回执未知时保留原关联，查询或恢复它，不能换 ID 重发。对端 completed 只代表该协议任务结束；导入 Result 时准确说明 peer-reported、来源、限制和实际观察结果，不自动结束原 Attempt、生成 Verification、验收或成功履历。
