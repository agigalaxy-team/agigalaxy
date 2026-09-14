<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/81/816c92ac9bbc9fc16269b65efadb90324ebdbb1abbaed3047f34597256f351e9.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Official API行为约定 v0.1

2026-09-11按当前源码更新，服务0.1.0 / HTTP v1 / Schema41。此文件记录开发中的实际行为，不代表生产上线或公开支持承诺。完整路径、认证、条件和业务Schema来源见[当前开发API目录](development-api-reference-v1.md)，版本见[机器可读约定](version-contract.json)。C00-06的共同验收仍保留。

## 请求、错误与重试

普通业务HTTP JSON body上限32768字节；只接收application/json，拒绝Content-Encoding；必须有效UTF-8、JSON对象、精确顶层字段。非法字节与带BOM的JSON返回400 invalid_json。字段/业务限制可能更小；大小单位保留实际实现，不能统称字符数。查询字符串只允许Consent列表的单个after，以及配置中的OIDC回调白名单参数；其他查询条件放在对应POST body。

业务HTTP错误为`{error,requestId}`，X-Request-Id对应同一请求；ServiceError缺省400，未知异常500 internal_error，不返回异常正文、URL或令牌。常见状态为401认证拒绝、403权限/策略拒绝、404不存在或不可见、409状态/版本/幂等冲突、413过大、415媒体类型、429限流、503不可用。具体静态错误声明及源码位置见[错误目录](api-error-catalog-v0.1.json)；该AST索引不包含所有库/动态错误，也不证明所有错误在所有端点可达。

MCP使用SDK JSON-RPC响应、工具结果与isError；OAuth保护入口还可能返回标准认证挑战和WWW-Authenticate。它们不等同于普通业务HTTP错误封装。匿名Docs MCP与需要OAuth的Personal MCP分开；OAuth令牌不能直接用于既有Galaxy会话接口。细节见[Personal MCP](personal-mcp-oauth-v1.md)。

请求ID不是幂等键。没有通用Idempotency-Key请求头实现，不能假定添加该头即可安全重发。限流器的Retry-After取值依实现：旧固定窗口为60秒，分类请求额度返回当前窗口剩余秒数，容量不足可返回503和较短重试时间；业务层限额不保证附带该头。以实际响应为准，不统一硬编码60秒。额度为当前API进程内计数，详见[资源预算](resource-budgets-v1.md)。

超时可能已提交。写入结果不确定时先查询回执/状态，只有原业务支持的同ID、同载荷重试才可重发，不自动换ID或扩大授权。受控的只读下载重试已有上限，见[数据导出](data-export-v1.md)。429或503不是自动重放写入的许可。

## 幂等与并发

|操作|当前行为与兼容边界|
|---|---|
|创建挑战|不保证全局幂等；重复请求可创建新挑战|
|绑定/激活|校验签名及当前状态，消费同一挑战；受限幂等消费不延长原会话有效期；旧状态不保证重放仍成功|
|Consent创建|相同ID和相同签名字节、仍有效且未撤销才可复用；不同签名摘要或已撤销返回冲突；issuedAt窗口也限制迟到重试|
|Case事件|相同事件ID、主体、Case、payload摘要和Consent可返回原version；必须先重新通过授权，不重复追加事实|
|并发追加|expectedVersion等于当前Case版本，父记录锁串行化；不同事件竞争时失败方重读并重新确认，不自动合并|
|Evidence|提交内容、来源、主体及同意约束一致才去重；202表示队列接受，不表示验证成功|
|Proof|重读有效来源与Consent，精确匹配预览载荷；同ID同摘要和Consent可复用；来源变化/过期/撤销阻止重放|
|协作、Context、Capsule、建设者与治理|各自事件/回执与并发版本约束见模块说明；不能从Case推定所有对象使用相同冲突或重放规则|
|账户关联|OIDC回调只形成待本机签署意图；confirm重试须匹配同一主体、绑定和原签名字节；关联本身不新增Galaxy权限|
|撤销|重复撤销以该业务的当前授权和可见性为前提；绑定被撤销后依赖它的凭据不能继续授权|

当前Case最多1000事件。attempt.sequence连续；result引用同Case的attempt，失败必须有非空原因。revision以correctsEventId追加纠错，不改写原事实；withdrawal阻止新事件。读取完整Case逐个检查历史Consent，一项授权无效则不返回部分聚合。相同既有事件的幂等返回仍以当前授权为前提。succeeded最多产生resolution-proposed，不产生独立验证结论。

通知偏好使用expectedRevision；Honor分页的expectedFingerprint检查投影变化；它们和Case expectedVersion不是可互换字段。所有签名载荷须保持原字节，不能重新序列化后当作原授权。

## 分页与时间

没有统一的page参数或全站快照。下表是常用查询入口；详细过滤字段与其他查询以[目录](development-api-reference-v1.json)链接的实际Schema为准。

|查询|游标与页大小|边界|
|---|---|---|
|Consent GET列表|URL单个after UUID；最多100条；nextCursor|UUID升序，不按时间排序；并发插入在游标前需重新读取|
|绑定查询|POST after UUID；默认/最多20；nextAfter|仅本人绑定；安装实例等过滤保留|
|外部账户关联|POST after UUID；默认50、最多100；nextAfter|只返回本人关联及当前绑定/提供方状态|
|履历|POST after UUID；默认20、最多50|当前可见来源过滤，见[履历查询](history-query-v1.md)|
|统一搜索|按case/history/proof/capsule/worker/hub类型查询；默认8、最多20|对应Scope和可见性不同，见[来源搜索](typed-source-search-v1.md)|
|协作/请求方历史/事实|POST after UUID；默认8、最多20|view及主体/协作过滤，见[通知与请求方历史](notifications-requester-history-v1.md)|
|通知|after为类型前缀加UUID；默认8、最多20|unreadOnly及通知偏好过滤；不是裸UUID|
|建设者目录|after UUID；默认8、最多20|通知列表另用整数偏移，默认0，不能混用目录游标|
|审计查询/导出|after为十进制序号字符串；默认25、最多100；可带through|追加序列及固定上界，见[审计访问](audit-access-v1.md)|
|本人数据导出|dataset专属after；默认50、最多100|32类本人记录及所选当前授权视图；票据最长600秒，有界实时分页，不是跨页数据库备份|
|Honor|贡献/Proof/风险/嵌套引用分别分页；默认8、最多20|继续页携带投影指纹；变化需刷新，见[Honor分页](honor-pagination-v1.md)|

各次请求重新核对当前权限。页间撤销、纠正、插入和更新可能改变内容；不能从第一页的权限推断后续页仍可访问。游标不是对象所有权或存在性证明。未返回后页不等于对象已删除。

签名和协议时刻使用Unix整秒；数据库/绑定显示时间使用ISO时间文本。expectedVersion是事实流并发版本，configuration.version是工作环境版本，都不是API版本。比较前校验类型与边界，不能由客户端扩大授权寿命。最大有效期见[版本约定](version-contract.json)。

## 大小单位与数据退出

|对象|当前限制|
|---|---|
|业务HTTP请求|32768字节|
|Case payloadJson|12000字节|
|Evidence payloadJson|4096个JavaScript字符串代码单元|
|Proof payloadJson|12000个JavaScript字符串代码单元|
|Consent signedIntent|16384个代码单元；compact JWS属于ASCII格式|
|其他字段|对应严格Zod Schema的限制；不是统一HTTP字节限额|

更改大小单位可能改变已接受载荷边界，应显式评估兼容性。撤销展示、物理删除、本人导出和服务退役是不同操作，当前实现见[数据生命周期](data-lifecycle-v0.1.md)、[删除申请](deletion-requests-v1.md)、[服务退役](service-retirement-v1.md)。生产保留策略与调度仍依实际部署落实。

## AI Agent开发入口

先读取版本、目标模块说明与实际配置，再使用隔离服务。`node scripts/build-api-reference.mjs`重建API目录和静态错误索引；加`--check`检查是否仍匹配源码。修改HTTP分发或代理路由时运行api-reference/http-routes及实际Caddy专项；业务事务改变时运行对应工作流和PostgreSQL专项。不要用路由分发检查代替业务授权、真实来源、宿主体验或生产验收。数据库回退采用已验证相容版本或恢复副本，不重写历史迁移。
