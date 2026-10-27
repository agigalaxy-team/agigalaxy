# 独立管理realm规划

realm-plan.mjs导出createOperationsRealmPlan、createBusinessDirectoryPlan与planOperationsUserProfile，生成非秘密管理realm/客户端/角色规划，不创建用户或凭据。精确client scope、最小目录角色与Admin API顺序见[认证工程](../../../docs/technical/authentication.md#管理realm与资料规划器)。

先构建父认证主题，再从仓库根添加管理子主题：

```sh
node apps/galaxy-auth/operations/build-theme.mjs --auth-root <auth候选>
```

可用--out-root/--admin-origin选新候选及实际HTTPS管理地址，只新建themes/galaxy-operations/login。父galaxy主题需一同提供。

管理登录独立于官网外壳，直接显示原生账号密码表单。布局和资源位于 src/ 与 theme/；保留Keycloak原生表单及父主题的提交状态增强，不在浏览器另建认证逻辑。显式管理登录要求重新输入凭据，门户会话续期不受影响。
