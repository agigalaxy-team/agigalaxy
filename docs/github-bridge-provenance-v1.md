<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/e7/e7fbaca76c9f021f8c4f12b0788d2fb322ac08386d5b77ccf5c1836051d14fed.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# GitHub Bridge 来源与复制计数

2026-09-10，C15-04。现有 GitHub Actions 适配器增加仓库所有者 API 观测，Proof 保留该观测，履历按稳定上游对象分组；独立客户端可核验多个 issuer 提供的 CI Proof 并识别重复来源。没有启用 Federation 或部署动态服务。

## 与原需求对应

原任务要求 Bridge Mapping Declaration 包含来源对象、映射、强度上限、授权、版本、去重和撤销，并明确“首个Bridge优先GitHub；记录来源控制权及重复来源，跨Hub复制不增加独立证据数”。本批在既有登记、Consent、队列、Evidence 和 Proof 链上实现上述行为，原验收条件保留。

GitHub 的 [workflow run attempt API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt) 支持按运行编号及尝试次数读取公开运行。本实现沿用已有匿名公共 HTTPS reader 和准确路径；无需安装新的 GitHub SDK、加载远程插件或使用仓库凭据。CI 元数据与仓库所有者字段来自该响应；不据此断言某个 Galaxy ID 控制仓库。

## Mapping Declaration

`@galaxy/client/proofs` 导出 `githubBridgeMapping`，建设者原生 Bridge 登记表也默认填入同一份参考映射。它说明：

| 项目 | 当前实现 |
|---|---|
| 来源 | GitHub Actions workflow-run-attempt |
| 映射 | 已选运行引用 → 有界 API 观测 → Evidence → 单独批准的有限 CI Proof |
| 强度上限 | execution-observation；CI 执行事实，repository-controlled |
| 授权 | 公开 GitHub 匿名读取；Galaxy Evidence/Proof 分别使用准确内容 Consent |
| 版本 | 现有 github-actions-api/0.1；新增可选来源控制字段，不重写旧签名 |
| 去重 | 数字 repositoryId / runId / attempt 识别上游来源；保留不一致的 commit/conclusion |
| 撤销 | 当前授权、绑定、来源重验和 Proof 撤销控制在线视图；离线核验单独标注局限 |

登记参考映射不安装执行代码，也不授予源仓库访问权。已有其他 Bridge 映射保持原值，用户仍需检查并确认自己的实际声明。

## 来源控制记录

新的 GitHub 观测附带可选 `sourceControl`，并进入本次 Proof 发布预览及签名正文：

```json
{
  "version": 1,
  "observedVia": "github-rest-api",
  "repositoryOwner": {"id": 77, "login": "example", "type": "Organization"},
  "submitterControlVerified": false,
  "independentExecutionVerified": false
}
```

这里是示例数字，不是真实用户资料。来源响应缺少所有者对象时记录 `repositoryOwner: null`；已有观测/Proof 没有该字段时继续读取，明确显示未记录。出现所有者对象但字段无效，或 login 与准确仓库引用不符时，不能形成有效观测。

仓库的 GitHub 所有者记录不等于提交者、工作流作者或审核人的控制权认证。操作者、执行环境与任务质量的推断仍受现有有限 CI 强度约束。旧私有配置、身份、签名、Case 引用和本机存储键不改变。

## 稳定来源分组

观察后的来源键为：

```text
github-actions:repository:<numeric repositoryId>:run:<runId>:attempt:<attempt>
```

仓库显示名称、登录名、接收 Hub、Proof ID、Galaxy ID 和转发次数不参与该键。数字仓库、运行和尝试编号相同时归到一个组；仓库改名或多个 issuer 签发同一来源不会增加来源组数。

同组的 commit 或 conclusion 不一致会在 `conflicts` 中保留，不以新 Proof ID 消除冲突，也不自动选择某一份“正确”记录。不同尝试次数形成不同执行来源组，但仍不是独立验证。

现有数据库的提交去重键保持原格式，以免改变旧记录/API 冲突语义。新增分组用于已观测来源的展示与比较，不阻止不同主体按自己的授权关联同一个公开 CI 运行，也不去扫描或暴露他人的私有记录。

## 在线履历

Proof 读取返回额外 `provenance`；履历 `pageSummary.ciSources` 包含：

- proofRecordCount：当前页可见 Proof 记录数。
- sourceGroupCount：这些记录中的上游来源组数。
- duplicateProofRecordCount：超出每组第一条记录的重复来源记录数。
- conflictingSourceGroupCount：有 commit/conclusion 冲突的组数。
- independentlyVerifiedSourceCount：本类型恒为 0。

统计范围固定为 `provided-visible-ci-proofs-only`，并标注 `globalCountProvided: false`。先执行既有在线 Proof、Consent、绑定、来源及可见性核验，再统计；私有 Proof 不影响匿名统计，撤销后不会继续计数。最多 50 个 Case、每个 20 个可见 Proof，分组器支持对应的 1000 条记录边界。

原生履历页展示本页记录/来源组/重复数，Proof 详情显示来源键与仓库所有者观测。客户端按收到的可见记录重新计算统计，拒绝不匹配的数字。统计仍是该 endpoint 返回的有限视图；没有改成能力排行榜。

## 独立客户端和跨 Hub 比较

新增 `@galaxy/client/proofs`，复用已有 `jose` 与签名 envelope：

```js
import { verifyCiProofCollection } from '@galaxy/client/proofs';

const result = await verifyCiProofCollection([
  { endpoint: firstIssuer, signed: firstProof },
  { endpoint: secondIssuer, signed: forwardedOrReissuedProof }
], { trustedEndpoints: independentlyConfiguredIssuerPins, now });
```

`trustedEndpoints` 为 endpoint → signing pin Map 的 Map，必须由宿主通过独立渠道配置。最多 200 份明确提供的文档；该调用不访问网络、自动导入目录信任、创建身份或写入数据库。直接转发的 Proof 必须保留原 issuer；重新签发需使用相应 issuer 的独立 pin。

返回各文档的 `verified-signature` 或 rejected 状态，以及只基于通过核验文档的分组。未知/过期/被撤销 pin、过期签名、无效来源或不支持的数据不会计入有效组。多个 issuer 共同签署同一 repository/run/attempt，仍只有一个来源组，独立验证来源计数为 0。

离线签名核验始终返回 `revocationChecked: false`、`sourceFreshnessChecked: false`。它证明给定签名和内容在其时间范围内可核验，不说明签发服务当前仍公开该记录或 GitHub 当前状态未变。要判断当前状态，应使用已配置发行者的受控在线读取；不能把离线输出改写成在线有效状态。

## 验证与 AI-agent 部署

本批覆盖 API 来源字段、登记参考映射、真实队列与数据存储、Proof 发布预览、同源复制/改名/冲突/不同尝试、旧签名、撤销后在线统计、真实 HTTP 履历客户端、原生展示和独立安装消费。独立生产者使用 Node 内置 crypto 生成签名文档，避免只测试同一套生产/核验函数的循环。

无 SQL 迁移、角色或导出数据集变更；现有观测与 Proof JSON 会自然保留可选控制字段。服务升级沿用当前构建和回滚入口；分发新的本地客户端包后才使用 `/proofs` 新入口。保持当前 Schema35/42 表/31 本人导出集，客户端变为 59 个源码文件/20 个导出入口。

部署前读取已选环境与发行配置，使用独立 issuer pin，保留现有数据目录和身份。常见错误是把仓库名字或 Hub Proof ID 当作新来源，把未知所有者资料补成“已控制”，或将离线签名核验宣称为已完成在线撤销检查。回退时保留既有签名与数据，旧版本不认识的新可选观测字段应按现有发行兼容策略处理，不能为回退而重写历史 Proof。

本轮不进行真实 GitHub 用户归属认证、第三方 Bridge 生产验收或动态服务部署；真实来源/用户/宿主及原阶段验收仍单独保留。
