# M09 选择快照：本机默认、单独私有云同步与版本冲突

2026-09-13。本说明对应新增 migration62，不等于该版本已在远端运行。部署由发行记录另证。

## 依据和职责

沿用完整 M09 阅读包、工作包 PREP-API-M09-SNAPSHOT、NEW-M09-FLOW/S3、CUR-26，以及授权代选 ROOT-Q-CHOICE-SNAPSHOT、ROOT-Q-NEW-DATA-TTL。卷12 §12.10要求当前源重查。用户原话、授权代选和实施细化并非同一证据类型。

Choice 默认用户端保存。跨端需另选私有云类别，最后有效更新30天清理；不继承个人房间摘要开关。默认请求发布不会公开推荐名单或模型聊天。记录只有用户可见理由及其作者、候选/选择的精确引用、原工作引用和实际Result版本关联；不是联系、申请、交付、验证或成功复用。用户及用户端模型解释和比较，云不运行模型或存私有思维链。自由文本仍须按字段含义填写，工具不能自动证明所有文本都没有私有推理。

准备示例的版本数字在本轮细化为Search可见投影摘要；真实事件ID及对象版本仍在实际源中，不混为数据库总序号。

## 接口和精确数据

以下均为POST，要求当前绑定binding scope。所有者来自认证主体，不接受指定他人。来源另按原scope核对，不因保存私有选择而扩大读取权限。

| 路径 `/v2/choice-snapshots/` | 输入/行为 |
|---|---|
| preferences/read | `{}`；默认关闭，准确endpoint、revision、snapshotIds |
| preferences/save | `{endpoint,expectedRevision,enabled,snapshotIds}`；明确列出允许同步的UUID，保存偏好不上传或删除内容 |
| put | `{snapshotId,versionId,baseRevision,preferenceRevision,content,witnesses,resolveVersionIds}` |
| get | `{snapshotId}`；本人当前和冲突版本及当前源状态；他人相同ID没有本人对象 |
| list | `{after?,limit?}`；本人分页，默认8、最多20 |
| delete | `{snapshotId,expectedRevision}`；只清这份云副本正文，不声称删除本机或原工作 |

content为严格对象：localVersion、localTaskRef、visibleRationale、rationaleAuthor（user/user-agent）、candidateRefs、selectedRefs、resultRefs。候选最多64，每项`{type,id,version}`的version为64位十六进制投影摘要；选择是候选子集。Result最多16个真实`{caseId,id,version}`，在同一事务经实际事实读取，任意UUID不能冒充结果。

witnesses携带原Search查询和精确ref，服务同事务读取实际当前源、核对投影并生成最小依赖定位/摘要。查询词、临时标题、环境及项目上下文仅在本次核对使用，不进入云表。History/Case、Task、Capsule、native CI Proof、功能机会、Worker/Hub使用各自真实服务；Builder原搜索只采用公开声明，仍守此范围。不能用旧缓存、源作者身份或成功示例替代当前源。

另一端下载Choice没有原查询条件；不得伪造，应重新查询当前候选后形成新版本。源依赖核对只说明原候选当前可读状态，不宣称原查询语义或用户理由仍正确。

## 冲突、回执、生命周期

versionId为稳定操作ID；snapshotId为记录ID；baseRevision为这个草稿真正基于的云修订。相同操作/载荷重试返回原回执，不新建或续期；相同操作不同内容拒绝。基线落后则独立保存conflict，当前版本和冲突双方均保留。用户/模型比较后显式基于当前修订提交，并列出resolveVersionIds，才解决指定冲突；其他冲突保持独立。

本机创建版本时固定当时所见云基线。之后刷新云列表不会抬高旧草稿基线，防止旧草稿覆盖刚读到的另一端修改。网络结果未知时保留待重试请求和原操作ID；也可先核对云端，再明确放弃待重试请求，不能凭异常认定未上传。

有效内容更新设置30天到期。读取、原操作重试、偏好更改、仅版本号变化的相同有效内容均不续期。到期先停读，再清正文和依赖。新提交仍需当前授权、当前精确源和实际Result，不能用新versionId让过期原材料重新获准。

来源变化/不可读时停止返回依赖它的旧理由，引用、选择和应用含义仍分开。后台每批最多20个版本，仅代表副本实际所有者执行内部清理，无源正文输出或新授权。已登记源作者正在办理而尚可取消的删除先停读，不自动当成已物理删除；取消后原许可仍在才恢复。真正失效的受控理由清理后不从旧副本重建。用户已明确下载的本机历史版本另行控制，不能承诺服务端追回。

三表choice_snapshot_preferences/heads/versions均归subject_id；版本只通过(subject_id,snapshot_id)引用头部，没有跨用户源FK强留别人资料。旧迁移不改写，预算纳入正文/依赖字节。

M19原始导出只含本人偏好、头部、版本回执；正文须走choice-snapshot当前授权视图或exportOwnedWithin，不能直接导出原content。执行删除先关闭范围并清content/dependencies，再按所有权叶表顺序删除。维护复用API旁已有数据清理循环，调用purgeExpired/purgeInvalidSources，不创建备份、模型或用户Agent心跳。

MCP六工具galaxy_choice_preferences、galaxy_choice_preferences_save、galaxy_choice_put、galaxy_choice_get、galaxy_choice_list、galaxy_choice_delete直接调用同一服务。模型不能因刚生成建议或房间摘要而自行开启此类别。

## 页面及验证范围

Search页内ChoiceSyncWorkspace提供独立范围选择、最小记录预览、手动同步、云记录读取/删除、冲突比较和指定冲突解决。先从实际搜索结果更新本机版本，再显式解决已比较冲突。下载版本另存在本机历史版本区，不覆盖原草稿；离线可查看/删除，并注明不代表当前源有效。

真实WebRuntime使用当前身份/API和本地存储。云待重试数据、云头部、明确下载版本和原本机Choice分别保存。停用云同步不删除本机；删除云副本不改Case、Result、任务或聊天。

验证：真实PostgreSQL schema62、受限galaxy_api、实际HTTP、精确来源、版本冲突、相同载荷不续期、当前授权导出及实际执行删除1/1通过，临时cluster已清理。两个真实WebRuntime独立缓存验证丢回执幂等、旧草稿基线、冲突双方、另存分支及删除取消恢复；使用合成授权身份，不冒充两台实体设备或用户验收。实际Task/机会、Capsule、CI Proof、Worker/Hub依赖分别通过针对性场景。

大规模候选扫描和一次多来源核对没有生产容量证据；源码可用、自动验证、具体部署与用户验收分别报告。
