# 本地工作、原会话与隐私

`galaxy_local_work_list/get` 读取事实、来源与环境；`galaxy_command` 的 `history`（或 `work`）提供同义可选界面。宿主只记录实际提供的事实，未采到的资料不补造。

在自然阶段或接续需要时，用 `galaxy_local_work_pending` 取得未整理增量，由当前 Agent 整理并用 `galaxy_local_work_summary` 保存。待整理页或连续覆盖下一段的工作详情页提供 `summaryInput`，含工作、修订和覆盖位置；服务自动关联该范围内实际观察，可用 `sourceObservationIds` 补充同一工作更早的真实来源。修订冲突后重读当前状态。分批与时机由 Agent 决定，不在每回合另启动摘要模型。`galaxy_local_work_note` 可补充明确标为 user-statement 或 model-report 的陈述。

`galaxy_local_upload_privacy_get/set` 管理四档允许上传类型，默认第 2 档只含结构化履历概况；第 3 档才包含所选具体说明与过程摘要。完整会话另行选择，凭据始终排除。本地读取、宿主模型调用和向银河上传分别处理。

`galaxy_local_archive_settings` 查看选择，`galaxy_local_archive_configure` 按实际 schema 选择准确宿主和会话；`galaxy_local_archive_list/export/delete/cleanup` 管理实际采集的原会话，默认不保存完整会话，已选原件也可能只有部分记录。`galaxy_local_work_export/delete` 管理履历。原会话与房间摘要是不同范围；分享另读[房间与关注](rooms.md)。

私有云同步分别使用 `galaxy_work_sync_*`、`galaxy_archive_sync_*`，沿已选账户、目标与资料范围接续；新增范围按实际选择办理。本机、原件与云副本分别保存和删除，重置身份不清空它们。以可读名称和影响呈现上传档位、资料范围、目标账户及云副本删除；无法取得名称时用准确标识区分。按当前选择核对实际范围，不要求用户阅读工具参数 JSON。
