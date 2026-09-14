# 实际工作、精确交付与逐人材料交接客户端

2026-09-13。对应 M03、M06、M11 的现行工作包和 M02 逐人披露流程；依据及修改前说明见[开发记录](../../../../07-logs/development/task-fact-client-v2.md)。本页说明当前落地切片，不替代完整模块需求，也不把开发验证写成真实用户验收。

## 当前实现与入口

现有 TaskCollaboration 嵌入 FactWorkspace 和 ContextWorkspace。主动 Task 保持无需 Case、失败记录或尝试记录即可发布。开始实际工作时，请求者可以保存本人真实的范围澄清、诊断或其他 Intervention，也可以开始本人实际 Attempt；Case 与第一项事实在服务端同一事务中链接。页面没有虚构失败按钮，也不能代替参与者签署工作。

确认职责后的每位 Participation 可以记录自己的实际尝试、介入、结果与交付。尝试结束保留状态、观察和原因；诊断直接产生结果无需先补造 Attempt。Result 必须选择本人的精确实际来源。页面分别显示多位作者、参与约定版本、结果限制、独立反馈与整体解决程度。纠正追加版本，不覆盖旧事件；来源撤回后，下次读取由服务删去其依赖摘要，其他作者的独立工作不被删掉。

交付表单选择本人当前参与约定的 Result 版本，并选择实际相关的多方 Intervention 与 Evidence 版本。交付记录仅发给请求者，不扩大各源作者的原授权。现有验收按钮继续提交对应 deliveryId；接受某个范围的交付、Verification 观察和 Case Resolution 是三次独立表达。请求者可以明确留下未解决目标。页面不因测试通过、报告完成或接受交付就自动宣称整体问题解决。

## Evidence 与 Verification

来源登记表单只接收用户知道的来源系统、稳定编号、内容版本、发布者、实际时间和可选链接，不生成假哈希、不自动打开任意链接。支持读取真实记录并选择当前精确版本；旧 UUID 引用仍固定第一版，不跟随修订。修订后的 Evidence 要重新明确选择新版才能参与新交付。

Verification 选择实际可读的 Attempt、Intervention 或 Result；填写方法、范围、环境、观察与未覆盖部分。请求者接受反馈与实际测试分开；需要来源证据的方法仍由服务要求真实 Evidence。关系为本人声明，不把填写“独立”升级为已核实独立认证。来源或检查可以纠正、撤回，先读当前状态再提交新版本。

此切片没有新增“枚举所有 Case Evidence”的接口。页面发现本人本机保存的记录定位、Result 的已授权 Evidence 引用和 Resolution 的 Verification 引用；也允许读取一个已有记录编号。保存的本机目录只有类型与 ID，显示正文仍逐次从当前服务授权读取。目录不冒充整个 Case 的完整证据清单。

GitHub Actions 来源使用仓库所有者、仓库、run ID、attempt 和实际 commit SHA 的结构输入，经现有 `githubReference` 校验与 `ciSourceMetadata` 编码，不能用任意字符串替代稳定来源身份。下方嵌入 facts 代理实现的 CiWorkspace，接收当前可读 Result 与 Evidence，支持原生 CI 观察和有限范围 Proof 流程。CI 服务、外部来源观察及证明签署的独立验收见相应 CI 开发记录；本页不把录入来源当作已观察 GitHub。

## 逐人 Context

ContextWorkspace 使用独立 Context v2 服务与 context-v2-client helper。请求者从已经确认范围的真实 Participation 中单选或多选，明确输入最多八段文字并预览收件人、材料、范围版本及期限。多选形成多份独立授权；需要不同材料时分别提交。没有工作区扫描、文件批量上传、房间默认共享或银河集中模型推理。

接受者先读取材料目录和真实 materialsHash，明确接受或拒绝后才进入对应结果。接受内容绑定精确材料及参与范围，不能自己填写占位摘要。当前批准的参与范围改变、参与退出、材料过期、原授权失效或来源删除时，正文停止读取。请求者可以撤回每份授权，其他人的独立授权和普通聊天不随之被改写。

原操作回执未知时保留精确业务 ID、内容和已经准备的 Consent。页面提供查询、原操作重试和必要的重新授权预览。停止本机重试只清本机待发原文，保留最小定位供查询，不声称在途服务端请求已被取消。已经写入的材料需要通过真实 revoke 事件撤回。浏览器显示过或对方另行保存的外部副本不属于服务端删除回执。

## 身份、重试与失败

FactClient 使用现有 runtime.api.prepareAuthorization 和 submitAuthorization，在提交任何 Consent 前先本地保存精确签名准备记录；同任务串行写入，切换服务或身份后拒绝继续旧身份操作。Case 双事件链接与普通事实分别保留原操作。丢失回执后先读取并逐项比较真实事件，不能以“对象存在”或“版本更高”替代本次成功证据。重试保留已有业务 ID 和 Consent，不把读取授权失败解释为事件不存在。

Context helper另提供精确业务回执，浏览器同身份锁、重新绑定后的原授权核对以及停止本机重试。两个协调器分别管理各自真实服务边界，没有改动已有 Task/Participation 账本。事实读取不完整时明确显示覆盖限制；过期或权限不足的记录不会成为可选择的当前证据。

## M19：新增材料生命周期

`context_grants_v2` 的选定文字由 subject_id 作者拥有；participant_id 是指定接受者，不因此成为原文所有者。`context_events_v2` 的接受、拒绝、撤回分别属于签署人。本次 owner 导出只返回自己的选文及自己的事件；到 expires_at 后导出立即移除正文，即使 worker 尚未执行。接收者可用当前授权 Context 读取，不通过 owner 导出拿到另一人的原稿。

保留周期沿用每份真实签名 grant 的 expiresAt，未新设永久正文留存。维护器每批最多处理一百条到期材料，清 payload_text、记录 erased_at，保留原哈希及清理原因。最小清理回执的 180 天沿用已有执行层的追踪窗口，不是声称用户逐字确定了新的材料保留表。

全服务删除仍按本人数据及外键逐叶处理。若另一位作者的接受记录保留了 grant 容器，清除原作者正文，保留最小 ID、范围、哈希和时点；不删另一人的独立响应，也不能凭保留的哈希再验已清除的原始签名载荷。取消尚未执行的删除请求仍走既有 pending-deletion 可见性状态，不提前永久清空材料。

## 部署 Agent 接线

主页面仍使用原 TaskCollaboration，无新增导航或 main/runtime 变更；它导入同目录 fact-workspace、fact-client、context-workspace。Context UI依赖已注册的 migration59、ContextServiceV2及对应API角色。迁移不能改写旧版本；API不获材料正文 UPDATE/DELETE，期限清理由受限 worker 执行。Fact 依赖现有 M03/M06/M11 v2 服务及 Evidence `{id,version}` 扩展，无新增事实数据库迁移。

可执行入口为 `task-fact-client-v2.test.mjs` 和 `context-lifecycle-v2.test.mjs`；PostgreSQL受限角色补充 `test/postgres/context-lifecycle-v2.test.mjs`。记录具体验证结果于开发日志。真实浏览器点击、IndexedDB、跨标签交互及生产部署由主代理分开验证；本页不宣称全部 M02/M03/M06/M11/M19 已完成。
