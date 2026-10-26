# 注册资料配置规划器

realm-profile.mjs在完整Keycloak UPConfig上移除firstName/lastName的required，保其余校验、权限和已有属性，不读取用户资料、不连接服务器。

```sh
node apps/galaxy-auth/realm-profile.mjs --input <原完整配置.json> --output <新profile.json>
```

实际GET/完整PUT、scope陷阱及注册模板边界见[认证资料规划](../../docs/technical/authentication.md#管理realm与资料规划器)。输出是规划材料，不是Merge Patch。
