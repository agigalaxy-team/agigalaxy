# 当前事实检索与本机选择记录 v2

2026-09-13。实现对应 M09 `NEW-M09-DESIGN/FLOW/ACCEPT` 的当前事实、来源组合和本地选择切片。来源为完整 M09 阅读包/工作包、卷03 A-03-05/16/17、卷07、卷12 §12.10、CUR-02/03/13/23/26—29/33，以及授权代选 A-Q-03、DISC-Q-CONTACT-LIST、ROOT-Q-CHOICE-SNAPSHOT。授权代选与用户原话不是同一证据类型。

## 当前可用行为

`POST /v2/search/query` 读取一种真实数据来源；浏览器或用户 Agent 组合不同来源并解释，云不运行模型或相似度推理。v1 六类接口保留，不让 v1 默默换成 v2 数据语义。默认每页 8 项，最多 20 项。结果不是能力排名，也不把没有可见资料解释为没有适合的帮助。

| type | 当前实际来源 | 范围及解释 |
|---|---|---|
| history / case | M07 History v2，M03/M06/M11/M05 当前授权事实 | 可跨主体；保留尝试、失败、诊断、部分结果、参与、交付和来源验证的不同含义；case 仅 Case 类型 |
| capsule | M05 v2 当前方法及许可 | 读所选版本的完整方法是另一次当前授权读取；阅读、应用、成功复用不同 |
| task | M11 v2 真实请求 | 没有失败经历的主动任务合法，发布不表示已经有人工作 |
| opportunity | M10 v2 实际功能声明、项目及当前接触偏好 | 不因同技术栈推断同功能；声明、经历和当前意愿分开；查询不发送邀请 |
| proof | M06 原生 v2 CI Proof | 仅仓库控制运行的观测范围，不是独立专家认证；旧 Proof 仍走 v1 |
| worker / hub | 现有公开声明目录与当前源读取 | 声明不证明运行、连接、可达或能力 |

查询例子：`{"type":"history","query":{"query":"重复请求","limit":8}}`。可选 subjectId 限定主体；原 `/v2/history/query` 仍要求该字段。

任务例子：`{"type":"task","query":{"view":"open","query":"数据导出","limit":8}}`。

机会例子：`{"type":"opportunity","query":{"context":{"kind":"ephemeral","title":"寻找文档解析交流","functions":["table-extraction"]},"purposes":["conversation","collaboration"],"limit":8}}`。

HTTP 根据类型要求原有 scope：task 为 assistance，opportunity/history/case 为 history，其余沿用相应 scope。允许现有匿名读取的来源仍按匿名当前权限处理；提供无效凭据不会被忽略并降级匿名。当前身份、同 Account 控制纪元、删除请求及源授权由实际服务重查。跨主体读取一直保留原查询者，没有切换到源作者或内部管理员读取。

## 结果、分页及权限

返回 schemaVersion、type、items、nextCursor、coverage、checkedAt、sourceState 和仅当前可见页的 pageCount。每项含 type/id、title/summary、当前授权 record、来源 authority、matchReasons、limitations、source 及 ref。ref.version 是当前可见投影的 SHA-256 摘要；真实事件 ID 和对象版本仍在 source/record，不把摘要冒充数据库事件版本。

隐蔽事件写入的总序号不进入摘要。Task 先经过真实当前授权读取，再匹配可见标题/摘要和分页，游标不会命名未获授权的候选。History 分页发生来源变化则要求从第一页重查。native Proof 逐候选重新核验原 Evidence/Result/观测状态后才进入匹配和计数。撤销、过期、受管删除或来源修正不能靠旧索引、旧片段或选择记录恢复读取。

`POST /v2/search/reference` 输入 `{search:<原查询>,ref:{id,version}}`，以相同查看者重放当前查询，返回 current、changed 或 unavailable-in-current-query，附当前可读 item 或 null、priorRationaleCurrent 和核对时间。这说明旧理由是否仍有相同依据，不改写用户当时的选择，也不宣布绝对不存在该对象。

Search 适配一次只读一种来源。浏览器 `combine` 使用分别返回的成功/失败结果，失败不是空数据；重试与下一页也针对各自来源。四条帮助路径持续保留：继续当前 AI、Capsule/历史方案、开放协助、赏金/专家协助。

## 浏览器与 MCP

`HelpSearchWorkspace({runtime,connected,subjectId,navigate})` 由主入口接入 `/app/search`，依赖当前 API、当前身份及分主体的本地存储。支持组合查询、独立重试、分页、实际方法和经历详情、转入实际任务/匹配、填写可见理由和保存本机选择。不接触真实模型私有推理；任意自由文本的语义正确性仍由用户/模型负责，校验器不会声称能够自动识别所有私有思维链。

MCP `galaxy_search_v2_query` 与 `galaxy_search_v2_reference` 直接调用同一 Search 服务，按实际 source type 校验 scope。未增加只靠描述宣称可用的占位工具。

本机客户端 `createHelpSearchClient` 使用当前 runtime 的身份 guard，关闭/换身份后旧操作不能继续写入。`saveChoice` 仅接受本客户端实际读到的精确候选引用，Result 关联只能选择同样读取到的真实 Result 版本。保存候选与选择、对用户可见理由及作者、当前工作引用和结果关联；不保存来源正文，不创建 Task/申请/Result。相同 id/version/内容摘要重试幂等，同版本不同内容冲突。当前本机 UI 保存新选择记录；客户端支持显式追加版本。

默认 `help-choices-v2` 本机保存；源查询条件只放另一个本机导航对象 `help-choice-lookups-v2`，供重启后来源复核，未进入最小 Choice 正文或上传。复核只更新来源状态，不补造历史理由。删除本机 Choice 同时移除不再被引用的导航数据，不删除源工作事实。个人房间摘要的云开关不会自动开启或上传这些记录。

## 证据与尚未完成范围

当前实际 HTTP/MCP workflow 和真实浏览器 runtime workflow 2/2；受影响 Capsule/CI/History/Task 测试 14/14；独立 PostgreSQL、schema61、受限 galaxy_api、实际 HTTP 1/1 且临时库已清理。新网页组件针对性 TypeScript 检查通过，内存 bundle 为 303550 bytes。主代理单独负责网页集成、部署和线上核验；这些自动测试不是用户体验验收。

检索本体采用按需读取实际源，未新增数据库或把 v2 事实塞进旧索引。全局 History 可能读取较多已登记候选，reference 可能重放多页；尚未进行生产规模负载/容量验收，不宣称全网低延迟或无限规模。后续独立 migration62 已实现 Choice 私有云同步、30天清理与跨设备冲突，详见 [选择快照 v2](choice-snapshots-v2.md)。源码、自动验证和部署状态分别报告。
