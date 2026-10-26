# Galaxy model gateway

本服务以私有ASGI准入包装固定LiteLLM Proxy；准确提交、锁和来源见SOURCE.json、SOURCE_PROVENANCE.json及Dockerfile。协议/人工模型配置/usage与检查合同见[原生运行](../../docs/technical/agent-runtime.md)，许可见[源码与许可](../../docs/technical/source-and-licensing.md)。

从仓库根准备新构建context：

```sh
python services/galaxy-model-gateway/prepare-source-context.py --output <新context> --archive <固定提交.tar.gz>
docker build -f <新context>/services/galaxy-model-gateway/Dockerfile <新context>
```

也可用--download获取SOURCE.json的准确公开提交。配置加载以src/galaxy_model_gateway/policy.py为准；config/models.empty.yaml只是初装空模板。
