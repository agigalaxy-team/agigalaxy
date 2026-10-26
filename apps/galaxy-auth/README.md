# 银河Keycloak认证主题

本应用生成Keycloak26.7.3登录/邮件主题及静态认证入口；共享Web外壳与galaxy-mail布局，源码为src、shared、theme和client-contract.json。认证接续、邮件Provider及安装回退的主要正文见[认证工程](../../docs/technical/authentication.md)。

从仓库根构建：

```sh
node apps/galaxy-auth/build.mjs --out <全新或空的绝对目录>
```

完整邮件码候选加 `--provider-jar <准确JAR绝对路径>`。Java扩展须先独立构建；主题构建不修改realm。原许可和改动范围保留在NOTICE与licenses/。
