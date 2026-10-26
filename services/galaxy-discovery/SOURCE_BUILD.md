# Discovery 源码与局部构建

本组件包含 Gorse 保护网关，以及 OpenPanel 固定版本的两组窄补丁。`upstream-reference` 和 `current-reference` 是补丁生成与审阅输入；它们没有完整依赖和工作区，不能直接当作 OpenPanel 服务启动。

OpenPanel 基线为 `Openpanel-dev/openpanel` 的 `cd24bb838301df1a9087e2e132b344e5b8a99963`。保留其 GNU AGPLv3 许可、原始声明和依赖锁。`openpanel-account-scope` 增加显式账户范围，`p18-search-native` 在其上保留 chart series ID；默认分析口径、数据库和原生身份体系分别保持。账户留存是固定近12周的首次合格活动 cohort，不称为注册留存。

完整对应源码是单独的第三方来源制品，原始账户范围 tar.gz 为 78,480,894 字节、2418 条目。代码仓库保留修改源码、生成器、补丁、原文参考、Dockerfile 和定向检查，避免把大型来源制品和编译日志当日常 Git 变更。发行方记录的对应源码入口分别在两组 `MODIFICATIONS.md`；这些 URL 是原发行合同，使用时仍须实际取得完整制品，不能仅凭 URL 存在声称来源可用。

从明确取得的账户范围完整制品建立新的 P18 构建上下文：

```sh
python services/galaxy-discovery/prepare-openpanel-source.py \
  --archive /path/to/account-scope/source.tar.gz \
  --output /path/to/new-openpanel-context --variant p18
cd /path/to/new-openpanel-context
docker build -f Dockerfile.p18-search-native -t galaxy-openpanel-api:local-review .
```

只需要账户范围时使用 `--variant accounts` 和 `Dockerfile.account-scope`。准备程序在创建输出前拒绝越界、链接、重复条目、运行材料与不匹配的固定源码；已有输出绝不复用。它逐项核对完整来源中的账户补丁及 package 输入，再使用仓库内 P18 前像和终稿组成上下文，所有测试支持来自本仓库。它不安装依赖、启动容器、执行迁移或加载配置。镜像构建另行使用保留的 pnpm lock，当前目录的准备成功不等于镜像构建或实际分析验收。

```sh
python -m unittest discover -s services/galaxy-discovery -p test_prepare_openpanel_source.py
node --test services/galaxy-discovery/test/gorse-gateway-pagination.test.mjs
```

`native-probe.mjs` 是显式运维程序，会向指定的 Meilisearch/Gorse 写入并清理临时探针对象；它不是测试夹具、应用启动入口或默认组件检查，不应在正常构建中运行。真实源数据库、OpenPanel 事件、用户资料和运行凭据不进入上述准备流程。部署由操作者沿保护配置、当前镜像/挂载及实际服务合同单独执行，保留完整对应源码的提供责任和原许可，不从构建通过推导生产启用。
