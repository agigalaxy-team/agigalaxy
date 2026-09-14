<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/64/641da0e307927df2c0c9a5cd6c86e8986fbcb28faa8f42254b844186818a2d48.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# History / Profile 查询 v1

本地实现，尚未部署动态服务。数据来自 Case 事件，投影版本为 1；该历史查询初版未新增数据库迁移或独立搜索索引；当前自述扩展使用Schema30。

- `POST /v1/history/query`：JSON 支持 `subjectId`、`query`、`outcome`、`after`、`limit`。
- `GET /v1/profiles/{GUID}`：读取该主体的第一页履历。
- 匿名读取公开视图；认证读取要求 `history` scope，原凭据不会自动扩权。
- 关键词对标题和摘要作全部词匹配，最多 8 词、200 字符。结果筛选支持 `succeeded`、`partial`、`failed`、`inconclusive`、`conflicting`，表示曾报告该结果，不代表纠正后的最终裁定。
- 本人查询可增加 `sourceKind`（local/bridge/hub）、`environment`（大小写不敏感的完整环境名称）、`createdFrom` / `createdBefore`（UTC ISO 时间，前者包含、后者不包含）。必须显式指定本人的 `subjectId`；他人或匿名请求这些字段返回 403，避免利用隐藏配置推断事实。时间按服务登记时间筛选，本人结果返回 `registeredAt`；不代表实际任务发生时间。所有筛选先于分页执行，返回对应匹配原因。
- UUID 升序分页，默认 20、最多 50 条；不是时间排序或推荐排名。返回逐项匹配原因及本页统计，不返回全局私有计数。

投影保留尝试、成功/失败结果、限制和纠正原文；原结果不被纠正覆盖。本人额外看到参与者、来源及配置；授权查看者及公开视图使用精简字段。`selfDeclared` 可通过独立签名自述记录填写（见 [Profile自述](profile-statements-v1.md)），履历为空时不生成默认能力。`projectionHash` 对相同可见来源和 Proof 内容确定性生成。

每次读取重新检查事件授权、绑定和 Proof 来源。事件授权撤销后，该 Case 从后续查询隐藏；Evidence 来源撤销后，关联 Proof 不再返回。每个 Case 最多检查 20 个未撤销 Proof 候选，其自身可见性检查后返回；因此这不是完整 Proof 清单。Proof 保留原有验证范围，`capabilityVerified` 始终为 false。

客户端包提供 `@galaxy/client/history`，复用已确认连接的 session memory：

```js
import { createHistoryClient } from '@galaxy/client/history';
const history = createHistoryClient({ endpoint, sessions });
const page = await history.query({ query: 'compiler', outcome: 'failed', limit: 20 });
if (page.nextCursor) {
  const next = await history.query({ query: 'compiler', outcome: 'failed', limit: 20, after: page.nextCursor });
}
const profile = await history.profile(subjectId);
const ownNodeHistory = await history.query({ subjectId, environment: 'Node', sourceKind: 'local',
  createdFrom: '2026-01-01T00:00:00Z', createdBefore: '2027-01-01T00:00:00Z' });
```

客户端只在显式调用时发送请求；要求已有 `history` scope，不自动匿名降级或扩权。请求前后检查同一会话是否仍有效，丢弃本地退出后的迟到响应。401/403 清除对应会话凭据。返回 `source: endpoint-reported`，不把服务器 JSON 当作独立能力证明。集成方用普通文本呈现远端字段，并自行提供用户分页操作。会话容器支持全部六项现有 scope。

宿主接线：`createLocalHostRuntime` 现在组合 HistoryClient，controller 暴露 `queryHistory`。开发版 Adapter 在已有 `session-local` 会话且含 `history` scope 时，于“接入银河”显示“查询履历”。输入关键词后每页显示 8 条，第 9 个数字位置留给下一页；详情显示结果、纠正和匹配原因。远端文本去除控制字符并限制显示长度。退出取消进行中的查询，迟到结果不重开页面。无 controller 的默认本地入口不出现远程查询。仓库代码已接线；未安装到用户全局 OpenCode，真实宿主交互待人工验收。

宿主筛选表单提供九个数字入口：范围、关键词、报告结果、来源、环境、起始日期、结束日期、开始查询、清空。日期输入为 YYYY-MM-DD，以 UTC 零点转换；结束日期不包含在区间内。选择来源、环境或日期自动切换本人范围，切回全部可见时清除本人专用条件。编辑阶段无网络请求，点击查询才提交。非法日期和倒置区间本地提示。自动宿主 API 替身测试覆盖菜单到请求的实际链路；不能替代真实 OpenCode 的视觉与键盘验收。

相关性反馈首版：宿主详情后提供可跳过的反馈菜单，用户主动选择相关性和“是否帮助选择”。反馈只写入本地状态的 searchFeedback，保存查询条件、Case ID、投影哈希/版本和选择；不保存整个远端结果或Proof。相同身份/端点/查询/Case更新同一记录，分页参数不造成重复；可以移除反馈。最多10000条，达到上限拒绝新增而非静默删除。

反馈只针对当前成功查询页的结果；取消或重新查询后旧页面不再可提交。无自动点击采集、无上传、无排名变更、无Verification/Proof/Honor影响。它随本地数据导出保留；云端反馈汇总与真实用户相关性评价仍待完成。7项受影响测试、lint和Adapter类型检查通过。

尚待实现：跨参与者纠纷流程、公开配置披露规则、Capability/验证强度筛选、反馈汇总评估及真实宿主验证。按需投影避免缓存失效延迟；不宣称已完成物化索引或大型数据集性能验收。

2026-09-10Profile自述：API/便携客户端及导出/删除已接通；Schema30/39表/30本人导出集/19客户端入口。原生编辑签名与分区展示已接通；真实宿主人工验收保留。见 `docs/profile-statements-v1.md`；动态服务未部署。

2026-09-10Profile宿主：Profile原生编辑、准确预览、本机签名及自述/事实分区展示已接通；默认私有，版本冲突不覆盖，取消与旧页面回调不继续发布。11项相关用例、严格tsc、lint及客户端离线安装通过。C10-03待复核；未全局安装或外部部署。见 `docs/profile-statements-v1.md`。

2026-09-10履历视图与结果：履历新增三类独立字段规则、五类结果时间线及成功报告后的后续结果；读取重算状态/时间与空资料展示接通，Evidence源/Proof/授权/绑定撤销联动已验证，重建规则升级v3。13项不同相关用例、真实PG1项、严格tsc、lint及客户端离线安装通过。见 `docs/history-views-and-outcomes-v1.md`；C10-06直接操作入口仍待补齐，动态服务未部署。
