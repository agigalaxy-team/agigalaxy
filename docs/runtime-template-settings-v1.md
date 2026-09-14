<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/2f/2ffef3f9829da58ff4406369854650aba265f1b61643dfcd51c57d5ae31ec5ad.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 三环境部署模板与运行策略

2026-09-11当前实施：同机Linux的local/pilot已完成独立材料、用户和数据库安装；三环境隔离通过，local启动及keyring刷新再启动通过。全部数据库/API/Worker现已停止；pilot运营字段待补、业务未启动、公开信任未发布。不是Windows本机Linux服务，也不是三个独立故障域。[当前操作与证据](isolated-environment-operations-v1.md)。以下保留各早期批次记录，未配置/未应用等描述只代表其当时状态。

`prepare-linux.mjs` 现在生成 local、integration、pilot 三套文件，继续使用现有 systemd、Compose 和角色独立的 EnvironmentFile。生成器只写新候选目录，不连接服务器，不生成口令或密钥，不启动服务。`local` 指本机 Linux 服务环境；Windows 上可以生成候选和运行源码测试，不代表已经有本地 Linux 服务。

|环境|逻辑 endpoint|API|PostgreSQL|API/Worker 指标|
|---|---|---:|---:|---|
|local|https://official.local.invalid|3001|15332|9211 / 9212|
|integration|https://official.integration.invalid|3101|15432|9311 / 9312|
|pilot|https://official.agigalaxy.org|3201|15532|9411 / 9412|

全部监听仍绑定 loopback。数据库名为 `galaxy_<环境>`，三个 LOGIN 名为 `galaxy_<环境>_api/worker/migration`；Compose 项目、命名卷、API 私有目录、日志和公开配置目录分别按环境命名。同机端口隔离不等于独立故障域，也不能证明密钥内容独立。

## 可选配置输入

原来的四个参数保持可用，第五个可选参数是公开设置 JSON 的绝对路径：

```sh
node packages/galaxy-official/scripts/prepare-linux.mjs "$RELEASE" "$MANIFEST_SHA256" "$PINS" "$OUTPUT" "$SETTINGS"
```

`RELEASE` 为现有已核验固定发行目录，`MANIFEST_SHA256` 为它的准确摘要，`PINS` 为已选运行时摘要文件，`OUTPUT` 必须是尚不存在的候选目录，`SETTINGS` 使用 [结构示例](../packages/galaxy-official/deploy/runtime-settings.example.json)。这些变量需先由实际部署资料确定；命令不会发现凭据。

输入包含 `version: 1` 和 `stages`，后者可分别提供 local/integration/pilot。每个环境接受：

|字段|用途与缺省行为|
|---|---|
|operator|已确认的运营者显示名称；缺少时保留明显占位值，候选标记未配置|
|operatorRef|配置审计中的运营者引用；缺少时保留占位值|
|region|运行区域；local 默认 local-development，其余沿用本项目已选 ap-kulai-2|
|requestQuotaPolicy|复用现有请求限额 Schema；未提供时复制当前程序开发默认值|
|resourceBudgetPolicy|复用现有存储、队列、导出及并发资源 Schema；未提供时复制当前程序开发默认值|
|searchIndexEnabled|显式 true/false 才写入 Worker 环境；未提供时保持 unconfigured，不用部署准备改变既有索引状态|

设置文件拒绝未知字段，不接受数据库口令、签名键或账户令牌。运营联系渠道、正式预算、保留期限和公开责任仍在项目运营资料中确认；填入 operator 不代表这些决定已完成。

## 生成文件及读取权限

每个环境包含 API、Worker、迁移三份 `.env.example`，Compose、首次数据库登录角色 SQL、Official 路由候选、`configuration.json`，以及五个 `runtime/*.json` 文件：请求限额、资源预算、空治理配置、环境显示配置和空身份提供者配置。

`prepare-layout.sh <环境>` 把这五份不含秘密的运行策略放到 `/var/lib/galaxy/config/<环境>`，目录 root:root 0755、文件 root:root 0644。API 和 Worker 可以读取；普通运行用户不能改写。已有不同内容会停止并要求处理具体差异，脚本不会覆盖当前策略。秘密仍位于独立 `/etc/galaxy/<环境>` 或 API 私有目录，不进入公开策略目录。

API 读取五份策略；Worker 只引用资源预算，不继承 API 的签名、身份、治理字段；迁移不携带上述运行策略。指标的磁盘观察路径使用各自日志目录。身份提供者和治理角色初始为空，Personal MCP、事故与退出配置保持未配置；要启用这些既有功能，应沿用各自明确配置和治理流程，不能把模板准备当作功能开放。

EnvironmentFile 对包含空格、引号和反斜杠的值进行双引号转义，并拒绝多行值；内部 `$` 按文件语义保持字面量，不作为 Shell 命令执行。依据 [systemd 官方 EnvironmentFile 文档源码](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml)。

`configuration.json` 保留设置来源与缺项：开发默认值不是正式预算；`activated` 始终为 false。数据库口令与 API 签名材料仍未生成，`.env.example` 不能直接当作已具备真实身份的运行配置。

## 本次验证及 AI-agent 操作

三套模板的 9 份角色环境通过当前隔离检查；12 个端口各自独立，15 份策略经实际程序读取函数通过。检查还覆盖跨环境路径、角色字段、显式索引开关、单环境预算覆盖、缺少配置及异常输入。生成器用当前选定的 cost 固定发行完成实际 CLI 输出，两个 shell 脚本语法通过。

这些证据没有证明 target Linux 的实际权限、独立密钥、三套数据库运行、公共 DNS/TLS 或用户验收。运行前先核对目标环境、当前发行与旧文件差异，再从对应凭据渠道提供独立材料；不要复制 integration 身份到 pilot，不输出数据库 URL 或私钥，不用删除卷来解决配置问题。实际启停继续按 [Linux 部署步骤](linux-deployment-v1.md) 执行。
