<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/e9/e9a9a4d7784b5afbb6e925ec09ac86c8555de0530bc03785d867a640fb88b994.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Official 基础云实现进展

日期：2026-09-09。范围：完整M0–M5计划正在实施，人工体验和价值判断留待人工。本文不是上线声明。

## 本地已验证部分

- 本地Core的16项测试通过；新创建身份保存公开创世证明，已有身份不被替换。尚缺证明的旧ID不能通过任意公钥签名远程认领。
- Official包使用锁定的jose 6.2.12、pg 8.23.0；PGlite 0.5.8仅用于隔离测试，生产使用PostgreSQL。包位于既有独立仓packages/galaxy-official，没有另建仓或批量提交。
- JWS采用JWT封装和明确的Ed25519算法，签名覆盖实际编码字节；验证固定用途、发行者、受众、时间、可信键及撤销。接收对象不能自行提供可信根。
- 4项Official测试通过，覆盖签名正常及负例、重复迁移、未来数据库版本拒绝、事务失败时事实和审计一起回滚、外键拒绝。
- 根目录npm run lint通过；忽略嵌套node_modules，项目源码仍参加检查。

## 设计限制与待完成工作

- GUID-32 v1承诺只有80位截断摘要，不宣传为128位承诺安全；创世证明只证明现有承诺关系，不能证明实名或能力。旧身份遗失nonce不允许伪造恢复，兼容/恢复方案仍待完成。
- 当前签名组件不代替业务Schema、首次可信根分发、轮换发布或challenge一次性消费；这些需分别实现和端到端验收。
- 数据库已增加绑定/会话事务和本地HTTP服务；后台作业、生产数据库角色权限尚未完成。PGlite通过不能证明多连接并发、生产PostgreSQL或恢复能力。
- 尚未部署动态Official服务。签名根、真实绑定、远程Consent、Case/Evidence/Proof、履历检索、协作、Capsule、登记、客户端对接和运维发布仍须继续。
- 本次没有远程操作、生产数据写入或创建真实用户身份。所有测试身份均为隔离夹具。

## 复验命令

在仓根运行npm test及npm run lint；在packages/galaxy-official运行npm ci --ignore-scripts和npm test。生产数据库迁移需显式提供DATABASE_URL，缺配置失败；不得将秘密写入源码、日志或公开配置。服务启动入口已实现并验证缺失配置时安全失败；尚未连接生产数据库启动，不能据此宣称已部署。

## 本轮绑定与HTTP实现

- 签名绑定：验证创世证明、一次性挑战、客户端会话关联、精确签名字节；事务内创建主体/绑定/审计并消费挑战。重复提交保持相同回执。
- 访问认证：本机生成随机凭证，服务端只存摘要；签名激活短期会话。私有查询检查主体归属，撤销同步作废关联凭证。
- HTTP：字段白名单、JSON体积上限、浏览器Origin拒绝、基本匿名限流、统一非泄密错误。实际localhost HTTP请求接到服务及PGlite数据库，未使用假绑定实现。
- 本轮5项Official测试通过（其中绑定综合测试包含HTTP、签名、会话、重放、越权、撤销和日志检查）；根lint通过。启动缺配置退出1，仅输出startup_failed。
- PGlite串行事务测试不等于生产多连接并发验证；真实TLS、Manifest信任分发、客户端确认UI及生产部署继续待做。运行指南见../packages/galaxy-official/README.md。

## Manifest与公开读取

- 已实现带严格Schema的签名Manifest HTTP路由、ETag/304、60秒缓存刷新、到期及撤销密钥拒绝。元数据仅声明代码具备的binding/sessions；无Case/Proof上传声明。
- 客户端显式只读发现函数不依赖本地身份/状态库；返回verified也保持connected:false和authorized:false。未知键、错误端点、过期拒绝。
- HTTPS公开读取器使用固定DNS解析结果建立TLS连接，拒绝全部非公网答案、私网/回环/元数据地址、URL凭据、非443端口和重定向；有总时限与响应大小限制。ipaddr.js 2.5.0已锁定。
- 7项Official测试及lint通过。新增实际localhost Manifest HTTP及ETag测试、公钥/端点/过期/撤销验证、特殊地址及URL编码绕过拒绝测试。真实公网TLS、DNS重绑定集成模拟、所有超时/超载失败路径尚需补充；不将函数级拒绝测试当作完整SSRF验收。
- 首次可信根随发行分发、签名键轮换及客户端原生页面仍待实施；当前服务启动配置新增GALAXY_OPERATOR与GALAXY_REGION，禁止用缺省内容假称实际运营责任。

## 签名信任链与持久化

新增根签名服务密钥清单、单调递增序号、密钥撤销/重用检查及本地公开信任状态持久化。根由可信发行配置提供；服务端不加载根私钥。密钥清单最长24小时有效，每次续签必须增加序号。客户端显式读取后先持久化版本，再使用服务键；清单失效后已缓存键不能继续验证。

8项Official测试及lint通过，包含新增的轮换、撤销、回滚、同序号冲突、撤销键复活、密钥ID重用、过期信任及跨次读取持久化验证。生产根生成/发行、续签运维、真实轮换演练和宿主接入仍未完成。服务新增公开配置GALAXY_ROOT_PINS_FILE、GALAXY_KEYRING_FILE及本地GALAXY_TRUST_DIRECTORY；旧的签名有效期环境字段由根签名文件替代。

## 公开Docs MCP

已接入真实SDK 2.0.0的Node Streamable HTTP无状态JSON传输，注册四篇公开资源、版本模板、docs_get/docs_search及安装/隐私解释Prompts。包锁定了server/node/client版本；文档来源仍为官网build.py中明确编写的四篇docs，使用AST白名单导出public-docs.json，未执行网站构建或读取内部资料。生成器--check一致性通过。

本轮9项Official测试全部通过，lint通过。真实SDK客户端经localhost HTTP读取资源、查询模板、调用工具和Prompts；另测非法topic、未知文档/协议、错误Host/Origin和超限请求体。Host负例使用原生HTTP发出真实指定Host。动态服务未公开部署，官网dist及线上内容未改动；其他第三方MCP客户端兼容性仍待验证。

## 远程Consent基础

新增迁移3、本机签名授权记录、独立consent管理Scope、归属分页列表和撤销API。事务内重新检查凭证/绑定；数据调用辅助接口重新检查授权状态、接收方、对象、动作和精确载荷摘要。可见性矩阵区分Private、Hub-scoped、Proof-only、Public，Local远程授权拒绝；研究/训练/商业用途不开放。

9项Official测试通过；最终增补列表/可见性到期后单独复验绑定综合测试通过。测试覆盖真实HTTP授权创建、重复提交、列表、载荷/接收方替换拒绝、撤销、过期可见性与会话失效后的写入拒绝。生产多连接并发、领域数据Schema、真实上传、作业/缓存撤销传播及保留删除恢复仍待完成。

## Case、Attempt与Result

新增迁移4、受授权保护的Case及追加事件API，保存参与者声明、原始来源、本地引用、尝试顺序、环境配置、失败原因和修正引用。成功Result仍为unverified，仅提出解决方案状态；不会生成能力证明。同主体原始来源引用跨local/Bridge/Hub去重，更新使用expectedVersion。

本轮Case、迁移与回滚3项针对性测试通过，最后增加跨入口去重后Case测试复验通过；lint通过。测试从真实绑定/会话/签名授权走到localhost HTTP Case创建、追加、查询、拒绝及撤销，全部为合成夹具。完整数据链的生产并发、真实Coding来源、独立Verification和派生查询仍待完成。新增/v1/case-events作为统一追加接口，其与原候选路径的差异已在包README注明，待最终API冻结。
