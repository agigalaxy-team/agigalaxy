# 组件配置与接口

| 边界 | 真实接口与配置入口 | 必须保留的含义 |
| --- | --- | --- |
| Hub 业务服务族 | `packages/galaxy-official/src/operations-config.mjs`、deploy/runtime-settings、`release-resources.json` | API/worker/migration/publisher 按同一发行完整迁移列表运行；业务库与角色分别配置 |
| Web | browser-client 与 `src/shared` schemas，Native handoff | 网页不创建或恢复本地 ID；账户登录不代替本机控制或同步许可 |
| Admin/BFF | apps/galaxy-admin/.env.example、lib/access、Node 内部运营路由 | 独立管理登录；当前人权与 AI 角色相交；后端事务内核权 |
| Native AgentOS | runtime.env.example、config.py、tool_schemas.py | 私有服务 key/JWT；Node 签发控制与原操作归因，Native 不自选权限或改模型配置 |
| Model Gateway | SOURCE.json、models.empty.yaml、模型配置原生读回 | 固定上游；人工配置；不借测试自动选 provider 或发起真实模型请求 |
| Keycloak | apps/galaxy-auth/client-contract.json、realm-profile.mjs | 普通银河账户、管理账户和本地 ID 分离；主题直接用 Web/Mail 共用源 |
| 发布恢复 | service-release capture/compare/attempt、deploy/service-release-host.mjs | 具体主机文件/单位/回读合同显式输入，保持原 operationId，不假降迁移版本 |

配置示例可入源码；实际 `.env`、provider key、数据库密码、Cookie、签名私钥及运行配置不得入 Git、日志或源码包。秘密通过受保护文件/安全存储及短期进程注入提供。配置字段以相应加载器为准，未提供的能力不由示例值补成已接通。

## Task 征集合同

`stop-enrollment` 是追加事件：任务仍为 `open`，snapshot 的 `enrollment.state` 变为 `stopped`。新 apply/invite/propose 和延长征集被拒绝，已提出参与的确认、范围调整、交付与验收继续按原权限执行；治理暂停、来源失效和实际撤权仍各自生效。

`close` 继续终止整项工作，新写入必须包含 `terminationIntent: "terminate-task"`。历史 `closed` 不重开、旧事件字节不改写。缺少该字段的旧 `close` 只能查询已接受的原回执，不能自动补字段、转换为 stop-enrollment 或在 absent 后重发。新界面分别显示结束征集、取消与整单终止的影响；旧客户端得到明确拒绝，不能静默降级。

事件及回执仍由 `task-schema-v2.mjs`、`task-owner-control-v2-schema.mjs` 定义，HTTP、MCP 和 Web 共用。并发仍按任务版本 CAS 和数据库锁处理；重复原事件回原回执，不增长第二份事实。部署此本地候选前应一起审阅 API 合同与客户端升级安排；此文不代表已经上线该合同。
