<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/96/9619c9866a085cb77afbd373f9ce54d71221b06685dca2cbd5df8130d995605f.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 建设者端点可达性观测 v1

2026-09-10。C15-03/C15-07 本地实现；动态云服务尚未部署。使用 A2A 官方 SDK 1.1.0，协议固定为 A2A 1.0 / JSONRPC，与现有 A2A Adapter 一致。

## 使用

登记所有者在日常建设者菜单选择“配置A2A观测端点”，填写准确 RPC URL、公开 Agent Card URL 和所选接口的 tenant。此操作产生新声明，原 Node 授权随之失效。Node 需批准新声明，再选择“请求端点可达性观测”。签名预览包含两个完整 URL、tenant、协议、准确声明摘要和 Node 授权 ID；读取目录不会触发网络请求。

已提交请求通过现有建设者待办保存，可在重启后按原事件对账/重试。一次请求最多尝试三次；每次尝试最多进行两次公开网络读取：先读取 Agent Card，再通过所选接口只读查询一个新随机任务 ID。不会发送消息、创建任务、请求推送、获取 OAuth 凭据或读取用户的已有任务。

Node 撤销请求 Consent、撤销 Node 登记授权、声明更新，或者所有者下架/标记安全问题，都会使相关观测不可继续作为当前可达证据。源状态在请求前和保存结果前分别检查；已经完成的网络读取不能撤回。

## 协议复用与状态

Agent Card 解析和 GetTask 使用官方 SDK；只选择声明中准确的 URL、tenant、JSONRPC 和 1.0 接口。版本及 tenant 的依据见 [A2A 1.0 变更说明](https://a2a-protocol.org/latest/whats-new-v1/) 与 [官方协议规范](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)。

`TASK_NOT_FOUND` 是所查询随机 ID 的协议响应，可证明该接口在观测时响应了只读请求。此结论不是 Node 对该网站的控制证明、完整兼容认证或任务能力认证。服务返回的任何任务正文均不保存。

| 状态 | 说明 |
|---|---|
| `unknown` / `recent-owner-heartbeat` | 尚无端点观测；所有者心跳独立保留，不能推断可达 |
| `pending` | 显式请求已排队，尚无观测 |
| `reachable` | 准确接口返回了可识别的 GetTask 响应 |
| `authentication-required` | Agent Card 或 RPC 要求认证；不会自动登录 |
| `protocol-mismatch` | Agent Card 没有准确接口，或 RPC 响应与所选协议不符 |
| `unavailable` | 本次公开读取失败，或观测来源已不可用 |
| `expired` | 观测超过 300 秒有效期，当前可达性恢复为未知 |

`reachability.observation` 提供观测时间、有效期、阶段、有限原因、Agent Card 摘要及耗时。`endpointReachable` 仅指准确 RPC 接口：只拿到 Card 时仍是 null。协议不匹配但已收到 RPC 响应时，HTTP 可达与协议状态分别表达。可达、Node 授权、兼容报告、任务证据关联和能力认证始终分别展示。

## 作业与资源

- 复用 `jobs`，新增 `builder-probe` 类型。现有 API 只接收签署的 `probe-request`，观测结果只能由 Worker 写入 `builder_probes`。
- 每条登记的新请求间隔至少 60 秒；所有 Node/登记共享同一 URL origin 的至少 60 秒探测间隔，Card 与 RPC 的 origin 都计入。租约占用和未知结果同样保留间隔。
- 共用现有主体排队额度、全局和主体运行额度；默认全局 4、主体 1。作业租约为 30 秒，每次观测总期限 10 秒，每次网络读取最多 5 秒/64 KiB，失败最多重试两次，间隔至少 60 秒。
- 使用现有 `public-fetch`：HTTPS 443、全部 DNS 答案必须为公网、连接固定解析结果并校验原始主机 TLS；不跟随跳转，不读取代理环境，不发送凭据、Cookie 或用户任务内容。
- 进程中断后按租约和 origin 间隔续跑；迟到执行不能覆盖新租约结果。停服/事故暂停沿用现有 Worker 开关。
- 复用队列/积压指标；新增 `galaxy_builder_probe_observations_total`，只有有限状态标签。运行日志写入 `builder_probe_job`，不记录端点、请求正文或响应正文。

## AI-agent 部署与维护接续

从 `packages/galaxy-official/package-lock.json` 冻结安装后迁移到当前 Schema 37，再运行既有 API/Worker 角色配置。Builder观测表在35引入，36/37仅补材料列表和通知审计约束。API 仅可读观测表；Worker 增加观测表写入及窄范围 Builder 共享锁函数。API/Worker 服务发行必须使用一致源码及迁移版本。没有新增服务密钥或外部 A2A 凭据。

当前 42 张表、31 类本人导出数据集。`builder-probes` 只导出本人发起的观测；登记所有者可通过已有授权视图读取当前可见结果。新增数据和关联作业已加入删除清单，备份恢复沿用现有完整数据库流程。

相关自动检查包括 SDK 的真实本地 HTTP 服务、签名请求/API与客户端、角色隔离、来源撤销/更改、过期、共享 origin 间隔、排队额度、三次失败、租约恢复、原生菜单、导出/删除，以及实际 Worker 进程处理撤销请求并重启。TLS 公网传输门使用既有实现；受控测试不能替代真实建设者、真实公网端点、目标宿主人工体验或异地运营恢复验收。
