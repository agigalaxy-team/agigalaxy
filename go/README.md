# 银河 Go 核心

正式范围和迁移顺序见 [实施计划](../docs/technical/go-core-plan.md)，当前完成情况见 [WORK_STATUS](../WORK_STATUS.md)。当前仍在迁移开发中，不能用本目录的部分 API 或 Native 工具替换完整现行发行版。

## 构建与定向检查

使用 Go 1.27.3，在本目录执行：

```sh
go build ./cmd/galaxy ./cmd/galaxy-api
go test ./...
```

跨语言检查还需要现行 Node 依赖。PostgreSQL 集成检查通过 `GALAXY_GO_TEST_PG_BIN` 指定 `initdb`、`pg_ctl` 所在绝对目录；检查器只创建操作系统临时目录中的独立数据库，监听 loopback，结束后关闭。未提供时会明确跳过，不能据此报告数据库检查通过。它不读取生产 `DATABASE_URL`。

Native 开发入口：`galaxy native --config <现有绝对配置路径>`。只列出当前真正迁入的工具；不得据此改写正式宿主配置。`galaxy identity --config ...` 只读取公开身份资料。

## AI Agent 运行与接入边界

`galaxy-api` 当前接通反馈 HTTP 入口，读取现有 `DATABASE_URL`、`GALAXY_ENDPOINT`、`GALAXY_ACCOUNT_CONFIG_FILE`、`GALAXY_OPERATIONS_CONFIG_FILE`、`GALAXY_IDENTITY_CONFIG_FILE`，不另复制凭据。监听使用 `GALAXY_LISTEN_HOST`／`PORT`，默认 `127.0.0.1:3001`；在独立环境选择未占用端口，不停止或覆盖当前服务。

启动只读取配置及数据库，不迁移、不创建角色、不启动模型或接管队列。根管理员仍来自原受保护预配置，普通账户与管理账户分别认证；Go 域服务必须绑定真实门户身份，并在业务事务中重核当前权限。不得以请求头自报角色、伪造扫描结果或放宽权限完成联调。

当前登录签发及其余领域尚未全部迁入；已保存的可续期会话只有在原密钥、Provider 和配置作用域一致时才能接续。暂时认证故障与刷新结果未知返回未确认错误，不自动注销或再次交换原凭据；业务写入结果未知只查原操作。附件上传／扫描／下载、事件订阅及其他尚未接通的部分不能用空数组或成功占位替代。

GitHub 上传、正式数据库变更、认证改配、服务切换及宿主安装不是当前本地开发入口的隐含动作。
