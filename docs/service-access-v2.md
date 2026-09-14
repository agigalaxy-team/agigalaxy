# 停写期间的 v2 取回与撤销

本页描述 `operations/service-access-v2.mjs` 的当前实现。事故状态与服务退役由既有明确运行配置控制；代码或演练不表示生产当前已经进入这些状态。

取回期允许现有主体通过当前设备控制链重新连接，查询原 Consent／任务等回执，读取仍获准的对象，建立限期导出票据和分页取回。新会话不会恢复过期、撤销或删除的源。导出票据仍绑定原会话：重连后应建立新票据，不能用新绑定冒领旧票据；票据截止时间不超过服务取回截止。

事故 `contained`／`recovery` 比取回期更窄：现有主体可重连，读取本人控制与删除请求回执，取消未执行的删除申请，撤销原授权，执行已有专用停止／离开动作；业务正文和导出继续返回 `service_incident_contained`。结束事故需要既有显式恢复证据。身份公开状态或签名正确本身不替代当前设备／epoch 检查。

| 操作 | 当前行为 |
|---|---|
| GET `/v2/identity/{GUID}/control`、POST `/v2/binding-challenges` | 在取回／事故期允许；绑定挑战及最终提交都检查主体已存在，签名、当前设备和范围仍由绑定服务验证 |
| POST `/v2/consents/receipt`、GET `/v1/consents`、删除请求 read/query | 本人原授权／删除操作查询，不能据此恢复写入 |
| v2 Task、Case、事实、Capsule、聊天、摘要等明确只读路径 | 取回期逐对象重验当前权限；事故期间仍暂停正文 |
| 原 Consent revoke、CI 专用 revoke、附件撤销、摘要／选择副本 delete、房间 leave／agent-revoke、消息 retract／hide、关注 stop | 仅减少选定权限、停止工作、删除选定副本或退出；保留原业务服务的身份、版本、对象验证 |
| mixed events/submit、发布、申请、加入、上传、云同步 put、新 Consent | 本次不整体开放；“请求中写着 revoke”不会绕过停写 |
| `/mcp/personal` | 保留停止期间的整体拒绝；原生 HTTP 工具可调用上述明确允许操作，未实现按 hosted MCP tool 逐项分流 |

撤销原 Consent 使相应投影失效，并不等于任务取消、聊天全文回收或数据库已物理清理。需要新签名授权的混合事件状态变更仍是后续窄接口工作，不从同一路径放行所有事件。跨域 Peering exchange／远程 query 也不因本地取回期而重新开放。

`status-only` 与 `closed` 的历史元数据范围、取回截止和不可逆事实保持原规则。v2 CI 的 `status` 路径当前复用完整 Proof 投影，因此没有仅凭名称把它加入到期后的纯状态白名单。

## 开发者和部署 Agent

服务工厂把退役和事故的 `assertBindingSubject(db, subjectId)` 组合后传给 BindingService；挑战和提交均复用该守卫。新增“读”路径必须检查服务真实行为，不能以 URL 后缀、HTTP POST 或拥有权限判断是否能在停写期运行。共享列表不解析模型输入、不改变原 API payload，不代替正常认证或资源 ACL。

必要检查：`node --test packages/galaxy-official/test/service-access-v2.test.mjs` 覆盖真实 BrowserRuntime／BrowserClient、HTTP、CORS、签名控制链及数据库；原 incident/retirement 测试保持 v1 配置和阶段兼容。夹具身份、任务和删除请求均为合成，未触及生产或后台备份。

来源：[M19 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M19.md)、[M23 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M23.md)、[M01 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M01.md)、第15卷15.16；实施与证据见项目 `07-logs/development/service-access-v2.md`。
