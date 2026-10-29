# Galaxy Hub 运行接线与公开资料

业务 API、Worker、Information Worker、迁移和内容发布的现行核心在 [go/](../../go/README.md)。本目录维护公开资料及编译器、部署配置、反代、邮件与模型服务采用、监控、备份恢复和平台辅助接线，不提供第二套 Node 业务服务。

| 工作 | 当前入口 |
|---|---|
| API / Worker / Information Worker | `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker` |
| 显式迁移、生命周期维护、内容发布 | `galaxy-migrate`、`galaxy-lifecycle`、`galaxy-publisher` |
| JS/Go 共享合同与权限投影 | `packages/galaxy-contracts`、`scripts/go/generate-permission-catalog.mjs` |
| 浏览器与 Node HTTP SDK | `packages/galaxy-client` |
| 系统与外部组件接线 | 本目录 `deploy/`；`support/` 仅提供平台辅助，不复制业务服务 |
| 公开文档 | `public-docs/manifest.json` 与 `scripts/build_public_docs.py` |

`npm start`、`npm run worker` 等是选择已有 Go 产物的本地启动便利命令，要求明确 `GALAXY_RELEASE_DIRECTORY` 及对应发行/配置引用，不构建、不迁移、不自行启动外部组件。构建使用根 `npm run build:hub`，定向 Go 检查使用 `node scripts/check-go.mjs hub`。Node 依赖服务于保留的平台工具与网页，不代表业务进程仍由 Node 运行。

平台工具保留真实调用链：`deploy/maintenance-agent/server.mjs` 使用受限本机接口及 Go lifecycle 恢复桥；`deploy/system-settings/` 负责邮件和外部服务配置、探测与读取采用回执。API 和 Worker 的实际采用回执由 Go `internal/systemsettings/adoption.go` 产生，平台端只确认对应版本、进程和已加载配置。`deploy/operations-stack/manage.mjs` 管理备份和隔离恢复；`scripts/verify-attachment-adapters.mjs` 是需要显式配置的对象存储与扫描器检查，`scripts/collect-oci-cost.mjs` 是监控服务的采集入口。公开资料生成器与信任包、治理材料和 Caddy 候选工具也保持独立命令，不启动旧业务服务。

这些 Node 平台入口直接使用 `zod`（配置校验）、`pg`（维护数据库连接）、`@aws-sdk/client-s3`（对象存储恢复/检查）和 `nodemailer`（邮件探测与配置）；共享合同和治理工具各自还通过其所属包使用 `canonicalize`、`jose` 和 `zod`。具体安装与锁文件由对应工作区维护；本说明不将其他已退役业务服务依赖当成平台要求。

PostgreSQL 的业务角色、迁移角色、CMS、认证、Prosody 与对象存储边界保持分离；公开健康状态不能代替真实业务回执。隔离回归、真实外部检查和平台验收分别说明，当前剩余工作见 [WORK_STATUS](../../WORK_STATUS.md)。架构与运行说明分别见 [architecture](../../docs/technical/architecture.md)、[deployment](../../docs/operations/deployment.md)。
