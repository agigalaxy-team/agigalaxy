# 私有模型运行模板

compose.yaml提供Gateway/AgentOS运行输入，GALAXY_MODEL_GATEWAY_IMAGE与GALAXY_AGENTOS_IMAGE显式选择本次构建镜像。runtime.env.example/agentos.env.example只给变量名，真实配置放保护目录，通过只读mount或进程引用加载。

全新未配置安装可用models.empty.yaml与五项null bindings；现有部署沿当前人工设置，不能将空例子覆盖已采用配置。模型路由、认证、双方版本回读和检查的主要合同见[原生运行](../../docs/technical/agent-runtime.md#gateway原生准入与模型配置)。此目录不含激活状态或可直接使用的凭据。
