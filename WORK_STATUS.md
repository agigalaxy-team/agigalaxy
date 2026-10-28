# 当前工作

## 当前任务与状态

2026-10-29：服务器与本机 Go 核心收束、GitHub 同步及服务器实际部署。保留现有页面、业务、数据、ID／UID／绑定和专业组件；旧压力测试、模拟活跃及资料填充仍停止。

源码主库现为公开的 `agigalaxy-team/agigalaxy`。银河自有代码采用 Apache-2.0，第三方继续遵守原许可。已上传 `a86ed65`；其 CI 的 core、web、hub、Native、contracts、auth、admin 等组件已通过，site 因部署资源目录误选导致归档 404，正在修复并只补跑失败项。独立公开仓库已删除，完整本地 Git 历史保留在项目外 `source-reviews/retired/galaxy-public-repository-20261028`。

本轮仍在收尾，不把构建、健康检查或模型回答单独当作整轮完成。下列状态以实际运行和操作回执为准。

## 已真正接通

- 服务器当前 API、普通 Worker、内容发布器由 Linux Go 产物 `go-0.2.0-20261028-r3` 运行，HTTP 健康／就绪均正常，响应包含真实发行标识。旧 Node 领取者已停止。
- 原业务 schema 保留到 133；应用 Go jobs／storage 技术结构及原角色供应。唯一未执行旧 autonomy-tick 按原 UUID 接管至 River，没有重发已发出或未知结果，也没有重新设计用户数据。
- 官网与后台当前 Next.js 产物分别为 `go-ab0e084-site`、`go-ab0e084-admin`。前后台仍独立运行；Caddy 保留在用构建的 header／dpl 路由，不强制刷新旧页面。
- 独立无头浏览器已完成正式 Keycloak 密码登录、工作台进入、系统设置／用户列表／工作台往返；这些导航保持同一 document，脚本错误为零。OpenPanel 使用与留存资料能读取。
- 从实际设置页重新应用既有常规设置，原操作 `3fd549bc-045f-4099-b682-a90e1d5da0ad` 的内容发布账本为 `published`，没有更改品牌内容。
- 本机正常入口和宿主持久请求已接 Go；Windows Native 产物的 9 项真实子进程流程通过。宿主类型及原 UI 生命周期测试的迁移适配已补齐，定向 9 项通过，TypeScript 检查通过；没有修改用户当前宿主安装。

## 当前剩余

1. 信息订阅进程：独立 Info 身份、两池角色和 Prosody 只读 component 已配置。已修复 pgx options 空格编码及 systemd 私有 `0440` 凭据兼容，等待最终整包部署和实际启动。
2. AI 原会话：已定位并补写保存来源的真实 Revalidate 消费者、来源登记及 publicReference 原合同；正在补齐原“列出／运行已授权工作”的实际 owning 消费者。完成后集中构建和有限实际 AI 调用，不清除原会话或放宽权限。
3. 网站公开资源：打包时误用 CMS 快照作为 baseline，正在恢复原完整公开资源字节；CMS 内容根保持独立。恢复后补跑 site 失败作业。
4. 最后发行、GitHub 同步、必要实机回读，以及本状态和部署正文的终态更新。

## 已修复的收尾问题

- 开发代理缺少 Next HMR WebSocket，导致开发入口水合失败；已精确补接，实际开发入口反馈保存及返回通过。正常 standalone 与原 CMS 迁移路径也已通过。
- 新 Go loader 将公开 account／identity 配置误作秘密文件；已区分公开 metadata 与实际凭据，保留原配置 hash 和登录 scope，无需 chmod 原公开文件。
- Worker 原政策初始化越权已收敛为 API 初始化、Worker 读取已发布版本；Publisher 补齐启动恢复状态所需的最小 SELECT。
- 信任续期 helper 引用旧模块路径且校验旧发行；已接当前 Go 配置，沿原密钥将签名文档从 sequence 54 续为 55，没有轮换身份。Info 采用独立受限凭据，并随正常信任续期接续。

## 实际边界与资料位置

仍保留 Next.js／Payload、Keycloak、Prosody、Agno／AgentOS、LiteLLM、Meilisearch、Gorse、OpenPanel 及有真实用途的宿主／运维 helper。Go 重构不表示移除这些组件，也不以 GitHub 语言比例判定完成。

macOS、全部第三方宿主及用户真实本机安装未完成平台验收；旧已发行签名包不改字节。当前有在用旧网页构建保留进程，未为清理而中断其资源。没有恢复全系统压力或广泛模型测试。

现行实现与部署方式见 [Go 核心计划](docs/technical/go-core-plan.md)、[部署说明](docs/operations/deployment.md)、[Go 发行接线](go/deploy/README.md)。本轮操作记录集中在项目外 `ops-log/operations/2026/10/2026-10-28-galaxy-go-design.jsonl`，浏览器证据在 `work/galaxy-go-deploy-20261028/browser`；被替代的长状态记录已移至项目外历史区，不再混入当前正文。
