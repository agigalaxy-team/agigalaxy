# 独立运行环境

[部署指南](deployment.md) · [Linux 准备](linux-deployment-v1.md)

当前准确约束在 [runtime-environment.mjs](../packages/galaxy-official/src/runtime-environment.mjs)。

| 约束 | 当前源码要求 |
|---|---|
| 环境 | local、integration、pilot |
| 角色 | api、worker、migration |
| 数据库 | postgres / postgresql URL，名称为 galaxy_对应环境；要求用户名，不接受 URL query 或 fragment |
| API 环境目录 | GALAXY_ENVIRONMENT_DIRECTORY 是以环境名结尾的绝对目录 |
| API 签名与信任路径 | 必须位于准确环境目录内，运行前核对 realpath |
| Worker / migration | 不携带 API 的签名字段 |
| API 公开地址 | 精确 HTTPS origin，无 URL 凭据 |
| 运行用户 | Unix API 拒绝 root；数据库运行角色与迁移、所有权分别配置 |

API 需要的签名字段包括 GALAXY_SIGNING_KEY_FILE、GALAXY_SIGNING_KEY_ID、GALAXY_ROOT_PINS_FILE、GALAXY_KEYRING_FILE 和 GALAXY_TRUST_DIRECTORY。材料的存在、当前公钥授权、撤销状态和有效期仍由启动检查核对。

[运行设置示例](../packages/galaxy-official/deploy/runtime-settings.example.json)只提供部分模板，不能直接当作可启动环境。目标目录、凭据引用、数据库、域名和外部依赖需要按实际环境配置，不复制旧服务器的原始秘密。

前端公开配置、身份服务配置、管理应用的 CMS 配置与本机客户端资料目录分别使用。完整变量发现、部署顺序及验证见[部署指南](deployment.md)，不是给任意进程统一导入全部环境变量。
