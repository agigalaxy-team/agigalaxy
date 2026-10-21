# 独立运营身份域

本目录只提供无秘密的配置规划和管理子主题。`createOperationsRealmPlan()` 的目标固定为 `galaxy-operations`，不克隆普通 `galaxy` realm，不查找或关联同邮箱普通账户，也不生成管理用户、密码、客户端 secret 或实际令牌。

```js
import {createOperationsRealmPlan, createBusinessDirectoryPlan,
  planOperationsUserProfile} from './realm-plan.mjs';
const plan = createOperationsRealmPlan();
```

`plan.realm` 是供 Keycloak Admin API 创建新 realm 的精简 representation。先创建该 realm，让 Keycloak 保留原生密码登录、重置流程与内置 `profile / email / roles` scopes，再依次应用 `roles`、`clientScope`、`clients` 及明确的 scope/服务账户角色映射。不要将这些字段拼成覆盖普通 realm 的整份导入。

- 管理注册关闭，无普通账户身份提供方、跨域用户同步或同邮箱自动关联。管理用户名、邮箱和密码由已授权的运维操作在内存中提供。
- `galaxy-operations-web` 是 public code 客户端，必须 PKCE S256；回调仅 `https://admin.agigalaxy.org/v1/operations/callback`，不开放 implicit、direct grant 或 service account。
- 两个管理角色均为非 composite，不能作为 realm 默认角色授予。`galaxy-operations-roles` 使用原生 User Realm Role mapper，将用户实际获准角色写入签名 ID token 的 `realm_access.roles`。`fullScopeAllowed=false`，给 web 和 Grafana 的 realm scope mapping 仅包含这两个角色。
- 独立目录客户端仅 service account；给该 service account 和客户端 role scope 都只映射本 realm 的 `realm-management` 中 `view-users / query-users`。不授 `manage-users`、`realm-admin`、impersonation 或跨 realm 权限。
- `galaxy-operations-grafana` 是独立 confidential code 客户端，secret 由 Keycloak 生成并由运维注入进程。回调只为 `/monitoring/login/generic_oauth`，无普通账户登录提供方；角色缺失时严格拒绝，不因邮箱相同合并身份。`plan.grafana.environment` 可供专业工具配置，secret 仅通过所列环境变量另外注入。

最小 Admin API 接续顺序（UUID 均从当前服务返回取得）：

1. `POST /admin/realms` 提交 `plan.realm`。已有同名 realm 时只对这个明确管理域应用本计划的设置，不替换现存用户和凭据。
2. 在 `/admin/realms/galaxy-operations/roles` 创建计划角色，在 `/client-scopes` 创建 `plan.clientScope`，再在 `/clients` 创建计划客户端。默认关联 `profile / email / galaxy-operations-roles`；目录客户端仅使用 `roles`。
3. 为 web 和 Grafana 在 `/clients/{clientUUID}/scope-mappings/realm` 映射两个计划角色的实际 role representations。
4. 对目录客户端读取 `/clients/{clientUUID}/service-account-user`，解析本 realm 的 `realm-management` client UUID 和两个真实 role representations；在 `/users/{serviceUserUUID}/role-mappings/clients/{realmManagementUUID}` 与 `/clients/{directoryUUID}/scope-mappings/clients/{realmManagementUUID}` 设置这两个最小读取角色。若专用客户端已经存在，不沿用意外的高权限角色。
5. 只在管理 realm 创建用户，并向 `/users/{userUUID}/role-mappings/realm` 分配用户实际获准的一个管理角色。密码通过 `/users/{userUUID}/reset-password` 的原生 API 在进程内设置或重置，不进入源码、快照和日志。规划器关闭自助密码找回；后台管理员重置不受此设置影响，也不依赖普通账户邮件码流程。
6. 如原生 profile 要求补姓名，可将本管理域 `/users/profile` 的完整配置交 `planOperationsUserProfile`，再回写同一地址；它只去掉 firstName/lastName 的必填条件，其余配置保留。

业务用户邮箱目录与管理身份目录是不同客户端。`createBusinessDirectoryPlan()` 单独返回普通 `galaxy` realm 的专用只读目录计划，不包含在上述管理域 plan 中；已有合适的专用目录客户端可显式传其 clientId。根会话按现有配置决定最小接线，不能因此改普通 realm 的登录、注册、用户凭据或赋予管理身份。

## 共用主题

子主题继承 `galaxy` 的真实样式、资源和原生表单；专属消息只改变管理身份文案。生成器直接调用同一 `SiteHeader / GlobalRail`，复用已构建父主题的 FreeMarker head 与共用表单；管理返回指向运营后台，去掉普通账户注册引导，不另画品牌或仿写一套外壳。

在根会话集中构建普通 auth 候选之后，添加管理子主题：

```sh
node apps/galaxy-auth/operations/build-theme.mjs --auth-root <auth-candidate>
```

可用 `--out-root` 写入另一候选根，`--admin-origin` 指定实际 HTTPS 后台 origin。只写 `themes/galaxy-operations/login`；该目标需尚未生成，父 `themes/galaxy` 必须随候选一起提供。普通 `galaxy` 主题、登录实现及 realm 均不被本生成器修改。

规划与字段依据：[Keycloak 26.7 管理文档](https://www.keycloak.org/docs/26.7.0/server_admin/index.html)、[26.7.3 原生 realm role mapper](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/protocol/oidc/mappers/UserRealmRoleMappingMapper.java)、[Grafana Keycloak OAuth 文档](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/keycloak/)。实际 apply、凭据注入与集中运行由根会话执行。
