# 银河 Go 核心

正式范围和迁移顺序见 [实施计划](../docs/technical/go-core-plan.md)，实际接线、检查结果和剩余限制统一见 [WORK_STATUS](../WORK_STATUS.md)。本目录提供服务器与本机核心的本地 Go 候选；源码接通、目标平台验收和生产切换分别记录，不能用本地产物代替正式切换安排。

## 构建与定向检查

使用 Go 1.27.3，在本目录执行：

```sh
go build ./cmd/...
```

阶段成果后仅对本批受影响包和实际入口执行 `go test`，复用未修改部分的既有结果；不默认重复全模块检查。

跨语言检查还需要现行 Node 依赖。PostgreSQL 集成检查通过 `GALAXY_GO_TEST_PG_BIN` 指定 `initdb`、`pg_ctl` 所在绝对目录；检查器只创建操作系统临时目录中的独立数据库，监听 loopback，结束后关闭。未提供时会明确跳过，不能据此报告数据库检查通过。它不读取生产 `DATABASE_URL`。

Native 开发入口：`galaxy native --config <现有绝对配置路径>`。只列出当前真正迁入的工具；不得据此改写正式宿主配置。`galaxy identity --config ...` 只读取公开身份资料。`galaxy host --config ...` 是宿主插件继承stdin/stdout的专用JSONL通道，用于原履历／原件持久处理，不是模型工具或网络服务。Go CLI的`host-configs`可生成候选宿主配置，`setup`先展示实际来源和目录、取得本人确认后才办理；当前仅在临时目录检查，不自动安装。命令参数见`galaxy --help`。

无服务配置的本机入口是 `galaxy integration-mcp --data-dir <目录>`；薄宿主菜单使用私有 `integration-host` 通道。二者忽略服务配置、不构造联网Runtime；目录依次取明确参数、`GALAXY_DATA_DIR`、默认 `.galaxy`。宿主源码默认Go，不隐式回退旧JavaScript持久核心。

## AI Agent 运行与接入边界

`galaxy-api` 已接门户、反馈、账户与私人资料、设备与身份关联、社区、私聊、收藏关注、业务角色与人员授权、自动授权／AI委派配置、本人导出／删除请求、网页事件和内容发布命令。公开签名资料与v1/v2历史使用同一当前授权投影；本人导出复用原18类来源，公开删除执行沿原不可用语义，批准后的DB执行由独立维护命令承接。入口读取现有 `DATABASE_URL`、`GALAXY_ENDPOINT`、`GALAXY_ACCOUNT_CONFIG_FILE`、`GALAXY_OPERATIONS_CONFIG_FILE`、`GALAXY_IDENTITY_CONFIG_FILE`，附件使用原 `GALAXY_ATTACHMENTS_CONFIG_FILE` 或 `CREDENTIALS_DIRECTORY` 配置，不另复制凭据。监听使用 `GALAXY_LISTEN_HOST`／`PORT`，默认 `127.0.0.1:3001`；在独立环境选择未占用端口，不停止或覆盖当前服务。

受控设备沿用 `GALAXY_SIGNING_KEY_FILE`、`GALAXY_SIGNING_KEY_ID`、`GALAXY_ROOT_PINS_FILE`、`GALAXY_KEYRING_FILE`、`GALAXY_TRUST_DIRECTORY`；五项全缺时开发入口只开放不依赖设备签名的能力，部分缺失会拒绝启动，不降级验签。服务状态读取原 `GALAXY_RETIREMENT_FILE`／`GALAXY_INCIDENT_FILE`；资源写入使用原 `GALAXY_RESOURCE_BUDGET_FILE` 及默认限制。社区沿用原论坛、额度及治理配置，私聊使用 `GALAXY_CHAT_CONFIG_FILE`；未配置或连接不可用时不会假造投递成功。HTTP外层统一采用原浏览器／请求配额策略。各领域实际接线和未覆盖范围见当前状态，不能直接据此替换生产。

API与Worker日志沿用 `GALAXY_RUNTIME_LOG_*` 配置；指标沿用 `GALAXY_METRICS_PORT`、存储／成本等配置，独立监听loopback，备份文件收集按原职责只在API启用。指标记录实际HTTP状态、已读／已写字节及耗时，不捕获正文或凭据。原 `public-docs.json` 通过 `GALAXY_PUBLIC_DOCS_FILE` 指定；正式产物仍须纳入该资源，不能用缺文件回退成空文档。Agno连接仍读取`GALAXY_AGENTOS_CONFIG_FILE`；不在启动时调用模型，传输禁止隐式重发业务POST，未知结果沿保存的原操作读取。持久对话、值守、岗位、工作台查询与操作卡复用同批实际领域服务，模型运行完成不等于业务已完成。

启动不迁移、不创建角色、不启动模型或接管队列；API、Worker和发布器都保留原恢复状态检查，隔离中的恢复库不能开放处理。配置设备签名时会维护原公开信任历史，不改写私钥。根管理员仍来自原受保护预配置，普通账户与管理账户分别认证；Go 域服务必须绑定真实门户身份，并在业务事务中重核当前权限。不得以请求头自报角色、伪造扫描结果或放宽权限完成联调。

`galaxy-worker` 与 `galaxy-publisher` 分别使用原证据处理、内容发布数据库角色；后者使用原 `GALAXY_CONTENT_PUBLISHER_CONFIG_FILE` 和 `GALAXY_OPERATIONS_CONFIG_FILE`，不读取用户门户Cookie或刷新密钥。`galaxy-migrate` 单独提供显式技术迁移。队列必须由维护流程明确选择River后才能执行；API仅在已启用的端点装配发布生产者。周期计划存储在`galaxy_go_jobs.schedules_v1`且事务入队，原任务与周期接续通过显式维护命令办理，不自动重放未知结果。私聊与论坛附件沿原受限扫描／清理服务维护，发布暂停不冒充存储保留暂停。消息沿原`GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE`受保护引用和业务目录读取；未配置时不会假成功或实际投递。旧Node消费者不会读取新门，切换前必须停止相应旧消费者，不能同时运行两套领取者。

普通与管理登录已承接原OIDC回调；已保存的可续期会话只有在原密钥、Provider和配置作用域一致时才能接续。暂时认证故障与刷新结果未知返回未确认错误，不自动注销或再次交换原凭据；业务写入结果未知只查原操作。后台事件以真实Gateway当前权限核验；网站／设备来源仍分别检查当前资格及用途，不能因存在数据库行就授权。反馈字节存储与扫描使用原业务流程；启动API不表示异步消费者已接管，未配置能力不能用空数组或成功占位替代。

GitHub 上传、正式数据库变更、认证改配、服务切换及宿主安装不是当前本地开发入口的隐含动作。

服务器开发候选通过仓库原组件入口 `components.mjs build --component hub` 构建，Native沿原`native-client`组件生成Go候选；`scripts/build-go-core.mjs`仍可生成一次合并审阅包，不另建重复组件。Go默认从PATH取得，也可用`GALAXY_BUILD_GO`指定编译器绝对路径。产物、双池Information Worker和平台资源见[运行样例](deploy/README.md)。构建与必要联测分别安排，不用重复编译作为额外检查门禁。候选清单不表示全迁移或平台验收已完成。

专业搜索／推荐／分析沿原 `GALAXY_DISCOVERY_CONFIG_FILE`。API使用当前论坛读取与管理身份；Worker要求原sourceMetadata，独立池按原当前资格索引及投递，未配置不启动该消费者，不在Worker重配专业引擎。真实专业组件、目标平台与正式切换的未覆盖限制统一见当前状态。
