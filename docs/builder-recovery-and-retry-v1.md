<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/bf/bfe29ef45897e1b11dd37128f89e51138c9f6c2d0e2ee90994225694b9960612.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 建设者管理恢复与本机重试 v1

2026-09-10，C15-09。本地开发实现；动态云服务未部署。复用已有登记事件、Consent、身份签名和客户端，不新增执行服务、Relay 或后台扫描。

## 管理与公告

所有者可在原生建设者菜单选择“管理我的登记”，查看包含不可读声明的本人登记列表。旧声明的 Consent 或绑定失效时，仅返回登记 ID、版本、声明 ID/摘要及管理状态，不返回旧声明正文、名称或配置。普通目录和搜索继续隐藏不可读声明。

所有者可以重新填写并授权准确的新声明，也可以用新的逐事件 Consent 发布下架、纠正或安全公告。此时公告独立选择 Public/Private 范围；不会隐含重新公开旧声明。恢复目录展示、解决安全问题和心跳仍要求当前声明有效。新声明不会自动清除旧下架或安全状态。

公告按各自当前授权过滤后分页，返回事件、声明引用、版本、操作、说明和时间。撤销公告正文不撤销其已执行的下架状态。维护沿革不代表当前声明有效、端点可达或能力通过。原事件保留，版本冲突要求重新读取和准备。

## 持久重试

原生菜单“本机建设者待办”提供读取远端接收结果、预览原事件重试和移除已完成本机记录。准备时先保存原始事件字节与 Consent 意图，提交前记为 submitting；网络中断、取消或丢失回执记为 unknown。只有匹配事件 ID、登记 ID、摘要、版本和已保存 Consent 的回执才会变成 acknowledged，该状态不会被迟到失败覆盖。

重启后需要重新连接才能对账或发送。远端回执只说明该事件是否被接收，即使原声明授权失效仍可由原提交主体核对；它不恢复授权或表示当前有效。absent 才允许准备重试；conflict 或 acknowledged 不会自动发送。

重试保持原事件 ID、字节、版本预期和披露范围。原绑定仍可用时复用 Consent；重新连接或 Consent 到期后，准备新的 Consent 并再次准确确认，保留旧意图以识别旧请求迟到提交。若已有其他事件改变版本，则由服务拒绝，不偷偷改写原事件。原生取消后的旧确认回调无效。

记录保存在现有 galaxy-local-state.json 的 builderOperations 字段，按端点/本机身份/事件隔离；不存访问凭证、签名私钥或已签名令牌。上限 100 项、记录集合 2 MiB、本地状态文件 4 MiB。prepared 和 acknowledged 可以移除；未知结果须先对账。移除本机记录不删除远端数据。本机日志包含用户原先选择的声明/公告内容，属于本机私有状态，不进入发行包。

## 接口与集成

| POST 路径 | 客户端方法 | 范围 |
|---|---|---|
| /v1/builders/manage/read | manage({builderId}) | builders 会话；仅登记所有者 |
| /v1/builders/owned/query | owned({type?,after?,limit?}) | 本人登记；默认 8、最多 20 |
| /v1/builders/events/receipt | receipt({builderId,eventId,payloadHash}) | 原提交主体；只返回最小接收结果 |
| /v1/builders/notices/query | notices({builderId,after?,limit?}) | 当前可见公告；公开 HTTP 可匿名读取 |

便携客户端仍使用 @galaxy/client/builders；本机日志与私钥签名由可信宿主组合。控制器接通 prepareBuilderRetry、reconcileBuilder、listBuilderOperations 和 forgetBuilderOperation。首次 /galaxy 初始化不变。

## AI Agent 部署与回退

使用现有明确配置的 endpoint、builders/consent Scope 和签名 pin；没有默认远端或隐式接入。当前数据库仍为 Schema33/41 表，无本次 SQL 迁移。部署候选使用 deploy/caddy-routes.mjs 中新增的四个 POST 路径及统一搜索路径，旧方法和其他主机保持原路由。

关闭新增 UI/路径即可停止新管理流程，保留已追加事件及本机日志。旧普通目录不显示不可读声明；不能以回退程序为由重写旧载荷、清除下架状态或重发不同事件。实际公开部署与人工宿主体验另行验收。

## 验证证据

测试覆盖声明撤销后的 owner 管理、公开/私有公告分页、重新声明、严格拒绝旧声明恢复、最小回执；HTTP 后端实际去重、丢回执、重启/换绑定、旧请求迟到；真实本机身份签名和原生交互。受限 PostgreSQL 角色及实际 Caddy 路由、严格 TypeScript、lint、52 文件/19 入口客户端离线安装检查见项目本次进度证据。测试数据均为合成；不计为真实建设者、外部端点或人工验收。
