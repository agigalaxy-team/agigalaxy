# 注册资料配置

注册只收集所需邮箱及当前流程需要的密码，不收集姓名。姓名仍为可选账户资料；保留已有值、校验规则及本人和管理员的资料权限。

`realm-profile.mjs` 是本地规划器，不连接 Keycloak。传入 `GET /admin/realms/galaxy/users/profile` 返回的完整 UPConfig，只移除 `firstName`、`lastName` 的 `required`，其余配置原样保留；也接受本任务安全检查文件中的 `userProfile` 对象。它不读取或写入任何用户记录。

```powershell
node apps/galaxy-auth/realm-profile.mjs --input <原配置.json> --output <新的profile.json>
```

主会话在完整注册流程集成时，先保存原配置，再将输出的完整 JSON 作为 `PUT /admin/realms/galaxy/users/profile` 请求体；这不是 JSON Merge Patch。更新前沿用当前配置，避免覆盖其他修改。需要回退时恢复原配置，不能用空对象或删用户代替。

注册表单由 `theme/galaxy/login/register.ftl` 与 `registration-profile-fields.ftl` 处理，继承现用共享外壳及 Keycloak 字段控件，只在注册渲染时略过姓名。不修改原生 `user-profile-commons.ftl`、更新资料页面、正常密码登录、验证邮件动作或其他表单。现有构建会直接复制新增模板。

Keycloak 26.7.3 的 `permissions.user` 同时适用于注册和本人资料管理，不是注册专用权限。`required: {}` 会始终必填；`required.scopes` 和 `selector.scopes` 指 OIDC client scopes，不是页面名。不能以管理员专用权限、虚构注册 scope 或只用 CSS 隐藏来替代后台取消必填。

此处为源码与配置规划，不代表线上已应用；集中核对须覆盖无姓名注册及后台接受、错误后保留邮箱、未完成注册安全接续、姓名已有值及资料权限保持。

源码依据：Keycloak 26.7.3 [注册模板](https://github.com/keycloak/keycloak/blob/26.7.3/themes/src/main/resources/theme/base/login/register.ftl)、[动态字段](https://github.com/keycloak/keycloak/blob/26.7.3/themes/src/main/resources/theme/base/login/user-profile-commons.ftl)、[上下文](https://github.com/keycloak/keycloak/blob/26.7.3/server-spi/src/main/java/org/keycloak/userprofile/UserProfileContext.java)、[声明式配置](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/userprofile/DeclarativeUserProfileProvider.java)、[配置 GET/PUT](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/services/resources/admin/UserProfileResource.java)。
