# @galaxy/mail

src/layout.mjs是共享邮件展示API，src/identities.mjs给公开发件身份；模块不发送或存储邮件。HTML/text、Keycloak FTL、预览均用同一rendering/frame实现，正文rendering/messages及keycloak/templates随公共入口一起封包。

调用签名、可信HTML边界、语言/身份、FTL宏和品牌布局的主要说明见[共享邮件渲染](../../docs/technical/authentication.md#共享邮件渲染与模板生成)。仓库源码可直接import src/layout.mjs，包依赖使用@galaxy/mail；旧email-designs/common仅re-export。代码许可/第三方范围仍按各自原文。
