<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/9c/9cd17525206955a242ef2491829a55f7e8659022641fadf3569fa87cf689f8af.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Official代理路由隔离

C01-07交付：packages/galaxy-official/deploy/caddy-routes.mjs导出officialRoutes({endpoint,apiPort})，产生可合并到已有Caddy JSON服务器的两个路由片段，不写入系统、不重载Caddy、不替换已有官网或监听/TLS设置。

第一条路由同时匹配精确主机名、HTTP方法与已实现的具体路径，转发至127.0.0.1指定API端口。第二条仅匹配同一Official主机，拒绝其余路径。两条均terminal；其他主机不匹配，应继续既有路由。新增业务API必须同步白名单及验证，不能以/v1/*或全站catch-all代替。参数只接受HTTPS origin和有效端口，没有默认域名。

## 部署前应用步骤

1. 根据实时资产记录确定动态Official的精确独立域名、API监听端口；不能用本文件的example测试主机充当实际域名。静态官网主机继续已有配置。
2. API只监听127.0.0.1；数据库与管理接口只在私有网络/loopback，端口不开放公网。Worker没有公网监听。操作系统防火墙和数据库bind配置须在目标主机核实，HTTP路由测试不能证明TCP隔离。
3. 读取现有Caddy配置，确认该主机没有更靠前的宽泛路由；将片段按正确顺序合并。保留其他虚拟主机、TLS、证书、日志与监听。不覆盖整份配置。
4. 在临时文件validate新配置，检查diff仅涉及目标Official主机。备份当前有效配置及恢复命令，通过staging后按发布清单切换。
5. 保留正常TLS验证与证书管理；若经Cloudflare，需验证origin Host、TLS及可信代理链。API可信代理只配置直接Caddy地址，不盲信外部X-Forwarded-For。
6. /healthz、/readyz仅由主机内监控访问API loopback，本公开片段不转发；不通过公开健康页暴露内部状态。未知/admin、/metrics、/.env、/database均拒绝。

## 证据与边界

真实本地Caddy验证2项通过：原IP配额/伪造头检查仍通过；新增精确主机/方法/路径检查、内部路径拒绝、其他主机保持后续路由、拒绝请求未到后端。lint通过。新测试在loopback HTTP上显式关闭automatic_https，仅为避免虚构测试域名触发自动HTTPS；生产片段没有关闭TLS设置，也没有改动系统信任。

运行：设置GALAXY_TEST_CADDY_BIN指向已核验本地Caddy，执行node --test packages/galaxy-official/test/proxy/caddy.test.mjs。测试启动临时Caddy并清理；不是线上部署或证书验收。本批同步源码快照扫描纳入deploy目录，旧快照不含新模块，未重新声称最新发行完成。

剩余：实际域名/主机/防火墙/DB监听核验、staging/生产TLS与路由集成、公开运营责任。C01-01实时资产检查仍未完成。不能将本地片段通过称为云服务已上线。
