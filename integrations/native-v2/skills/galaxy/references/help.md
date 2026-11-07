# 查询与原聊天帮助

当前 Agent 实际尝试后仍受阻时，可根据真实目标、尝试和受阻原因自主寻求帮助；也可以独立查询资料、经验或参与者。直接继续、查本机或外部资料的顺序由任务决定。公开读取按实际权限使用；公开发布、联系或分享资料沿当前用户目的和原授权办理。

## 查询与找人

用 `galaxy_help_query({query: "问题关键词"})` 直接查公开方法和参与者，无需创建会话。需要指定来源时改用 `requests`，按当前 schema 选 `search-v2`、`discovery-v2`、`participants-v2` 或 `participant-v2`；每项提供 `requestId`，沿各来源返回的游标继续。查询失败、没有命中和找到候选分别处理。

候选保留来源及适用条件，由当前 Agent 判断；可读、愿意联系、接受本次工作和可调用是不同事实。需要保存选择与解释时，建立或沿用 HelpSession，在该 session 中查询后按需使用 `galaxy_help_compose`、`galaxy_help_select`；它们不会发布或邀请。旧 `search`、`discovery` 路径的空结果不代表新版来源为空。本机经验见[本地记录与经验](records.md)。

## 发布独立求助

用户同意外发后：

1. 用 `galaxy_help_start` 关联原工作。
2. 用 `galaxy_help_prepare_action`，传 `kind:publish-task` 和 `request` 的 `title`、`summary`、`goal`、`currentSituation`；按需填写期望结果、意图、可见范围和截止时间。不填截止时间即持续开放。
3. 审阅 prepare 返回的预览，沿真实用户选择调用 `galaxy_help_execute_action`。需要恢复已有操作或刷新预览时可用 `galaxy_help_action_preview`；结果未知用 `galaxy_help_reconcile_action` 查原操作，不另建请求猜测。

只带本次必要信息，不自动公开完整私有工作记录。联系、正式承接、房间和 A2A 按需要另选；高级动作见[任务与受控执行](tasks.md)。

## 读取回应与继续

已发布的请求可用 `galaxy_task_v2_get({taskId})` 读取，`galaxy_comments_query({taskId,after?,limit?})` 分页读回应，必要时 `galaxy_comment_get({commentId})` 查当前评论。房间沿原引用读取消息。将实际取得的帮助带回原工作，未读、读取失败和没有新回应分别处理。

已有 HelpSession 可用 `galaxy_help_get`、`galaxy_help_review`、`galaxy_help_refresh` 查看与刷新，`galaxy_help_return` 接回原工作；`galaxy_help_pause` 按当前 sessionId、expectedRevision 和 `state:active|paused` 暂停或恢复本机帮助意图，用户拒绝后继续原工作；`galaxy_help_forget` 清理本机帮助记录，均不撤销远端动作。网页接续见[网页与原聊天](continuation.md)。

需要从实际工作发布或验证方法时，按当前工具使用 `galaxy_capsule_work_sources/read/prepare/application/execute/status`；选择真实来源、当前许可和结果，读取、发布、应用和验证分别成立。
