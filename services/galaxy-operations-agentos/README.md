# Galaxy operations AgentOS

Python/Agno运行入口是 `src/galaxy_agentos/app.py`，依赖见requirements.lock/pyproject.toml，镜像入口 `python -m galaxy_agentos.app`。Node业务权威与原生会话、模型配置、持久队列、P13及测试环境的唯一工程正文见[原生运行](../../docs/technical/agent-runtime.md)。

从仓库根构建：

```sh
docker build -f services/galaxy-operations-agentos/Dockerfile .
```

局部纯数据库拒绝合同：`python -m unittest discover -s services/galaxy-operations-agentos/tests -p test_database_contract.py -v`。持久化测试必须先配置专用PG四项测试变量，具体条件见上述正文。运行变量以src/galaxy_agentos/config.py、runtime.env.example为准。
