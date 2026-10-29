# 当前工作

## 当前任务与状态

2026-10-29：全仓遗漏重构与源码收束的本地实现、冻结产物及必要定向检查已完成；正在按用户授权同步GitHub、跟进CI并部署服务器。当前尚未完成新版本切换，下方既有线上结果属于此前版本。

- 当前入口：服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的 native/integration-mcp/host/integration-host承接。官网Next与Admin Next/Payload分别运行，共用浏览器组件与查询/事件/会话机制。
- 已退出：旧 Core、Node CLI、Edge MCP、Official业务src/test整树，以及旧API/Worker/迁移/发布入口、Standalone/Vite/serve-product网站主链、旧Native候选发行链和无消费者工具。全部分批归档到项目外 `source-reviews/retired/galaxy-superseded-core-20261029`；Official最后一批717文件已按原相对路径与摘要保存。主树无旧内核、备份副本或旧路径转发壳。
- 共同来源：`packages/galaxy-contracts` 管共享合同与权限目录，`packages/galaxy-client` 管浏览器/Node SDK，`go/internal/databaseschema/sql` 管132份原迁移和四角色SQL（最高133、保留120空号）；生成器、工具和真实消费者已同步。
- 实际补齐：Go发行维护绑定、文件扫描策略预演、Native服务发现/根信任续期、隔离恢复调用Go lifecycle、SMTP测试投递审计类别、任务材料/A2A当前Go调用均已接通。Native原身份恢复码现含登记、同GUID恢复、新设备/下一代码、本人临时本机页和原操作回执；空身份宿主入口不再强制创建新GUID。恢复身份不等于恢复丢失私有资料或自动连接。
- 产物：项目外 `work/galaxy-reconstruction-implementation-20261029/server-final` 包含六个Linux amd64 Go服务及真实许可；`native-final` 是含最后恢复码/菜单修正的Windows amd64候选与准备包，宿主依赖17组件许可已收集。最终Native包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；包完整性和临时宿主配置通过，实际用户宿主安装仍pending，不改成功标志。
- 依赖与工具：Official仅保留zod/pg/AWS S3 SDK/nodemailer四项直接平台依赖，锁更新后干净安装42包；旧XMPP/OIDC/pg-boss业务依赖已退出该包。根pg-boss仅用于真实旧队列接管兼容回归。A2A CI补Go/隔离PG和独立Python环境，同一Python锁补6个Linux轮子哈希；下载校验不等于Linux运行。组件清单无过期Native/serve-product资源，API参考使用当前Go声明且仅声明其明确子集，不再以全Go源码指纹制造无关失效。
- 必要检查：网站与Admin生产构建、根TypeScript、默认标签下全部Go包及测试编译通过（没有执行全套测试）。当前领域按受影响范围完成隔离PG回归，Native恢复三项及独立无头本机页、相关宿主定向检查通过；最终Native二进制经真实MCP SDK读旧格式履历/原件及本人选择通过。AgentOS两模块12项、A2A Node参与1项及独立Python3项通过。文档54份/444本地引用检查无错误。
- 网页实际范围：最新Next源码独立无头代表流通过公开读取、论坛发布读取、私聊传输不可用时错误/草稿保留、后台反馈保存返回；不据此宣称成功聊天投递、生产登录或全站全部操作本轮重验。
- 保留与限制：JS继续承接Next/React、浏览器密钥/IndexedDB、宿主SDK/UI、A2A SDK及必要部署工具；Python继续承接Agno、LiteLLM与公开内容编译。Keycloak/Prosody/搜索/推荐/分析引擎仍按原职责保留。实际macOS、全部第三方宿主、用户本机安装及PG/Prosody/对象存储联合整站恢复未验收；R13固定程序策略仍限已接通且获准的动作，未放开任意全领域动作。没有恢复广泛模型、压力、活跃模拟或资料填充。

当前没有本轮未分派的源码接线或旧内核退出事项；上述目标平台与实际外部环境限制另行办理，不以本机结果冒充。正式上传/CI执行/部署须基于本轮冻结源码另行记录。

源码主库现为公开的 `agigalaxy-team/agigalaxy`。银河自有代码采用 Apache-2.0，第三方继续遵守原许可。功能源码已上传至 `74c21e8`，本轮对应 CI 的全部组件与 Runner Smoke 均已通过；原 site 归档 404 修复后仅补跑失败项，原失败记录保留。独立公开仓库已删除，完整本地 Git 历史保留在项目外 `source-reviews/retired/galaxy-public-repository-20261028`。

公开资料已对照原仓库两个保留分支的 42 个文件核对归属：专题、指南、宣言、示例与六份图像均已纳入；反馈表单合入根 `.github/`，重复阅读产物改为按需生成。现行开源措辞、旧仓库链接及迁移后的文档路径已复查，入门页与旧指南的失效源码导航已修正；带日期的历史版本仍按当时范围保留。

官网公开入口已同步：源码 `39bd37a` 构建的网站 0.1.110／运行包 `source-39bd37a` 已上线；`/open-source/`、首页底部、文档与开放网络页、`llms.txt` 和 `agent.md` 均提供当前主库及许可入口。四个 OpenPanel 对应源码包与四份说明已按原 URL／摘要恢复并纳入构建清单；网站 CI 原 404 失败项补跑通过，其余组件及 Runner Smoke 已通过。独立无头浏览器完成首页→源码→文档→返回、1920／1366 桌面检查，同一 document、无脚本错误与横向溢出；相关源码与服务器一致。未更改 CMS 快照、认证、业务服务或历史签名下载。

本次官网发布的临时资料已清理：本地 7 个文件和任务空目录、服务器 6 个临时上传及构建暂存目录均已移除；原始构建日志与截图只保留在仓库外的操作证据区。先前拒绝发生在复合删除命令执行前，改用完整绝对路径逐项删除后正常完成，无需改权限或安全配置。已核对实际代码提交的 CI 最终成功，不重复执行已通过且未改动的检查；后续提交仅更新状态记录。

前一轮服务器切换、源码同步和基础实际流程已完成；本轮全仓源码收束仍在推进。下列结果以实际进程、浏览器及原操作回执为准；本机平台验收范围见末节。

## 已真正接通

- 服务器当前 API、普通 Worker、内容发布器由 Linux Go 产物 `go-0.2.0-20261029-r6` 运行，HTTP 健康／就绪均正常，响应包含真实发行标识。旧 Node 领取者已停止。
- 原业务 schema 保留到 133；应用 Go jobs／storage 技术结构及原角色供应。唯一未执行旧 autonomy-tick 按原 UUID 接管至 River，没有重发已发出或未知结果，也没有重新设计用户数据。
- 官网与后台当前 Next.js 产物分别为 `go-ab0e084-site`、`go-ab0e084-admin`。前后台仍独立运行；Caddy 保留在用构建的 header／dpl 路由，不强制刷新旧页面。
- 独立无头浏览器已完成正式 Keycloak 密码登录、工作台进入、系统设置／用户列表／工作台往返；这些导航保持同一 document，脚本错误为零。OpenPanel 使用与留存资料能读取。
- 从实际设置页重新应用既有常规设置，原操作 `3fd549bc-045f-4099-b682-a90e1d5da0ad` 的内容发布账本为 `published`，没有更改品牌内容。
- 独立 Info 进程已启用，与 API 使用不同的私有 XMPP component；两条连接均已实际建立。四个 Go 服务在本次启动后的自动重启计数均为 0。
- 真实 AI 只读运行 `9949dc11-958d-4a19-8259-bc5134d11544` 已完成注册用户／账户摘要、维护队列及授权工作清单查询。返回注册用户总数 3,006，当前 AI 无权读取的公开内容查询保持拒绝；没有执行治理、发送或配置操作。重新进入及 Go 服务切换后可以接续原回复并显示复制按钮，无需重发。
- 本机正常入口和宿主持久请求已接 Go；Windows Native 产物的 9 项真实子进程流程通过。宿主类型及原 UI 生命周期测试的迁移适配已补齐，定向 9 项通过，TypeScript 检查通过；没有修改用户当前宿主安装。

## 当前配置状态

五岗位值守计划均保留“待启用”；没有替用户启用、改模型或增加授权。自动运行仪表已能读取真实状态，尚无有效样本时不补造处理趋势。权限、策略、账户绑定及已有启停状态继续保留。

公开资源已恢复完整 baseline，与 CMS 内容根分开；三个原失败文档／下载 URL 已按原字节恢复，site CI 归档校验通过。误装快照已移出运行目录。官网、社区、消息与账户导航的独立无头检查保持同一 document，无脚本错误或 1366 桌面横向溢出；消息／账户的未登录提示符合当前访问状态。随后使用已有受控账户完成真实登录、原对话与消息历史读取，在原单成员对话发送一条消息，重新登录及重新取历史后仍能读取；没有新建账户／房间。该定向结果不扩展为跨设备、多人或文件投递全覆盖。

## 已修复的收尾问题

- 开发代理缺少 Next HMR WebSocket，导致开发入口水合失败；已精确补接，实际开发入口反馈保存及返回通过。正常 standalone 与原 CMS 迁移路径也已通过。
- 新 Go loader 将公开 account／identity 配置误作秘密文件；已区分公开 metadata 与实际凭据，保留原配置 hash 和登录 scope，无需 chmod 原公开文件。
- Worker 原政策初始化越权已收敛为 API 初始化、Worker 读取已发布版本；Publisher 补齐启动恢复状态所需的最小 SELECT。
- AI 原会话的来源重核消费者、来源登记、publicReference 和原授权工作工具已接实际服务；真人工作台使用原人类权限读取自动运行概览，AI 与 Duty 继续各自验权。已通过三项受影响的定向 Go 检查及实际模型调用。策略就绪状态改为复用真实 ActionReady，不再因漏接回调固定显示未接通；原授权和操作卡要求不变。
- 信任续期 helper 引用旧模块路径且校验旧发行；已接当前 Go 配置，沿原密钥将签名文档从 sequence 54 续为 55，没有轮换身份。Info 采用独立受限凭据，并随正常信任续期接续；修复后原续期 service 实际执行结果为 success／0。

## 实际边界与资料位置

仍保留 Next.js／Payload、Keycloak、Prosody、Agno／AgentOS、LiteLLM、Meilisearch、Gorse、OpenPanel 及有真实用途的宿主／运维 helper。Go 重构不表示移除这些组件，也不以 GitHub 语言比例判定完成。

macOS、全部第三方宿主及用户真实本机安装未完成平台验收；旧已发行签名包不改字节。当前有在用旧网页构建保留进程，未为清理而中断其资源。没有恢复全系统压力或广泛模型测试。

现行实现与部署方式见 [Go 核心计划](docs/technical/go-core-plan.md)、[部署说明](docs/operations/deployment.md)、[Go 发行接线](go/deploy/README.md)。本轮操作记录集中在项目外 `ops-log/operations/2026/10/2026-10-28-galaxy-go-design.jsonl`，浏览器证据在 `work/galaxy-go-deploy-20261028/browser`；被替代的长状态记录已移至项目外历史区，不再混入当前正文。
