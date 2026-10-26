# Keycloak管理邮箱验证Provider

固定galaxy-operations服务身份调用的RealmResourceProvider，复用Keycloak26.7.3原生UpdateEmailActionToken；源码不替换上游handler。服务路由、receipt marker、build-time feature及Node适配合同见[认证工程](../../../../docs/technical/authentication.md#管理邮箱原生验证)。

在本目录以Java21离线构建：

```sh
node build.mjs --keycloak-dir <固定26.7.3目录> --jdk-dir <JDK21> --out <新候选目录> --with-tests true --run-tests true
```

原生Keycloak许可位于src/main/resources/META-INF/LICENSE-KEYCLOAK.txt。构建不安装JAR或修改realm。
