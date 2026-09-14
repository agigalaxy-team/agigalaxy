<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/11/11b0e072cd7a07a424656dc709bb20070c38e8fe8fffc6341570a11df5135360.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 独立运行环境配置

2026-09-11当前实施：同机Linux的local/pilot已完成独立材料、用户和数据库安装；三环境隔离通过，local启动及keyring刷新再启动通过。全部数据库/API/Worker现已停止；pilot运营字段待补、业务未启动、公开信任未发布。不是Windows本机Linux服务，也不是三个独立故障域。[当前操作与证据](isolated-environment-operations-v1.md)。以下保留各早期批次记录，未配置/未应用等描述只代表其当时状态。

2026-09-11模板完善：local/integration/pilot现在均有完整生成入口、9份角色环境和15份可被当前加载器读取的公开策略；真实口令、独立签名材料与目标启动仍是后续步骤。新增候选未应用，C01-04仍进行中。详见[三环境运行模板](runtime-template-settings-v1.md)。

2026-09-11目标实施：Oracle 的 integration 已建立三个独立 Linux 用户、独立 PostgreSQL 容器/卷、API/Worker 登录角色及服务器内生成的测试签名根。真实进程 UID、文件访问隔离、受限数据库角色、HTTP 读写与重启后事实/撤销保留已通过；结束后服务停止，配置和数据保留。pilot 未配置，这一结果不替代完整环境及正式身份隔离验收。操作入口见[Linux部署说明](linux-deployment-v1.md)。

C01-04实现进展：server.mjs、worker.mjs、migrate.mjs在打开数据库前执行assertRuntimeEnvironment。API在加载签名键前另校验真实文件路径。现有业务类与合成测试注入方式保持不变；没有迁移/删除任何现有数据库。

所有可执行入口必须显式设置GALAXY_ENVIRONMENT=local、integration或pilot；DATABASE_URL的库名分别必须是galaxy_local、galaxy_integration或galaxy_pilot。URL必须有明确host/user，禁止查询参数和fragment，避免pg选项覆盖目标库/主机；没有缺省环境或自动重命名。TLS配置需要独立受审配置入口，本实现不声称提供远程TLS参数支持。当前可按隔离本地数据库或主机内私有连接部署设计继续验证。

API需要GALAXY_ENVIRONMENT_DIRECTORY为预先创建的绝对目录，末段等于环境名称。GALAXY_SIGNING_KEY_FILE、GALAXY_ROOT_PINS_FILE、GALAXY_KEYRING_FILE和GALAXY_TRUST_DIRECTORY必须是其内部绝对路径，且已存在；真实路径必须与配置路径一致，拒绝符号链接或junction别名。GALAXY_SIGNING_KEY_ID必须非空。其余既有endpoint/operator/region/签名与pin检查不变。

Schema19起，API在trust目录中持久保存`http-failure-audit.sqlite`及其SQLite辅助文件，目录须可写且在重启后保留。它只含筛选后的失败上下文，仍应按私有运营数据保护；Worker不打开它。新配置字段无需增加。[队列容量、恢复及迁移规则](failure-audit-delivery-v1.md)。

Worker和迁移进程不得携带上述签名/根pin/keyring/trust字段，包含空字符串也拒绝。为进程分别构造配置，不继承整份API环境。数据库各角色仍须按既有SQL实施最小权限，迁移角色不用于API/Worker。迁移入口的配置错误现在也以migration_failed记录，不在catch之外泄露连接异常。

## AI-agent配置与验证步骤

1. 选择明确环境，创建独立数据库及API/Worker/迁移账号；不要自行重命名或迁移旧库。
2. 准备该环境独立目录和签名信任材料。真实秘密保持在代码仓外、通过授权渠道注入；部署代理不打印DATABASE_URL或密钥。
3. API、Worker、迁移使用单独进程环境，启动前核对字段名和路径，不复制整个Shell环境。API的trust目录需提前创建。
4. 运行runtime-environment.test.mjs和worker-boundary.test.mjs；有效隔离fixture通过，跨库、路径越界、目录别名、签名配置继承、未指定环境均拒绝。
5. 在目标主机验证真实UID/ACL、数据库实际角色、监听与网络隔离、签名根独立性和恢复。配置检查不能识别两个文件是否复制了同一密钥，也不能防止有目录写权限的恶意进程在检查后替换文件；主机权限仍是必要边界。

本批4项针对性测试与lint通过；未运行真实服务与数据库连接、真实宿主、远程部署或全套回归。既有部署配置必须补充新字段才能启动；不自动降级放过缺失配置。恢复旧可执行代码会去掉本检查，故不应以回退绕过环境不匹配，应修复配置后重新验证。

现有源码快照d0ae15bd属于本次变更前的检查点；未来发行需要重新打包，不宣称该旧快照含本文件或新检查模块。C01-04仍有环境实际隔离及共同M0验收未完成。

2026-09-10事故处置：事故配置接通API写入/分享暂停、Worker新任务暂停、公开状态和明确恢复；复用撤销处理，配置版本与恢复引用留痕。显式配置 `GALAXY_INCIDENT_FILE`，API和Worker重启后生效。7项相关测试/lint通过，未运行真实多实例切换或外部通知。详见 `docs/incident-response-v1.md`。

2026-09-10事故通知：事故私有站内通知接通运营显式投递、本人分页/已读/偏好、原生收件箱及导出/删除清单；真实API/Worker暂停恢复已验证。当前Schema29/38表，迁移后重应用api-role.sql；新客户端包含incident通知ID和偏好以及新增本人导出集。23项相关测试、隔离PG2项、lint/严格tsc及离线安装通过。详见 `docs/incident-notifications-v1.md`。
