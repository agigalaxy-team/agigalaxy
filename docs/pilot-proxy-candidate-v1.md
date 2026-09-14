<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/c5/c578389593b420fc67413c0ce9e9978174d486ddf8efdacd391875b12eb0a4aa.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Official 公开代理候选 v1

维护接续：Caddy2.11.4升级及整机重启已完成；后续Official切换使用维护目录galaxy-pilot-runtime.conf，旧覆盖会选回旧版本。[实际维护结果](../../../GALAXY_HOST_MAINTENANCE_COMPLETED_2026-09-11.md)。

2026-09-11在选定Oracle主机准备，尚未启用。候选直接使用Caddy对现有 `/etc/caddy/Caddyfile` 的适配结果，复用当前 `officialRoutes` 精确Host/路径/方法清单，仅向HTTPS服务器srv0前置两条Official路由，其余结构逐项保持一致。

目标为 `https://official.agigalaxy.org` → `127.0.0.1:3201`。这是pilot候选地址和端口，不是已可访问服务；不会代理到测试身份的integration端口3101。原官网 `agigalaxy.org` 与www跳转、监听、TLS自动化、日志和 `admin off` 保留。

## 已准备文件

目标目录 `/etc/galaxy/proxy-candidates/pilot-20260911-1`：

- `current.adapted.json`：当前Caddyfile的适配配置，root私有。
- `caddy.candidate.json`：完整候选，root/Caddy组0640；目录0750，Caddy服务用户可读取。
- `caddy-pilot.service.conf`：待安装的systemd覆盖，替换ExecStart为准确候选路径、清空ExecReload；尚未放入服务覆盖目录。
- `tools/`：本次生成器的准确源码副本与既有路由模块，摘要记录在项目证据中。

当前Caddyfile SHA256为 `0cfeb031cb84804dc2352cfed462546fae8ef946bd06c57b818a3d8f8878e155`，候选SHA256为 `5cd73a5cf113453e87b9a6f32437ff58197ad644bcc8dab9f58f7960fb513aa1`。两项本地检查证明既有配置保持与Host冲突处理；目标机以实际Caddy用户运行 `caddy validate --config <候选>` 返回0。运行中的Caddy PID和配置摘要不变。

## 重建入口

使用Caddy适配后的JSON，而不是手工重写现有官网：

```text
node packages/galaxy-official/scripts/prepare-caddy-candidate.mjs <绝对当前JSON路径> <HTTPS服务器名> <准确Official HTTPS origin> <API端口> <全新候选JSON路径>
```

生成器保留输入，拒绝覆盖输出；如果目标Host已被现有精确或通配Host规则占用，或者目标服务器关闭证书自动化，则需要先解决具体配置差异。源JSON可能含私有运营配置，保留在目标受限目录，不放进公开仓库或聊天。

## AI Agent 切换准备与回退

准备步骤已完成；实施前还需独立pilot身份、配置、密钥/数据库、真实运营资料及相关业务验收。重新核对Caddyfile和候选摘要，并验证pilot端口；原配置已变化时必须重建候选。候选指向尚未启动的3201，不能仅因语法检查通过而切换。

首次启用将涉及Official DNS、公共证书，以及安装上述systemd覆盖后短时重启Caddy。当前admin关闭，不能使用reload；覆盖明确清空ExecReload，避免误加载旧Caddyfile。重启影响同一Caddy承载的官网，必须属于当次明确发布范围。当前没有执行这些动作。

具体切换记录需保存原Caddy配置/服务配置摘要、DNS原值、pilot发行摘要与检查结果。失败时撤下本次准确的systemd覆盖、daemon-reload并重启原Caddy服务，核对官网；按已记录原值撤回本次DNS变化。原Caddyfile未被候选生成器改写。不能用清库、删除卷或恢复退役代理充当回退。

本次未申请公共证书、未验证外部Official HTTP/TLS、未重启Caddy、未开启管理端口。完整配置校验是发布准备证据，最终发布仍按C01-07/08和共同验收执行。
