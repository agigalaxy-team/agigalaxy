# Keycloak邮件验证码Provider

面向Keycloak26.7.3/Java21的VERIFY_EMAIL、reset与未完成注册接续扩展。源码Provider和realm-plan.mjs是实现入口，启用开关、原子状态、模板/流程及回退合同统一见[认证工程](../../../../docs/technical/authentication.md#邮件码provider与构建)。

从仓库根离线构建：

```sh
node apps/galaxy-auth/providers/email-code/build.mjs --keycloak-dir <固定26.7.3目录> --jdk-dir <JDK21> --out <新候选目录> --with-tests true
```

with-tests只编译测试。Java行为入口/classpath与realm planner测试见正文，不能用构建代替安装流程。JAR默认不启用验证码。
