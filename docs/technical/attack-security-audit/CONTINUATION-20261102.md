undefined

## 七、19:41 UTC 新提交适用性补充

观察到主分支新提交 `95dec4ae808f8af2f4e3116a5b1179e16e228164`，相对 9ad760b 的全部路径仅作版本登记。以下是普通读取及前端的局部变更审阅，其他执行服务和运行相关变更未计入覆盖：

- 卡片分组由固定三个选项改为正安全整数数量，按相同组、数量、排他属性及不同位置组合，支持不完整历史组。没有改变此前所读的本地链接过滤、文本渲染和原操作回执匹配边界。
- `go/internal/agentos/conversation-read.go`、`conversation-history-page.go` 与 `conversation-card-read.go` 的新增返回前检查调用 CurrentRead，再清除来源受限回合的正文、事件或卡片展示。**旧版本“历史读取缺少返回前当前检查”的观察不能原样沿用到本版本。**
- `conversations.go:146–238` 的普通读取路径核对 endpoint、所有者、未退役状态、当前人类与固定 AI 权限及权限键；来源验证与有效期之后再次读取当前权限。未审阅其后 Native 分支。
- `conversation-sources.go:1–113` 的 SourceValidator 每批处理最多 300 个引用，校验无效索引的类型、范围、重复及返回数量一致性；按原始引用标识受影响回合。旧引用缺少明确回合时只保留服务端记录的安全回合坐标。每批上限不是全会话引用量或工作总量上限。
- `operationsqueries/revalidate.go` 新增无效索引，并将公开正文引用纳入版本比对；`conversation-summary.go` 的变更是增加 sectionAvailability 投影。
- 来源写入者完整性、所有衍生正文传播、在途撤销与真实运行效果仍未验证。仅阅读新增前端测试断言，没有执行测试。

本补充没有新增确认漏洞，不把静态复查改进写成已验证修复。95dec4a 并非此审计分支的业务源码更新，本 PR 仍仅修改报告文档。
