# 社区与稍后回看

用户可以只浏览、阅读和收藏。用 `galaxy_community_query` 按关键词或主题查找；需要选择主题时可用 `galaxy_community_topics` 读取主题；已有帖子引用时可直接用 `galaxy_community_read` 阅读所选帖子或准确版本。沿服务返回的游标继续，不把首批结果当作全部；`galaxy_community_replies` 和 `galaxy_community_versions` 只在需要时深入，本人帖子使用 `galaxy_community_owned`。

向用户呈现真实标题、作者、主题、正文和当前可用动作。首次发布时间与所读版本时间分别说明，不把编辑时间说成首次发表；不展示整段工具 JSON，不猜主题或补造作者。公开读取按服务实际匿名能力执行，本人内容与收藏沿当前连接身份读取。空结果可以换主题、清除查询或结束，无需先创建任务。

用户明确要收藏或取消时，调用 `galaxy_bookmark_set` 的准确 `reference` 和 `saved`，按实际 schema 使用帖子、准确方法版本、项目或人物引用。该工具自行保留同一次操作并核对未知结果；不要另建操作来猜是否成功。使用 `galaxy_bookmarks` 读取本人收藏，可按种类筛选和分页。收藏不需要工作目的、比较理由或持续关注权限；不代用户批量收藏或同步其他私人选择。

银河 ID 的收藏与关联账户的网页收藏是不同范围。用户要读取或管理明确选定账户中的收藏时，使用 `galaxy_account_bookmarks`、`galaxy_account_bookmark_status`、`galaxy_account_bookmark_command` 和 `galaxy_account_bookmark_receipt`，传当前已关联的准确 `accountId`；列表按该账户和原筛选条件沿返回的 `nextAfter` 分页。账户写入结果未知时保留原 `operationId` 和 `payloadHash` 查原回执，当前收藏状态另查；收藏本身不授予来源正文访问。不要把银河 ID 收藏自动说成账户收藏，也不在两者间自动复制。

进入完整网页可使用 `galaxy_open` 的 `community`（可选 `topic`、`query`）、`post`（准确帖子，可选版本）或 `bookmarks` 对象，字段以当前工具 schema 为准。网页返回和来源失效的处理见[网页与聊天接续](continuation.md)。

发帖与回复需要真实内容和当前授权，沿当前提供的网页编辑入口进行。已有身份、主题、查询与草稿连续使用，不要求用户抄写对象编号。私人编辑尚未发布时，公开读者仍读取原版本；旧回复保持它所回应的版本语境，不自动解释为对新内容的评价。


## 公开账户资料

`galaxy_account_public_profile/ids/credentials/by_id/posts` 查询当前公开资料、ID 关联、外部凭据和公开帖子，不要求本机身份。沿 `nextAfter` 分页；公开范围由在线账户决定，未返回私有内容不表示它不存在。
