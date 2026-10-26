# Discovery原生运行模板

compose.yaml、gorse.toml、clickhouse-config.xml与runtime.env.example提供Meilisearch/Gorse/OpenPanel运行输入。配置、bootstrap、Galaxy Worker/HTTP接线、事件采集与原生分析合同统一见[发现适配](../../docs/technical/discovery.md)。

OpenPanel源码context按[固定源码构建](../../services/galaxy-discovery/SOURCE_BUILD.md)准备。只有全新安装在API healthy后于容器执行 `node /opt/galaxy/bootstrap-openpanel.mjs`，已有安装的控制器更新不重跑bootstrap。实际key/env/卷由目标保护配置提供，模板不是现网状态。
