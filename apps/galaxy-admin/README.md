# 银河运营后台

Next/Payload应用；CMS数据库和媒体独立，业务事实经管理BFF调用银河API。源码入口为src/app、src/payload.config.ts与src/components，环境字段以.env.example为准；部署/迁移/standalone说明见[管理应用与CMS](../../docs/operations/deployment.md#管理应用与cms)，快照合同见[接口](../../docs/technical/interfaces.md#cms快照与发布)。

在本目录使用Node24.13+：

```sh
npm ci
npm run build
npm run start
```

局部选择npm run types、相关测试或构建；首次CMS部署须先按正文生成/审阅/应用独立迁移。新自定义组件用npm run generate:importmap，Payload类型用npm run generate:types。用户规则与页面范围见[管理产品说明](../../docs/product/admin.md)。
