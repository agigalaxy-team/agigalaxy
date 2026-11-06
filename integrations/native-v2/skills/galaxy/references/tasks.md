# Task 与受控执行

本文件用于已有或拟进行的 Task/Participation、需要提交的协作动作或实际可用的 A2A/Worker。read 可用不代表同组 prepare 或 execute 也可用，按当前工具列表和 schema 选择实际动作。需要发现候选时可读 [查询与原聊天帮助](help.md)；已有准确对象时沿其来源继续，普通聊天不需要造一个 Task。用户自己的模型继续解释和处理原工作。

正式发布、申请或确认承接任务使用Agent中的既有银河身份。需要在官网继续时读[已有身份接官网](identity.md)，保留原对象与草稿，不让用户在浏览器另建一套GUID。普通阅读、草稿和社区表达不附加正式任务条件；设备接续、账号验证和业务确认分别完成。原生工具本已沿当前Native身份工作，不为每次动作重开接续页。

从网页求助接回 AI 的入口见[网页与聊天接续](continuation.md)。使用实际可读的背景与工作结果，保留所选尝试版本、观察、限制和仍缺材料；需要补充材料时沿已有逐接收人共享入口办理。

## 准备准确动作与原回执

从当前真实对象读取 ID、版本、参与者、Scope 与来源权限。阅读资料、推荐某人、选入联系清单、发邀请、接受参与和完成交付分别表示不同事实。发布与联系独立：发布结果未知不猜测是否已发布，也不以联系名单替代已收到邀请的回执。不要补造 Case、Attempt、参与者或收到的回应。

独立求助的准备、预览和发布见[查询与帮助](help.md#发布独立求助)；下面的原回执规则也适用于正式承接和资料授权。

审阅返回的预览，核对动作、收件人、可见范围和材料。调用 execute 只能使用同一预览的精确引用，通过真实宿主选择或本机审阅页；模型的 confirmed 布尔值不是 Consent。改正文、收件人、范围或来源后重做预览，不套用旧确认。普通 MCP 必须给用户足够审阅信息，不能因没有 Apps 而把确认所需内容隐藏。

业务结果 unknown 时先 reconcile 原 ID/hash，不重发或生成新 Consent。仅 prepared 授权过期或服务确认原操作 absent 时，才按实际工具返回重新 prepare 同一业务 ID/字节并取得新的 authorizationRequestId；续授权后的 execute 使用新预览 nonce。unknown 或 ACK 不续签，业务材料期限也不因此延长。ACK 只证明该原操作的历史接受，不能当成当前材料读取、复用或写入权。

同 GUID 重连、binding/device/control 变化后，旧确认不自动用于新连接。保存原定位、明确未知状态，先读当前状态与原回执；无权的旧私文不重显。停止本机重试与远端取消分开，Task、邀请、Context 撤回都调用其真实明确动作。离开页面不取消承诺。

## A2A 对端

按实际工具能力使用 A2A。`galaxy_a2a_peers` 列出现有配置的对端；选定可读 Builder 时，`galaxy_a2a_resolve({builderId})` 可读取实际 AgentCard 并检查当前支持的接口与认证。只有返回可用 peerId 后才沿该对端继续；声明、可读和协议观察本身不证明能力或端点控制。prepare 仅选必要文本，通过 execute 的真实选择发送，不索要聊天中的 token 或携带完整上下文。

对端 input-required/auth-required 由用户选择补充内容或处理对端授权。初次发送回执未知时保留原 association，读取/恢复原操作，不换 ID 重发。停止本地等待不等于远端取消；若要远端取消，按实际协议准备并确认原任务的取消动作。

对端 completed 只代表该协议任务结束。导入 Result 时说明 peer-reported、来源、限制与实际观察，不自动结束原 Attempt、生成 Verification、用户验收或成功履历。

当前工具列表有 `galaxy_a2a_work_read/prepare/execute` 时，按当前工作沿这组目的入口继续。发送可选真实本机工作 `source:{kind:local-work,workId}`、可读原请求 `source:{kind:task,taskId}`，或已有准确 Case/Attempt；具体字段依实际 schema。`galaxy_work_sources` 和 `galaxy_work_read` 可用于读取已有工作。发送、补充、停止和保留结果分别沿真实动作与必要选择，不补造 Case/Attempt。

保留结果使用用户实际 summary、reportedOutcome 与限制；对端结束不替用户选择成功。已知固定来源说明留在原载荷及诊断，常用呈现显示用户所写限制和结果判断；未认识的原内容忠实保留。原 Result 草稿、payloadHash、事件与授权请求保持不变，重载自动接续原预览，已接受则读原回执。返回文字给出实际输出，确有完整材料时用真实下载或来源入口，不加泛化尾注。

## 已配置 Worker Pack

只有工具列表含 `galaxy_worker_host_read` 时才使用 Worker。read 取得实际配置的 worker、精确 Pack/Manifest、本人 Attempt/Configuration 与原 association；读取不隐含启动、导入 Result 或记 PackUse。

`galaxy_worker_host_prepare` 返回当前精确预览；`galaxy_worker_host_execute` 使用同一原 handle 与 previewHash，经真实选择执行。Apps 和普通 MCP 复用同一条确认，不自行重建预览或伪造 handle。若 prepare 已返回 acknowledged，只处理原 receipt；若 retry 缺少预览，先读原 association 中的准确原材料，不能对空白内容批准。

执行、导入 participant-reported Result、记录独立 PackUse 是三个不同事实，分别核对、确认并保存各自原回执。阅读、对端完成或一次工具调用不是成功复用或原任务已解决。unknown 先用 read 核对原 association；`galaxy_worker_host_abort_local` 只结束本地等待/预览，不承诺远端取消。来源失权、控制变化或句柄到期后重新读取，不借旧授权重新发送。

当前小面板先展示目的、必要输入、处理位置和实际对端输出。结果能直接使用时接回原工作；保留 Result 和 PackUse 按实际目的另外选择。已知原 Task 的进度和已提交原记录的回执由后台读取，不要求用户检查内部 ID 或报告表单。结构化输出按可读字段展示，并保留完整原文下载；不得把字段展示解释成独立验证、原问题已经解决或参与者已经验收。


已发布请求的回应读取和返回见[查询与帮助](help.md#读取回应与继续)。
