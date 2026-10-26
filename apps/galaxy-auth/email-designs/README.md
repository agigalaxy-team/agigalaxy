# 邮件设计预览工具

render-email.mjs的renderEmailPreview生成固定示例，无真实验证码输入或发信副作用。源码保留8份已选B的注册、找回、system/service HTML/TXT；落选A/C及旧change-email产物已外置，渲染分支仍可生成回看。

在本目录更新已选示例：

```sh
node write-previews.mjs --selected-only
```

默认写仓库已忽略的outputs/email-previews，可用--output <目录>显式选输出；可加--text-only，省selected-only生成所有设计。write-shared-templates.mjs刷新同源FTL副本，正式auth build直接消费galaxy-mail导出。完整共享API、身份、宏和生成合同见[共享邮件渲染](../../../docs/technical/authentication.md#共享邮件渲染与模板生成)。
