# 银河项目未完成审阅路径交接清单

本清单用于后续安全审阅交接，逐项说明已固定版本中的未完成范围和缺少的证据。它不是漏洞清单，也不证明对应文件不安全。整理时间为2026年10月30日00:31 UTC。

共710条“版本区间＋路径＋覆盖类型”记录，**未按文件路径去重**。同一文件在不同提交或不同证据索引下可重复出现，不能将710解释为未审文件总数或完成率。基线与各后续提交分开保存，不用后续局部阅读自动关闭先前记录。

每节固定提交适用于该节所有行；路径与blob（文件内容标识）逐行保留。表内状态以中文对应已保存记录的精确覆盖分类和限定条件，保留partial、pending、excluded等状态代码；英文状态对照：partial为部分阅读，pending为待审，excluded为该范围未纳入，complete comparison为完整差量比较而非全文重读。HEAD表示该节固定终点版本。

未进行运行验证。全文静态阅读、完整变更片段阅读、仅结构检查及仅清单登记是不同证据层级。未注明具体未读行的，不应自行推断；缺少可靠边界时写“未提供可独立核验的完整边界”。

证据索引文件未随公开报告打包；列出的文件名用于定位原有记录，不代表已交付附件。接手者若无法取得这些索引，须重新建立可核验的覆盖边界，不能假定证据已经随报告提供。

本清单是版本、路径和覆盖状态索引，不是完成每个文件审阅的完整操作说明。已读行段仅复述保存记录，不应视为其余未读行的穷尽补集；定向上下文和依赖限制仍须保留。

## 概览

- 基线Server（服务端）282条：130条混合部分阅读、86条尚未覆盖、66条普通部分阅读。
- 基线Auth（认证与权限）13条部分阅读。
- 其余415条属于各固定差量中的未完成、排除、仅比较或清单登记记录。跨节存在重叠。
- 后续工作应先确认版本及证据边界，再判断具体缺少的静态或运行证据；本清单没有将任何缺口改为完成。

## 服务端 基线 混合部分阅读

固定基线：`aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2`。

证据索引：server/COVERAGE-RECONCILIATION.json；server/coverage.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `go/cmd/galaxy-api/entry_test.go` | `c6fec31eccb566b2c1c08d6cd204551d1601835c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/accountsocial/accountsocial_test.go` | `65c310a9a0e3a1b175e7689e92a967bd4dabc7a0` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/accountsocial/fixtures_test.go` | `5af46c1ce260bf3df618d0c7acddc279bbef4879` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/builders/fixtures_test.go` | `c7967257dec2cf5be6cc363ecb0d84450f4a9015` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/builders/portable-probe_test.go` | `19d755bd9bc2751c172f5b143cbd0d584a3f56e1` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/builders/testdata/portable-contract.mjs` | `b16255494b15379dc26d47b96fb5bd38c1d222d0` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/chat/attachments_test.go` | `9e66b6c0282a65880b5fd63e9973bea07aac3ed6` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/chat/chat_test.go` | `2afeea9ae43d14f4bc5e0bf0faa47fc94e5fbe48` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/chat/governance_test.go` | `26f2237ad7b4f99a9ac0140e6a280e42a2a6fa76` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/chat/moderation_test.go` | `c46677993f17dba8fc3474321ba9238e160ae1d2` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/chat/target_governance_test.go` | `8097e68571ba25fd66c9028d9c043d31500b857b` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/choices/interop_test.go` | `27abe0b25f31f336a1daf2ffded6155e2d7be6aa` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/civ2/ci_test.go` | `be62ee65c87832feaa662bf5c89d30112be8434a` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/community/attachment_account_test.go` | `c815237a819df39c773cc43bdaca62af195e9035` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/community/attachment_test.go` | `ddb3c1d8e4178c37f8a33310bffaed9f05cb859b` | partial；混合范围，剩余运行相关部分未覆盖 | 已读行段97–138、143–169、174–177的接口断言；扫描、物理存储与擦除辅助函数、过期清理尾部及迁移效果未核对。未执行测试，正向读取样例不构成完整授权证明。 |
| `go/internal/community/community_fixture_test.go` | `960baebc5c3342099f577c7bef7a55a93b98decf` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/community/identity_fixture_test.go` | `67926c8b567d8db9dfe5552bd136b4af33ac161c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/discovery/domain_fixture_test.go` | `aeec7adee108dc475ce8d7460813afb57a92e57c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/discovery/legacy-search_test.go` | `23bb45f98e6042a3e60d90e9664cdd7e76deed51` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/discoveryconfig/adoption.go` | `003c1e743272488fb6eb4139ec0906848a190883` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/discoveryconfig/runtime.go` | `86b57bbb341abf99b130e6d29b439ea50a3ee966` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/evidence/evidence_test.go` | `27d8fa885eecb517eeb84190b612b16e86fce6b9` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/evidence/fixtures_test.go` | `da18dae53de30b2ba068b8b226f814e8bef1a4f8` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/feedback/attachment_test.go` | `bb813f7d922627ef7dd2e1bfa0c30848495f9362` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/feedback/maintenance.go` | `b9463e175a4454d642bfa469cd9b825af0e6bba5` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/feedback/owner_data_test.go` | `10237d64ddf69d135e678cb776b823789f0ef6e4` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/feedback/owner_data_worker.go` | `b0b049deafcb924bc16ef22f6bbffa2b88227037` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/feedback/worker.go` | `6b7f9f6e85e82bf9b5203b3ae0337f2117cc361c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/feedback/worker_owner.go` | `6d2911a41ff3e2a9575e72c8923389facd8d8267` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/feedback/worker_producer.go` | `205df019a16ea3dceb041df877509a18fe9aae35` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/filegovernance/integration_test.go` | `6f8bf09cbcbf097b481f857456a0c8fd1d3bf567` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/historyv2/fixtures_test.go` | `ae06c5728ba36fe6be04f37f16296ecbe136491d` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/hubs/fixtures_test.go` | `764393a172962833a549082042376d72b26946ee` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/hubs/hubs_test.go` | `09e5cb7e1d75cf45708440692bb157cf946b7a23` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/identitygroups/identitygroups_test.go` | `8db3d589e91a7cb010ec7090558b88209bd952b7` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/incident/controller.go` | `a88d34507879b980e24ab19a0133843694f80af5` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/informationworker/configuration.go` | `545ef283d0fcbf09831379ce25513110e9dfaff9` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/informationworker/policies.go` | `adac6a313bd399c65bfa392b315e7f8376688fa5` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/informationworker/runtime.go` | `76bc765f1eb1fc09874616125457ab163a793174` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/informationworker/sources.go` | `441b43ae000fe59d1d74d8b7fcb658b6e05cdc41` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/adoption.go` | `20adeebfa4f75a6779e6118fd94f6d39b83a5cd2` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/adoption_payload.go` | `cfe5caaf7438dd53aa7f82db30649c92750595a9` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/adoption_schedule.go` | `72cbea8ed63e8d8a00671359dc2fe27054c0b15a` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/autonomy.go` | `ed83d15ff5e46a136256f46a066e7d7116d10836` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/information-watch.go` | `0ef07ac4c99c79aa91892111da5a36f63517dbe4` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/migrations.go` | `0a0d25fc4a4ba3c8ea76112dda023c9dd17c91e5` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/queue.go` | `7a8b92e8bfff070236b90f5c0cbe31a3bf816a45` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/retention.go` | `8da7ece6e60c30d0f7480609d8e29a69bb1f81a5` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/schedule.go` | `a692506a4dbc1799280cde3c8d664eb56a80cec2` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/schedule_cron.go` | `dd9f3be3600546c908364dd85b179cb28d9f7249` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/schedule_hash.go` | `6399395005cb6b955899a41b360de69afbbd5887` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/schedule_walk.go` | `7320cf5e85a37e08cdfde8c9069ea7d96cb4b20e` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/search-recovery.go` | `0df5e08ea40b990da23c183029f86c254bbdc84e` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/jobs/summary.go` | `2503c6294c3bb3fcc59f8b73dd3c0e99c70fd61b` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/maintenance/catalog.gen.go` | `9891e3dd5c9674f41d97b19a9b61f1c48d62762c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/maintenance/client.go` | `77e5bbaf305a507b440b0afee086c4dd36dc7210` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/maintenance/commands.go` | `97b57828365897842e55f59d3e9a0db74ea4f85f` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/maintenance/model-settings.go` | `bcccbb2aa19ddaada35d6c15b1efc3de74eda319` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/maintenance/model.go` | `de9528a990e8d93848b8941216d92a2d1836f3c5` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/maintenance/native.go` | `c78c9e1092036b81a98fd0e25fdd125c2c5ed775` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/maintenance/plan-bytes.go` | `6f6c6fe6fb3621f6caa33d02eff3dc7036abb0bb` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/messaging/mail_test.go` | `f87b33d778e33df55dedce53861bd4d3efed8cae` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/catalog.go` | `870cd006aa8850bc4c6c482317325253533d70bf` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/collect.go` | `408f241d986c724305c65e643e58fc45ba071bdc` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/configuration.go` | `57e96f47e9a784308179c9fa6d359e67b549f1f0` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/listener.go` | `dbd670a999b38a66786b2afaaaec3aab489120d3` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/metrics.go` | `0bd3b62b213cf92fbf473155273f158c9f4e7fba` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/snapshot.go` | `39fe330134454e521ffe3fe8a34998fc81b6a338` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/storage_unix.go` | `4983467d5f56bb023ac8353b98a4d8eaaf09ac70` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationalmetrics/storage_windows.go` | `52e7bf743d3dd9f7a20f1d61eb4b672be20a861a` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsautonomy/code_test.go` | `be62aa9a92839b51b8f260aeb62fe68865610fa6` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationscommunity/fixture_test.go` | `7d41973062cc3c87cf207219f48e1378350f5f1c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsmodels/integration_test.go` | `47546d2e566fdfbb783380bfa4573bb70859340a` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsmodels/testdata/models-schema.json` | `e0e27440446b41d647a7192fd0befcf6fffa9dad` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsqueries/integration_test.go` | `4e0ddc5e9a6f5a40283dbb9cbda298b41a7dfed5` | partial；混合范围，剩余运行相关部分未覆盖 | 已读行段41–113、183–270的当前查询权限检查；114–182发布相关片段及测试数据效果实现未覆盖。初始化状态仅作元数据理解，未验证后台执行，未运行测试。 |
| `go/internal/operationsqueries/query_fixture_test.go` | `440298ecc1feed83854f1664baab88a5121faf68` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsqueries/registered_integration_test.go` | `69ee53226357b1d0c613bc1ffcd51af1031edeab` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsqueries/settings_integration_test.go` | `f043951480ba6bf8964582c090f98766dd59c75c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsretention/cleanup.go` | `a268de445a963eb52ee09960d8cb006239a0f3c1` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsretention/worker.go` | `c2969ab8ca74e6f27b1e38649a9af2c815475241` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/operationsrules/integration_test.go` | `318769af8a945862a10d3aeaa7fed0ecf26d8c4e` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/postgres/recovery.go` | `f91a3b9b4bf618bae7098dd3838be9fcbff6bdbd` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/profiles/fixtures_test.go` | `f8935d85019d8d73517bea4073410055c7f6b004` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/profiles/profiles_test.go` | `486149f846a569227ae9697090ebf49f065a83a6` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/publication/cancellation.go` | `3aeea8c30806216bf3c0fbf248ceda83876a90d2` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/publication/commands.go` | `84598a33b145776e59b717bde437c84859d8eb3f` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/publication/control.go` | `326700b3623cae976561b00a79b741a4e889c68e` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/publication/files.go` | `bec93cdc4b285797eda6960c6bbb947c24e20a49` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/publication/http_test.go` | `9f11f7fa1b2b3d79e8b4b5d436ce8e30d5e14496` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/publication/service.go` | `f36f6cb4552b47b6858193a2221b9e523fa1b943` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/publication/snapshot.go` | `f368ed566c76bb1895888eac86110b417c817c86` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/qualification/interop_test.go` | `b32893d6db26225b4cd55feae6a9ff76a81704f0` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/registeredusers/directory.go` | `99446cf494ec17ef86798340b51cdcbc4569802f` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/registeredusers/integration_test.go` | `44cada3bc6d8b26d33fa2355d2d2fb72191d7aa3` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/registeredusers/native.go` | `57300d889903b71329d678cdd1a4c6511f41bedb` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/retirement/controller.go` | `e7c2d364f5d9676c85d6589e85c84b4ec834eb73` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimeconfig/loaded.go` | `ad4a703be017d445bd3b6960a61c46526c555566` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimeconfig/record.go` | `b0d545e1f3e13cba690fe49094f747564bc640ed` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimeconfig/registry.go` | `b482138cbb5cf2fac8226c84a590a41121340354` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimeconfig/release-go.go` | `b463c1fa5ee885bb80ba22290877aef67cf40e1d` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimeconfig/release-observation.go` | `2a95c36ee49fc7ad5df320bab8912c99c0b3ce4d` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimeconfig/release.go` | `e8e54f90ef66fcff21302003d33e748caa1eadc2` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimeconfig/snapshot.go` | `7f463eeabdc852cc6ce6e878f3b2add79f26bf30` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimelog/catalog.go` | `1b8e3b5225599d2d3f645674324aff61b8974148` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimelog/logger.go` | `aad298338a2bffceb5d036c902052bd5103f0082` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimelog/rotation.go` | `a6e1118ad6aaa8f4445e3722389414131affd91c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/runtimelog/slog.go` | `423fd12544464770b68291e9513f4d72239966c7` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/searchv2/fixtures_test.go` | `76f9951793d50bd65cd12090505c3c8502ab410f` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/subjectlifecycle/interop_test.go` | `65b7247bb59735be2dda15c3fe0cc32b217eaec1` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/summaries/interop_test.go` | `fc0e485b053dbdaa8ce9a47d7a7a2cfcdc9ba426` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/systemsettings/integration_test.go` | `add833fd5ececdc837183d5289786b969bf79411` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/taskmaterials/material_current_test.go` | `6de62a772c1582848288fe8ef0beb55f26277b70` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/taskmaterials/task_current_test.go` | `97704eccbef13ecb954e2f23f516ad18bf572423` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/testsupport/chatarchivefixture/fixture.go` | `e1e5e5cc26630e31045f18633beb1c2df468fc00` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/testsupport/feedbackfixture/fixture.go` | `02e918ed8a0140b46e6a6a869657e2442b124e18` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/testsupport/qualificationfixture/fixture.go` | `ed45c56f45724ac2bfbd13427e948b50d6e36336` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/watchcontrol/watchcontrol_test.go` | `255ea794255f8cce100c5b566f448b7f50d5f6b3` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/adoption-sources.go` | `cddf774b53297f48e39c891f2071ba4f81c12463` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/autonomy.go` | `e16e507965dea152b91c413b11eeb99d28f43d6b` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/discovery.go` | `08407de94469a5475d1d4a673db4a0487bd04948` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/evidence.go` | `17a5fac3fef3ebc5bc9b7bab18c14d4c9f9d3721` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/maintenance.go` | `43b6555284dbe5855002e28d33212aab1829429d` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/registered-users.go` | `766f6a213419a21b04a4832989c5aa6087fe6260` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/retention.go` | `fe5833b3241d2ff69d72879a868c6cfcf2a96dfa` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/retention_sources.go` | `87c131af4acf7de0df0906fb02046676fa1dd94f` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/runtime-config.go` | `c07ea71db2057801322cc1947a1c7f3099fa8409` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/source-jobs.go` | `e57df3d86a0608f8477aead8d1497627d01bf645` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `go/internal/workerconfig/worker.go` | `49e82ca48927ace7864886b88f322fd9bba5c927` | partial；混合范围，剩余运行相关部分未覆盖 | 已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |
| `services/galaxy-operations-agentos/tests/test_conversation_business_tools.py` | `c5b49a179d7258dba70764b8b592a6dc08530e0c` | partial；混合范围，剩余运行相关部分未覆盖 | 已读行段115–215、322–377的准备与当前请求边界；原生模型运行、持久化及错误存储部分未核对，未执行代码或测试。 |
| `services/galaxy-operations-agentos/tests/test_duties.py` | `287f6d0bc60821c2fa504ae0d2105d6ae411a098` | partial；混合范围，剩余运行相关部分未覆盖 | 已有记录提及行段54-89、111-118、303-415；已读局部不覆盖完整文件；剩余运行、初始化或执行效果依赖未完成核对，未进行运行验证。 |

本节：130条记录。

## 服务端 基线 尚未覆盖范围

固定基线：`aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2`。

证据索引：server/COVERAGE-RECONCILIATION.json；server/coverage.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `go/cmd/galaxy-api/runtime-config.go` | `84724f29e0f9ffda880f32e6e284453eaf884d78` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/runtime_test.go` | `e8c94436f0451c13ac0ae3992b836880b3c2fd26` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/civ2/role_scope_test.go` | `6488d209255e923e7fcf649aae82a3d061f8bdb0` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/community/retention_test.go` | `433757bb42034a14efa5b10f13184d630bcdc6fb` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/discovery/legacy-index-recovery_test.go` | `6e02874bc905dfbcc7244da5790322b7c5ea4f47` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/discovery/source_test.go` | `9bb9f9a7f3ae04314ae5d13bb5cba906f3ff7440` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/discovery/testdata/native-requests.json` | `5000a1dcd39b1bd5e3821d91fd90c58f627aedf1` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/feedback/maintenance_test.go` | `d3a08f10bbbe60c4c202af49ddfe1e5b99f4f3c1` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/feedback/worker_test.go` | `f63f96a8bfae715216d6bdb52c7757b781afa97a` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/incident/controller_test.go` | `ec3fa001c18280b55291231acf0e72324845240c` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/information/watch_pipeline_test.go` | `19eec8187d6581583ae9212fbbb1895560551600` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/informationworker/runtime_test.go` | `99081a40bbafa56145a77a50de64235996075301` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/autonomy_test.go` | `d83f4acc1b54b2c7e45a19096f2f9513674417a2` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/messaging_test.go` | `46431e08fb366beaa91c8925dad8522d11bc9d7a` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/migrations/001_galaxy_jobs.sql` | `2d46f54b0ad900d877146f6935fe5c2ab8d21c20` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/migrations/002_roles.sql` | `1a9e0481d986198a4927c118cebeb37df122e795` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/migrations/003_schedules.sql` | `df81157640ec9a4123a1659eb69d2f8f88908b09` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/migrations/004_singletons.sql` | `1872a76cc8fc2ace297d1525c08f78f3f0693cfc` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/migrations/005_search_recovery.sql` | `6a31fdf546b8726db0ac9dcec1ad0fa0cd359989` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/queue_test.go` | `3e4db753d9747cd1e33033fee2da89c482c0e781` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/schedule_cron_test.go` | `3d373d4181572d77ba38306eb639ed973171bf52` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/schedule_test.go` | `92a63be9c22ac98fc026f97c52278fe8355f1481` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/summary_test.go` | `c7359afb249d11d9cdfb725558160fe89c0edee0` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/jobs/testdata/cron-vectors.json` | `db69a5698502db1a8f88fabf1af6749807c8b51d` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/maintenance/integration_test.go` | `b4851856b9201b45937ee21b2870daa3425c1092` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/maintenance/interop_test.go` | `c8fd12d4a4276855505d99778f49f11477812352` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/maintenance/native_test.go` | `01b6210d85f33b038bf87fa5f1ca7c0c1ec44893` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/maintenance/testdata/maintenance-original.json` | `6cda77d54390ec08894df1eedc0474da5704509a` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/messaging/configuration-consumer_test.go` | `d0bc1802f630ecf469d107bdbc8a0b12ffeb83ea` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/messaging/smtp-integration_test.go` | `22dad173076fd59a014490c36ce2bede5c2269c7` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/messaging/transport-tls_test.go` | `0e6724e18fc25f361c726061f647766e5168d8f3` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/objectremoval/domains_test.go` | `2b897d21908d7d07334e9f1973356fc31736197e` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/objectremoval/service_test.go` | `355bf729a6645bb7dcc038ac0e83a614c644f069` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/operationalmetrics/metrics_test.go` | `4e0a4fb8559b7e09bb5f9b9bdc92bf780a7e46f9` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/queue_test.go` | `943028b025dbde64bd25a2473d175c7bf40e8058` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/worker_test.go` | `3c85c36a2181b74490c2c94bb1f9593056b387cd` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/runtime-integration_test.go` | `6d44264f079bcaaabead74747916d26f6d747ca6` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/testdata/strategies-effects.json` | `ff767d22f8bd937d0534585830604b4d3817b753` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/postgres/recovery_test.go` | `2ca0126f13c1490746b642297661ef471ec52aea` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/publication/boundaries_test.go` | `f4bec57d26b4648a26233bccaad21a0e81003587` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/publication/files_test.go` | `ba87e421f59dcde9e78ce164da4c7d0162b0df57` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/publication/queue_test.go` | `7bb72bbdb65f2e4fa73334c846ca01b5def7ff91` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/publication/service_test.go` | `c719b4d73cb508e1b92e408f492e2cfbba44d195` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/publication/snapshot_test.go` | `4c12710f0dc4eead068d61e1344af8d341f37ade` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/publication/testdata/site-contract.mjs` | `f0063897dfdacc5b0a1d7cb41e8092b8ae32120a` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/retirement/controller_test.go` | `564f8e3122ce17e73c19dc177d23723a2b8d995d` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/retirement/device_test.go` | `ce0a45a376dddd32f6dc1fac5a7d70615145721f` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/runtimeconfig/record_test.go` | `1dc936e87cf13bdac8584fb5e7a2fd788c7f5758` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/runtimeconfig/release-go_test.go` | `12d2e0191fc081dc6e3e1d2b20db107a9883b5d7` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/runtimeconfig/testdata/runtime-config-oracle.json` | `09fe0fb7910cad57e227c242fd466bbe18c70602` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/runtimeconfig/testdata/runtime-config-setup.json` | `d25070c75263aaa6bf8a3b0419b324810fc2490f` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/runtimelog/logger_test.go` | `413d59bad04bc3f19487c15c4e489f2385543b80` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/execution_test.go` | `68e99da00a1b12c8b19f8a75bb6103534ea0ae5f` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/ledger_test.go` | `740490d523a1669c1f7a0b96dee4782e907ff546` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/maintenance_test.go` | `51322ece804932bf58a226bcc7e7f05907e965c9` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/retention_test.go` | `3f34d7d5e2e026e399e0a0d0847fa9ba46a18501` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/testdata/original-execute.json` | `d3953653aff25a699fbd977c2ca71a16a29dce43` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/testdata/original-maintenance-catalog.json` | `8f0270fb91e6d57a03951c1d22bef46cda132d79` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/testdata/original-minimize.json` | `e39c1e1f3e66470ce9b2cb60f9c2e8362e87672a` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/testdata/original-replay.json` | `516115155759ad621730d483810aa7a18ef7a33d` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/testdata/original-retention.json` | `04d9aeaacdea5ac219b164184026f76a1b25c58d` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/testdata/synthetic-execution-data.json` | `6ea56aa99fa3cc7fcb6290ce5bd3cb6d5b47a84b` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/testdata/synthetic-execution.json` | `4b1e3fbbf4ab5179056bbf36ea48635a612a1bdb` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/systemsettings/adoption_test.go` | `27408aa2690abe15b91ec362f5d69e9bc880acb9` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/systemsettings/testdata/settings-adoption-api.json` | `047a16e5ed53f312acca84dbb8ea5128f3b9db31` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/systemsettings/testdata/settings-adoption-worker.json` | `c69a5066b733ea7c749a581920329f693439fe80` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/systemsettings/testdata/settings-mail-adoption.json` | `fdadb4df08dc3954ec4390e468e61ceb35cdaade` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/postgres.go` | `fb87384f6de88dc4914813df30372435dac35ff7` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/publicationfixture/fixture.go` | `d3cdf376ce99701e8b7b1078bb305c6917805b7e` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/syntheticdb.go` | `e51877719ec87a1af3a946accbaf3b2ad46cc4d1` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/workerconfig/adoption_test.go` | `818575ea5de98cbbc857feab329ba09170248652` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/workerconfig/evidence_test.go` | `31dd52bd05b8a93831e8d804db5aff9f8f4fdf15` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `go/internal/workerconfig/worker_test.go` | `f2a4dff5f976c036fb2f5ad6af6b3f78b873cbad` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/Dockerfile` | `30d93f38c69fccbe18da4451107db54c3c6247f2` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/deploy/duty_probe.py` | `e08b09318d75e850db92a473e90d924009e99fdf` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/requirements.lock` | `a810feee9bcea7a3ca7845ce5d2342e11e5a4c3e` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/runtime.env.example` | `8b096bdce2302666a7165dfeec0cad8f3aa050cb` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/database_contract.py` | `561142e67db6ab4e313cb178be842322fb7fe790` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/fixtures/native30_gateway.py` | `ae2c6309290f4bccb0d8a31e696eebbcbe8c18c8` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_database_contract.py` | `fb8701001f82eeb05c6147ceda0abe3c965609b5` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_failover_native_agent.py` | `ff692ad0da02d096aa86ffa18eba17e6746a14a7` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_native_runtime.py` | `a9f24637d54105f53f34b2bd59e75b3c21f1b6a6` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_p13_continuation.py` | `140609cabaac8b90f2117ae4563b34a2860873da` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_p13_strategies.py` | `4ede78af4b6df628d585361563795126cca161c3` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_reliability_native_session.py` | `238992c6c199c7f645dcbc2f621e8e8efc3d941a` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_workbench_live_contract.py` | `04c22af44052eee076acc9e778194f45224d526a` | pending；运行相关范围未覆盖 | 本文件内容尚未完成静态审阅，运行或执行效果相关依赖未覆盖；未提供可独立核验的完整边界。 |

本节：86条记录。

## 服务端 基线 普通部分阅读

固定基线：`aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2`。

证据索引：server/COVERAGE-RECONCILIATION.json；server/coverage.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `go/cmd/galaxy-api/full_browser_seed_test.go` | `1409fe27ac8d61269db91c75d07f4d128d1e0cfa` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/full_browser_test.go` | `6e7fbcc775610651a76e92d8fffe12886f166109` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/accountsocial/testdata/captured-setup.json` | `b6c4d2d1cafec81844b80debed94497c912561dd` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/builders/testdata/portable-setup.json` | `bf2e55bfe90bd433ff082e5d09dc545757742749` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/builders/testdata/read-0.json` | `dc03c989bbe12fb5d4eea5aac7591ac6788e224c` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/builders/testdata/read-3.json` | `35a476ea3d414ba37704256a313695de65b872e6` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/builders/testdata/read-4.json` | `4a0d6f8122e2db1cf2e8f1a241d31e2f77173a17` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/builders/testdata/setup.json` | `ddd2fb31f341c585e285bd5b758ba3548a3c8fa5` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/capsules/testdata/read.json` | `6d26d0397924aab253653d6a7994e4b2b1a44f36` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/capsules/testdata/schema.json` | `e5c0af3464f5c6877b2dc774bd8d109886ee1481` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/capsules/testdata/setup.json` | `b6c84262e9c43283487b242363314fba9f8871aa` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/cases/testdata/read.json` | `30e473541634da7512d91628ccc75aa955f3c9e5` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/cases/testdata/setup.json` | `110b0593c967c694c118aeaa51e9d161d0bfb213` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/cases/testdata/v2.json` | `efb840ff2fe8fa6d4c13c6fe516c920a49763c0d` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/civ2/fixtures_test.go` | `49219bb9ac481ba9bbc61225a3274e43d3949f25` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/civ2/testdata/read-0.json` | `9d07464672438ae1ba9be656121f3f1b7cb14d78` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/civ2/testdata/setup.json` | `d40ad1684ce4094387eda50f99c609de3bdcc48b` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/community/testdata/governance-fixture.json` | `2273213c3388763f441783621f65b5858a259b08` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/configurations/testdata/private-setup.json` | `ab7204c7f55fd4b7ac6975ea64f096287da7cac9` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/configurations/testdata/read.json` | `f44b48143da67bf9b84dfda0e4d2f16f3a94be6d` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/configurations/testdata/setup.json` | `de0e9c05ef657897e1362c6f90b48b0fd48dc590` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/context/testdata/read.json` | `2bd0601e6fa23c3c83c38b127c0827e2b39dd2a3` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/context/testdata/schema.json` | `75349e90524539caf54873585beaea72b5bdbf21` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/context/testdata/setup.json` | `b66574b81825808f5da9c92c668af4acd5e3c41b` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/discovery/legacy-builders_test.go` | `d055d37831d416770ec697b0a372e9e97b0c628f` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/discovery/legacy-capsule_test.go` | `1832e0a8117ce875adf6f4e8c98cd3a7b2f2401c` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/discovery/legacy-proof_test.go` | `0a76433951155d829f0608b5472fc514aacbd60c` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/discovery/search-quality_test.go` | `58067f19ff0230678887e3dd9f26903f61cd4d48` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/evidence/testdata/read.json` | `1fb94c404d9eb96a3efe322ae8c126c5987b2904` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/evidence/testdata/setup.json` | `f1395a6c6c90021081b5a1c9e53e2a32c0d68637` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/failureaudit/interop_test.go` | `0253f41dd5c4571ae665b3f8e07e7484613fa5be` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/failureaudit/spool_test.go` | `2424cb845b862c8a6fc6064b8b979349932ca3da` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/filegovernance/fixture_test.go` | `5dd7f0f65134eb80a7bed18c4d92eb6345a67423` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/filegovernance/testdata/original-processing-facts.json` | `267a11d0b1bcc619944a8cbbdc2fcbbcb04d0194` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/history/testdata/query.json` | `4d13f48aed58f8a34a8cd5fe0925378eec649cf0` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/history/testdata/setup.json` | `fbb30a1b9173a4b0043ed61a1da9eac1a47a888d` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/historyv2/testdata/read.json` | `33531d0089cdc9f8bcc6456af42dee277d5aceed` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/historyv2/testdata/setup.json` | `bfe6e7de4bff85566966e88490ba686d27abb3a2` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/hubs/peering_go_fixture_test.go` | `e62354bfac6a854e62f21b7df2236d8bd2667649` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/hubs/testdata/read.json` | `6ee3d6a4141c5cbd46416f2fef4fbd18836afb9d` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/hubs/testdata/setup.json` | `750623cbb49657aeed8fb0a7af81cc01d8fe2002` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/identitygroups/current_fixture_test.go` | `d8f96b5cc4f8c7de0ab7a185d9d0a43211b89ac9` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/identityreturn/testdata/original-page.json` | `1fa4dc37fee2e57e260ece0ce6766a57306d033e` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/messaging/domain_test.go` | `25fdc1f718175cf69848153a326da74acd47c03f` | partial；普通未完成 | 已读行段24–46的固定权限测试替身、230–250的请求身份拒绝断言及278–291的当前读取和账户端点标识断言；其余计划、运行、入队、投递和恢复效果未核对。测试替身不证明真实会话有效性，未执行测试。 |
| `go/internal/operationsaudit/testdata/audit-projections.json` | `bbf7fe5f51dedfd52f0e2037998fb6878ed19d4c` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/testdata/strategies-schema.json` | `b475d753a9426fe79b9fc0c7757950ec62f2a4aa` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/personalmcp/catalog.json` | `75d5e140a68ea361b157acddeb9b3e0634acc5e8` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/profiles/testdata/captured-setup.json` | `25b3a3eeb496bf6cd05e4324ce9163baf355dae6` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/registeredusers/fixtures_test.go` | `42bf9ad426e407073a6c244b5c76c00e1afa3948` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/subjectlifecycle/fixture_test.go` | `5c242ac938541d87cd769c5e591a1fcab1ea958e` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/systemsettings/fixtures_test.go` | `225eb21d23cabfb14da6eae9e12cc474eb1edf7c` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/systemsettings/testdata/settings-schema.json` | `be0f7caa260659bc44d30d8e96fcf5ba756fd995` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/autonomyfixture/fixture.go` | `fdef5f48564b53eb0b55fa951b9232d18b89dd53` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/deviceauthfixture/fixture.go` | `2e1b6ac01cb069279a027321d2cd153ab64b4301` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/devicefixture/fixture.go` | `4e13accf9454ea668a5d1bb6bdbaedf96306bd75` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/operationsfixture/automation.go` | `bc003252ff6d3a988a5c980f8a9cd03387fbf940` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/operationsfixture/fixture.go` | `bce6a8e4946ac32a4b10b43bda5d5523a7284687` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/qualificationfixture/capture.json` | `98f68d409ba8199fe1f650e52669ba13dd689e96` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/qualificationfixture/contributions.json` | `0cea8cb760723c70bc466d778fb67f71a434d918` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/testsupport/qualificationfixture/requester.json` | `abbb4f7d1fbb3f6c943e5bbee06b437051fd1504` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/verificationrecords/testdata/read-0.json` | `fd144e30f0834222842547e47cf5f1201c780380` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/verificationrecords/testdata/read-1.json` | `4257a631d3b5f2134bbd1e236e41031ae1206db9` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/verificationrecords/testdata/read-2.json` | `e39beabd8e67468c1c8b3cf7762796fec809ff4d` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/verificationrecords/testdata/setup.json` | `9e972f94097afc5eb43908402bd1726b8381f892` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/watchcontrol/fixture_test.go` | `e748d387eea7724a9308b6c8523c1079cd19e9ee` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |
| `go/internal/watchcontrol/testdata/setup.json` | `3a65674ef6c5a97940b595d988f4304003d44f2d` | partial；普通未完成 | 仅检查声明、局部正文或边界引用，未全文核对实现与依赖；未提供可独立核验的完整边界。 |

本节：66条记录。

## 认证与权限 基线 部分阅读

固定基线：`aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2`。仅是Auth账本局部状态；同一路径可能在Server账本有其他覆盖，不据此自动关闭。

证据索引：auth/ledger.md。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `go/cmd/galaxy-api/main.go` | `c8d125c195f8daf5ec0cdd1300d802ce051a656f` | partial | 仅有接口连接或指定片段记录；其余正文与依赖未完整核对。 |
| `go/internal/community/http.go` | `cba543d3d1522637cb80119eeb1f04a4f18578b7` | partial | 已有记录提及行段48-70、95-170、245-320；仅有接口连接或指定片段记录；其余正文与依赖未完整核对。 |
| `go/internal/community/identity.go` | `5166ece1a197b2389a280e2bc55afe5e76e1e097` | partial | 已有记录提及行段20-180；仅有接口连接或指定片段记录；其余正文与依赖未完整核对。 |
| `go/internal/community/write.go` | `8cda2b4788ba1c8e432a34672d8da5d26c20fb7b` | partial | 已有记录提及行段358-445；仅有接口连接或指定片段记录；其余正文与依赖未完整核对。 |
| `go/internal/credentials/testdata/owner-read.json` | `e251f315ec49e926199dcddda7225c63343c50ea` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/credentials/testdata/read-current.json` | `6df741c55fc015d4bc38dfba0342b930b5aa292f` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/credentials/testdata/read-revoked.json` | `ec36a288b084f61713ba4e10732d5396f1ff033b` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/credentials/testdata/setup-http.json` | `0b25825d66d749bf294a59092b7757b78b1bc032` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/credentials/testdata/setup.json` | `f5d4cecda6cf1145752493688b99cce81524c041` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/httpboundary/testdata/http-decisions.json` | `8cce7ef5b8e17a100cca8dc04b059a7ce1b84b17` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/identity/testdata/control-chain-vectors.json` | `c61d2be6698af2a6a01c4c3f16ae270f2ad9ef69` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/managementaccounts/testdata/schema.json` | `05dd35eddb70f7b2d3aa3d0268c59eb8c9b87b4d` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |
| `go/internal/operationspermissions/testdata/permissions-codepoint-schema.json` | `0646b436f36008e2cfccd498c45b63bdc5700d4a` | partial | 已检查完整 JSON 的结构、字段类型及错误/状态样例，并阅读使用它的测试源码；未逐项核对所有标量和不透明签名值，未执行测试。 |

本节：13条记录。

## 服务端 差量 8179704 未全文件覆盖记录

固定区间：`aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2` → `81797043ca9e871c353608c4c990a8daeb155f35`。完整比较记录列在此处不表示它们没有完成分配的差量任务，只表示不是新的完整文件审阅。

证据索引：server/delta-8179704/coverage.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `go/internal/agentos/conversations_test.go` | `13e35ae7e4b3eaa11911496fac32c98d671f955f` | complete comparison：源代码变更语义比较完整；未变部分沿用基线全文记录 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/databaseschema/catalog.gen.go` | `65c67865932a9c82e775a9b89966b67c446b234c` | pending | 本区间仍为待审；未提供可独立核验的完整边界。 |
| `go/internal/databaseschema/sql/134.sql` | `8d734f4c010103984d583a095a468666fbe9dcc4` | excluded：运行范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/worker-role.sql` | `396cb2d15e773722af9004e42ee3601d51ba1267` | excluded：运行范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/discovery/search-quality-reconcile.go` | `fd4b3b03e843bee406074e81c514692e3c87b265` | pending | 本区间仍为待审；未提供可独立核验的完整边界。 |
| `go/internal/operationsai/catalog.gen.go` | `24ae5e9a544e72c816468e13481546dcbeb0e080` | complete comparison：终点变更完整阅读；未变部分沿用基线全文记录 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/code.go` | `d8d0e2307f1856ef38c200b49c57b034860ea374` | pending | 本区间仍为待审；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/queue_test.go` | `a40185886ef99baf606caf1d4db4100ed43cf3be` | pending | 本区间仍为待审；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/reconcile-operations.go` | `23b015f0fb609eec473bb42e40c61f65878545bc` | pending | 本区间仍为待审；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/worker-recovery.go` | `fe114f86cf5f8f4d8cb3e6790f00da8ddfbc7f36` | excluded：运行范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsautonomy/worker.go` | `5fc9ee2fe584a5027599e6fe421ad29e8bef3578` | excluded：运行范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsautonomy/worker_test.go` | `d84ee59ca8566990657ebac5a23bc9cc8bf53b4a` | excluded：运行范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsquerycontract/query-contract.json` | `a8312fd78816275b971f6178a0f899a5209e0f5f` | complete comparison：终点新增内容完整阅读；未变部分沿用基线全文记录 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/workerconfig/autonomy.go` | `bea7d597f85c9ce2b03ca988f964de1b249bb031` | excluded：运行范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-operations-agentos/tests/test_conversation_business_tools.py` | `b3e201ca182c7bf1a110007282e9563f5309018b` | partial：仅准备与当前请求边界；原生持久化未纳入 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-operations-agentos/tests/test_conversation_retry.py` | `708b948d133cebc6f4e290a1f7710a31d1711c77` | complete comparison：源代码变更语义比较完整；未变部分沿用基线全文记录 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_conversation_transport.py` | `41b66d24da08a2c14f0541ae4a3e741c6e23bfa3` | complete comparison：源代码变更语义比较完整；未变部分沿用基线全文记录 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_current_read_concurrency.py` | `cda35d3b5b851448ef43f38cfd41689b02c4096a` | complete comparison：源代码变更语义比较完整；未变部分沿用基线全文记录 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_duties.py` | `d036faf3e1a4a4ace6af445b8bb494342ea98905` | partial：仅当前请求与元数据测试源码；运行部分未纳入 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |

本节：19条记录。

## 服务端 差量 595cd2a 未全文件覆盖记录

固定区间：`81797043ca9e871c353608c4c990a8daeb155f35` → `595cd2ad4e3d09eab61739ffa1b034c993f962cc`。完整比较记录列在此处不表示它们没有完成分配的差量任务，只表示不是新的完整文件审阅。

证据索引：server/delta-595cd2a/coverage.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `.github/workflows/product-checks.yml` | `4d4984620169a331a5975ba6670acc69b065f4f1` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `WORK_STATUS.md` | `a6f45ed7fd66770117757a710f9e91eca2bf48dc` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/ai-work-accounts/AiWorkDuty.tsx` | `539b1d921891bb29ae01ba980a0a1e53d1817fbc` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/autonomy/autonomy-types.ts` | `d7d800cc41bcc21085b38d71a8347875e46a537e` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/workbench/WorkbenchActionCards.tsx` | `8f48a8df0c0d608b3ae2964eb52f6821ae942087` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/lib/settings-draft-memory.ts` | `8c04029cd1b31744d2421cd87d3c356226f9c283` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/lib/workbench/workbench-action-cards.ts` | `515ec4adecb647d400f0b0f22f4c61f1486b641c` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/test/admin-query-boundaries.test.mjs` | `309e8e7d8c3749493cfe628c9da0896c152b58dd` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/test/settings-draft-memory.test.mjs` | `73d60891f0c625ac2e5b13ae33253b5bcee8cc19` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/test/workbench-action-cards.test.mjs` | `59209245b293e8240590a222676109c5c5f04a4d` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `docs/technical/agent-runtime.md` | `76b8f81873ee9cfda0d17bcfc2118bf37d4422d1` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/cmd/galaxy-api/main.go` | `43eb369eaedaf9cc2f8576a2b590bc50001ec470` | partial：请求、读取及准备边界 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/cleanup-plan.go` | `6bf509e85b5785b083444aff94676b596f2b9124` | partial：类型化准备与规范化逻辑 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/content-tag.go` | `2e70dd9f50c9c516414bbacc0230897f76ab0fd9` | partial：类型化准备与规范化逻辑 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/content_tag_integration_test.go` | `cea6dd812205c75251065528ed69c06a2dba289c` | partial：仅静态测试源码中的边界检查 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/discovery-commands.go` | `c977bbaeadc2e1d86c79ae3eb801ae6903ef2cae` | partial：仅差量清单；恢复边界未覆盖 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/execute.go` | `4f57b259b0cda43416f1af1200846d013e5492e6` | partial：确认权限入口 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/notice.go` | `9c03963fb051ee64663f5556398c3463233d716e` | partial：请求、读取及准备边界 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/notice_lifecycle_integration_test.go` | `06eaf452e48004a5fb2dd960fc2807157c1a6995` | partial：仅静态测试源码中的边界检查 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/prepare.go` | `4cd8066d2ed00186ff57c115773250b5bea977ad` | partial：准备入口检查 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/recommendation.go` | `854d60f1991c2ac7ba2e015ddf9041e789c5bbcd` | partial：请求、读取及准备边界 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/recommendation_lifecycle_integration_test.go` | `745b9d28950aa8115abaee08548d335cefe09e3b` | partial：仅静态测试源码中的边界检查 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/recover.go` | `e38e22b05a47f82d8935f846e1c90988df02b37c` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/agentos/actions/search_restore_recovery_integration_test.go` | `b9686e22c201d4e4d0e45eff5974028f990b62ad` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/agentos/actions/service.go` | `d317416cbf74afc38f67ba75c0fcb05536ba5c22` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/conversation-summary.go` | `ad76c8703d7fbc20c940234452f49970ec0dd986` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/conversation-summary_test.go` | `6b9875c6f690720bd919ad4e9af7b8428eb7cea2` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/conversation-tools.go` | `eaf38394310da0216d8c18f8dd21e8ac73f46a17` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/databaseschema/catalog.gen.go` | `0df63aacb68a0f089cf4e2bcf270f44d8168a207` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/135.sql` | `fc479caceb88457f484643d71360ae112dcbd76a` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/136.sql` | `44880f33c41c777c2447d218fd0bbae2c11908a6` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/137.sql` | `7fea6ab70b5f2d7611619a5a9bf1ff0a995f33e5` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/api-role.sql` | `a5b5adce6dbda18eea73a4aeec83be7849d66956` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/worker-role.sql` | `0d56eb2ce9c3bd0063e83112eee3c5da8032bd2c` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/discovery/action-source.go` | `7d2a0ab2450f2a54e08567334162cc97b8769732` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/discovery/query-read.go` | `6925cfa68580cbd54d75464cda4d9fbc7773965e` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/discovery/recommendation-input.go` | `5eecb55389a8fd0211d72b270f50efe564883a2f` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/filegovernance/cleanup_action_integration_test.go` | `0692425886a3696082607dd40e4e9930b45ea2b1` | partial：仅静态测试源码中的边界检查 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/messaging/notices.go` | `195066a2ae69c14c68dc378f67275c860ab2f8aa` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsai/catalog.gen.go` | `044439200b3c90e5b449b33247c07e37efe396c4` | excluded：生成动作目录未纳入已审显式映射范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsautonomy/completion.go` | `551637b06c209d8348d57594335549ad197b7b54` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/configuration.go` | `a000da802809d9ca27fbcab0203065eb736038a2` | partial：配置输入与请求检查 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/operationsautonomy/read-coverage_test.go` | `2052190b4b0338aa7fa4fadbebe907313a6ad6a5` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/tag-receipt_test.go` | `b50e9a8c5e8db5f34376b1dceb915950635075d4` | partial：元数据与当前权限测试源码 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/operationsautonomy/task-sources.go` | `f92023caff5298c267e48cbce2cf13a9d49e7095` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/tool.go` | `311de7034de9491bb870563618be4bc5ad497383` | partial：当前请求与读取元数据边界 | 已读行段1–110、186–203、225–308的封闭输入、任务与原生运行绑定、工具允许列表及读取元数据边界；写入、协调、回执及运行分支未核对。 |
| `go/internal/operationsautonomy/workbench-card-reconcile_test.go` | `3a1b225554b35814a0dcb394e6819d763a451c5f` | excluded：运行与状态效果测试范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsautonomy/workbench-facts.go` | `98d1b7d5a913df95d035dcea03a02e1d1727f000` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/workbench.go` | `61c68a61f95342c7083d36f43f3815b9050d25af` | partial：仅差量清单；运行及状态效果边界未覆盖 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/operationsautonomy/worker-workbench.go` | `42de71666184992c832a471b6ec2079108aa6426` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsautonomy/worker_test.go` | `ea45442c16c6b603ba548d6161c43ad3deffbd96` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationscommunity/content_input.go` | `976cd1ee09c4957c915d00212c4d15dfc41cfd2a` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationscommunity/content_read.go` | `397d082d0156f37373d4b9825386574cb901d902` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/conversation-summary.go` | `5617d016c790b945a6935e8b6e5494bf0747cf06` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/discovery-read.go` | `8b8bf6507a0977db4e738db7e6bf45d50df9e5a8` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/domain-projection.go` | `484f70ada5feb9170e61ad50c803ebe0e926e867` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/domain-read.go` | `3e8ae9ca0f3df469497138fd8fdaf813de251e4c` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/input.go` | `a777f0486c91bdd2e4459f21cefe1dd3097870d2` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/messaging.go` | `812024797d6a32a2302446eb1b1142802fc812f3` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/read-receipt.go` | `7b1defba1711a5a81568bad9393d1dc7ee60e45c` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/workbench.go` | `2965c073a23fc2ab4817af85ab37932122d2ac16` | complete comparison：完整变更段比较；原覆盖限制保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsquerycontract/query-contract.json` | `2f635cd3de92874307f325074320e9ce7c2c4c06` | complete comparison：完整静态模式结构差量比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/workerconfig/autonomy.go` | `113743d3c603d1c10fe8b35945f19b7944694827` | excluded：运行与目录范围未覆盖 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `packages/galaxy-contracts/src/operations-agentos-query-access.mjs` | `3f23ac007a2335972683da4c4ddcea9512381f70` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `packages/galaxy-contracts/src/operations-agentos-query-schema.mjs` | `6168ddf53b74c1e0c4f80d0a9539d3a4a08f1a5f` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `packages/galaxy-contracts/src/operations-ai-action-registry.mjs` | `8680307fe9b7a12ef0372d7fc5a2088ac7e74383` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-model-gateway/src/galaxy_model_gateway/response_guard.py` | `ce9acce503e84f10f71adba82cfdde24f30ac135` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-model-gateway/src/galaxy_model_gateway/surface.py` | `7a598d1c5fe94ffa7af19738322b21b9dd70db3d` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-model-gateway/tests/test_response_diagnostics.py` | `eaee01ed51acbc573f6e8d3730085ca14d680f35` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-model-gateway/tests/test_run_correlation.py` | `06e0bab00b2f5ae2cdd3b44b4c966fb3392435b5` | excluded：不在此服务端差量范围 | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tool_contracts.py` | `4ea249e22f036ba1d12a6078d2ee83359e0e0c52` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tool_feedback.py` | `dac8efd7f27ccf17836cdab74df9c66303befb11` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversations.py` | `e60c8e91bcd5722e1c06bfd5c202dc54db6b857d` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/model_settings.py` | `4322f65c1cfd52a32d430448476ee7b773425e80` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/run_view.py` | `6c993be716be2ec4921e1a19147fa55e8a1b15b5` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/tool_reliability.py` | `4996c0022e99350ed5631c5bac8ce8fa1506e427` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/tool_schema_feedback.py` | `f353d1e47bcd35cdf076f2dfb826e75f687bbb00` | complete comparison：完整变更段比较；原全文记录保留 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_conversation_failures.py` | `04f6d205215e4b89cfcc8bf7deb68d07a3f6c15a` | complete comparison：完整测试源码变更段比较；未执行 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_duty_completion.py` | `d4c0b15f18688aeb21cc8bf419ed8921b0494bb8` | complete comparison：完整测试源码变更段比较；未执行 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_tool_reliability.py` | `84d5c0d05822ed94f88b2214ec65a8b5d1106446` | complete comparison：完整测试源码变更段比较；未执行 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_tool_schema_feedback.py` | `acd1d0e40dd47e61e56dea286ad7d61fdaa6dad2` | complete comparison：完整测试源码变更段比较；未执行 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |

本节：81条记录。

## 服务端 差量 eaf74b3 未全文件覆盖记录

固定区间：`595cd2ad4e3d09eab61739ffa1b034c993f962cc` → `eaf74b3b8f243b812eb7746488bc12264f1206ce`。完整比较记录列在此处不表示它们没有完成分配的差量任务，只表示不是新的完整文件审阅。

证据索引：server/delta-eaf74b3/coverage.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `WORK_STATUS.md` | `73dddd02a1daf56bb340db0171b0a3850d9e9193` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/ai-runs/AiRuns.tsx` | `7834c62f1e1e404919e27bc53d1c55f121df8240` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/autonomy/AutonomyTaskResult.tsx` | `4b746160398191a07ad68d8fa93258fb637f44b5` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/autonomy/autonomy-types.ts` | `940e9f8a56b10f4aa5675fcdff0b69dec56ffcb0` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/autonomy/autonomy.css` | `0e97516f76b283ce55040d9155b08419a346917f` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/strategies/Strategies.tsx` | `c21aa8b706edf49c0b6cd1643746dff68c4ae1d9` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/strategies/strategies-types.ts` | `af2d3a9f777337b65123b2ad92d93028b72e5da6` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/workbench/WorkbenchActionCards.tsx` | `820fe4b883b75bafb9dacd4d8a38eab4e10f22f9` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/components/workbench/WorkbenchCommunication.tsx` | `df6b78db53984b0940807d107eaf1449a8866791` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/lib/strategies/strategies-view-model.ts` | `a631b4813511185778e02b2a17eeba667c10ddbc` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/src/lib/workbench/workbench-action-cards.ts` | `67c77a026dd6a495e82fe8a0e4b7d31b03cb066d` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/test/autonomy-task-result.test.mjs` | `311a2c6c6d2842a02171b65911c470035ac20899` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/test/strategies-view-model.test.mjs` | `7efdf93fa17442d83969572a558f77accdf15bf4` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `apps/galaxy-admin/test/workbench-action-cards.test.mjs` | `2bebf86e66dfdb4cf11168b0800bd76853625328` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `docs/technical/agent-runtime.md` | `ebcdd6fca55ed85ee419846299cda1e675fbe0b7` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/cmd/galaxy-api/agentos-actions.go` | `40c349b507007b3e0e04b7c595862f1dea16fa51` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/cmd/galaxy-api/agentos-execution.go` | `d14eaa2a724e0f449b474b299bde42b644e32a4a` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/cmd/galaxy-api/agentos_original_receipt_test.go` | `ba43e9ad13e401e826c31736b51b7c264765c44d` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/cmd/galaxy-api/main.go` | `dc92c23db0c4bbe549c1c2287640db506a21f795` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/duty.go` | `35df76a60c9ce2d02ee2520f1d95e95718e95aae` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/execute.go` | `59eac22fdb9fa5d139f6912b945c13ef03acb189` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/messaging_review_recovery_integration_test.go` | `caa42a85a63757fa31651e66fe692b10a58d7693` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/agentos/actions/messaging_review_test.go` | `c15de91596969f526b4838015c44e8379a644c5c` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/actions/ordinary_create_duty_integration_test.go` | `d7e15d7474a222d1915160cb3a5e9433ca6270cf` | partial：部分静态测试源码阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/prepare-messaging.go` | `ed0896620cab51f9924e911dc75d46d702f038bf` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/actions/prepare.go` | `9570736ebaf109bed87f7fe65b1aceddbb5b4b93` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/actions/schema.go` | `530951e6c53a356724b60dabd993e7450da9cc35` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/actions/service.go` | `c1ec66ca8ce3d87762228b0a55a710be643bcbb4` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/actions/strategies.go` | `deae3284f4e9ae3239358eafce0155bb46a9d963` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/actions/strategy-commands.go` | `12b4a2aa87128f5db85eb537ce79053f0930d843` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/conversation-cards.go` | `1282103fd9e773d23a37319622d87e6136ea98ad` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/agentos/conversation-read-authority_test.go` | `6dbc436efceb12b716bd6bad62386daa19e036b0` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/conversation-sources.go` | `5bda4d81cb2f1628d4a59d2897875535454ff7bd` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/agentos/conversation-summary.go` | `d7b2c19d5d2908acb73535573c2ac46e363b7295` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/databaseschema/catalog.gen.go` | `fae034e3f9e014a1c9d93c9b3f906a667867a1e1` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/138.sql` | `c5ca04a02ae7b29fd7eae29582f3a030d44b2dfb` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/databaseschema/sql/139.sql` | `cee322184371dfa1d00aa2908565b115ffa81fd5` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsautonomy/ai_original_receipt.go` | `7b64c91dd88574a71cd3167c60a228b613b49db9` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/final-analysis_test.go` | `4afee47a02af0e3b0596f590395da2fcc4018950` | partial：部分静态测试源码阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/operationsautonomy/inspection-ledger_test.go` | `9688e17e298ccc60a9ab95129b20502db1df95c7` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/inspection-outcome.go` | `bd6a664bb8f8e9ce3006ec42b881a2fef96a0298` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/model.go` | `9068c4ecae3d422199912f0bc66f2cee9067119b` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/ordinary_create_schedule_integration_test.go` | `7f4a4bb78ca11e7f35bcee63a465912a769e30da` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsautonomy/read-coverage.go` | `d59250648dfb1c0a18af0ece6d2a35e5f16e3687` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/report.go` | `bc8d35939de0635aa2ceabf3d44d428cdf0d5c14` | partial：部分静态边界阅读 | 已读行段15–72的最终分析载荷、完成状态与运行绑定，以及126–156的首次写入幂等元数据和长度边界；状态迁移、效果检查及运行消费者未覆盖。 |
| `go/internal/operationsautonomy/task-views.go` | `cdd9c65bd1286fd93ddc7c677b94e9e8bb837f01` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsautonomy/tool.go` | `47d88c44c5cee7b776a3db3c86dfc372d0ce2a0c` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/operationspermissions/query-original-receipt.go` | `0106a68613104bf622112b97f1b8b3d3a477e4a2` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationspermissions/query_original_receipt_test.go` | `50c1549bac166d52bb4e9056a628aa68bd40e39c` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsqueries/discovery-read.go` | `b037cbbcae2ffa18275bc1c8881ab173aa77edf3` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/inspect.go` | `6c85a8dc4e68a05d576efa7c8caa8290d753c78a` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/maintenance-projection.go` | `1a1d4443c808956633f45c338f2b54db1c53693a` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/policy-read.go` | `7cca62977d5d226bc8879f85f06638d9c8fe02d4` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsqueries/read-receipt.go` | `debaeb07190d5dc9b6bf91908976a3af39a30275` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `go/internal/operationsstrategies/catalog.gen.go` | `f3e48a6f9b9bcc20f25bca15a9ba9b51e2742247` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `go/internal/operationsstrategies/ordinary.go` | `d7dcb0bc5f4737e70166382c263bcdfc2a2f580d` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `go/internal/operationsstrategies/query-reader.go` | `7c6363715c81f8b9fc3f27bb35c06b26c92c65de` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `packages/galaxy-contracts/src/p13-strategies-schema.mjs` | `17a46b7b4a09298a41b690baf3de49669a2cb652` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-model-gateway/src/galaxy_model_gateway/metadata.py` | `7a9989ed32659efa671eec0bfab5adbd0a2983ec` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-model-gateway/src/galaxy_model_gateway/response_guard.py` | `e94cfc2d1799f5ac0ad9b98380ce42c8705f7556` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-model-gateway/tests/test_response_diagnostics.py` | `56f00b2ef02158261a694193447fa1702033b732` | excluded | 该记录未纳入此范围的内容审阅；其他证据索引是否提供覆盖须另行核对，不据此判为全部完成。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_storage.py` | `992fd0499f6f45722a43492e96120c06170a31de` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tool_contracts.py` | `c69afba2843415b6ab83bea710e3eb28f7d406af` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tools.py` | `f1320ac17f90eab1c7e3a72e4145f5c102946f30` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_turn_context.py` | `1e47c44d333a94b66d76f3cf96bb51903588f081` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversations.py` | `145b901a7111646ed6f3e9aeeeeb3eeb32f5e52a` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/duty_storage.py` | `1a20966b1f510715744773b0af5f392fe6a5448a` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/gateway.py` | `5cffda5242d89996e5a3b5895fd6c7fd203bbcbd` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/provider_retry.py` | `99713209599ae7f069281d63af0c95ee441f8453` | partial：部分静态边界阅读 | 仅阅读部分请求、权限、准备或元数据边界；其余正文及依赖未完整覆盖，未进行运行验证。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/tool_reliability.py` | `f4dbda06696705bc6014f2783e9341ce63f70710` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_conversation_business_tools.py` | `5749a6ae02d1c97a0713199c3d5cc8ebafe867f4` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_conversation_retry.py` | `51d11952cb3222440132a12eb2d5a6c4dd682843` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_conversations.py` | `b6eac928766fc64f8121940373ac093357bd962e` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_domain_preparation_factory.py` | `96ee95fc618449af1406414abe88adc78e3441a2` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_prompt_management.py` | `3163b8b55f36572d107f0539552f768b8c4cc0f1` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_provider_retry.py` | `ce04c06a5aa67d5933c65aa9c781c76013e5d060` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_query_coverage_contract.py` | `e969979c88eb3aebe08184a05ee37239c2482687` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |
| `services/galaxy-operations-agentos/tests/test_read_object_filters.py` | `ebdba54d92805748611e82868455edd97edfc7f8` | complete comparison：完整变更段比较 | 已完成变更片段或结构比较；未变化内容保留原有覆盖边界，不代表本版本全文重读。 |

本节：78条记录。

## 前端 eaf74b3 终点版本部分阅读

固定区间：`595cd2ad4e3d09eab61739ffa1b034c993f962cc` → `eaf74b3b8f243b812eb7746488bc12264f1206ce`。

证据索引：web/delta-eaf74b3-ledger.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `apps/galaxy-admin/src/components/ai-runs/AiRuns.tsx` | `7834c62f1e1e404919e27bc53d1c55f121df8240` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/autonomy/autonomy-types.ts` | `940e9f8a56b10f4aa5675fcdff0b69dec56ffcb0` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/autonomy/autonomy.css` | `0e97516f76b283ce55040d9155b08419a346917f` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/strategies/Strategies.tsx` | `c21aa8b706edf49c0b6cd1643746dff68c4ae1d9` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/strategies/strategies-types.ts` | `af2d3a9f777337b65123b2ad92d93028b72e5da6` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/workbench/WorkbenchActionCards.tsx` | `820fe4b883b75bafb9dacd4d8a38eab4e10f22f9` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/workbench/WorkbenchCommunication.tsx` | `df6b78db53984b0940807d107eaf1449a8866791` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/lib/strategies/strategies-view-model.ts` | `a631b4813511185778e02b2a17eeba667c10ddbc` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/test/strategies-view-model.test.mjs` | `7efdf93fa17442d83969572a558f77accdf15bf4` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/test/workbench-action-cards.test.mjs` | `2bebf86e66dfdb4cf11168b0800bd76853625328` | partial：差量完整，终点全文不完整 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |

本节：10条记录。

## 前端 差量 685f129 部分阅读

固定区间：`eaf74b3b8f243b812eb7746488bc12264f1206ce` → `685f1298c08727d29a498972dd4c4aea801481bb`。

证据索引：web/delta-685f129-ledger.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `apps/galaxy-admin/src/components/workbench/workbench.css` | `dd4c457afabfef0e031f5bb1017bc324e4251c06` | complete comparison：仅完整变更段 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |

本节：1条记录。

## 差量 685f129 清单中尚无本轮局部审阅记录

固定区间：`eaf74b3b8f243b812eb7746488bc12264f1206ce` → `685f1298c08727d29a498972dd4c4aea801481bb`。总路径数81；这是本区间局部内容审阅记录的补集，未跨历史版本去重。

证据索引：delta-685f129.json；web/delta-685f129-ledger.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `.github/workflows/product-checks.yml` | `631872f2d468ceca777c8e2ce92663604064c898` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `WORK_STATUS.md` | `75ae849b57115d4ad19c7dc17ae65b54ca5ee5f4` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `docs/technical/agent-runtime.md` | `39216416148b0a948755755ffefc2545acb2f758` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/agentos-execution.go` | `cc863a9fada0584024e00a87210d6568bfb99ac2` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/strategy-ordinary-preview-integration_test.go` | `39e7ea1a90ea3c08e7f20cf0db862c8549671416` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/strategy-ordinary-preview.go` | `05eca84e8a184899e0ba271efe16b490245b7c97` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/strategy-ordinary-preview_test.go` | `e1496a9afbfc6f8feb6bb48bf0e03b513fd28446` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/prepare-messaging.go` | `59b6a302224e28933a9e1db0e33f9894c01d9be7` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/strategies.go` | `07191b8f1a26690f0546bf8bb1cd6a974c5d3c34` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/strategy_rehearsal_samples_integration_test.go` | `d08266ecfc967088cfecac670efb8f301dbf1160` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-admission.go` | `14055e52724e9929f1cc15e2d898bc5aab024c11` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-http.go` | `acb5fc663aabd553a8946f905bb4b370e07392b9` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-ledger.go` | `4cbf3a6f1f819433dfa2070575f52f0d50f3ecd2` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-projection.go` | `d5d21fe15156a487b622fadaaafe753f02e0885c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-run.go` | `5a7f9ecf3d561e99c669659fa7fad42bdfac4b43` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-tool-failure.go` | `cb2060dc352b5b8d1b38cd3ed4f13db59c58e6be` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-tools.go` | `f05e335dd5a4745d282ddd7f1aef1f8b046dac74` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation_admission_test.go` | `a10092ff3b78cc6fc84433136ebedcfe4a4e70f6` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation_times_test.go` | `81aea14dad300013e5686853ed3269838f5f2a6c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation_tool_failure_test.go` | `f05d4429de0cb801d1cbd56b52f000b3087c8a78` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversations_test.go` | `16eb4489b15d772bdd14ef2e3ad716c5a79c9029` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/messaging/prepare-eligibility.go` | `8b344344be8d9dcaaf371a3097ca55288fe0a18f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/domain-read.go` | `98c650613c59eac7b9e66bbdaadfced9a1347e7e` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/messaging-lifecycle.go` | `e1d251f704c6cebca9c12df965ae680226ca181f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/messaging-lifecycle_test.go` | `e24d8e634a2ee4823ac2c29023209ffe8557373a` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/messaging.go` | `28675dd7ced507b3530f433ec2c828e25395dfa0` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/policy-read.go` | `ebcac42ddef8276cae7ef5f8f0dad3770d398daa` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/preparation-integration_test.go` | `3dbdf4a4f7c6879fc89474c636c7cf60549452f4` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/preparation-projection.go` | `eb2f4814104424afb9e1f4a4fbf66992e829805a` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/preparation-projection_test.go` | `11c2b560a4cff36069a222307df569616dd8ca0c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/preparation-read-context.go` | `95b9101a21e6fc0bc5ffaf7a62124e55991058cd` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/service.go` | `8b68e326d3e7530721267fa3aced3dd3c3d41c6f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/settings.go` | `e90e3864af13654460e162b2cfcda14113d650f8` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/settings_integration_test.go` | `cdf2a00ebea4230256c74566e180227f42e2ec78` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/settings_projection_test.go` | `bb81ea9bc19457477db8726b92928cf54f5e105b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/continuation-authority.go` | `65af9379e7fd986e978647aa3bd2bca8f8b5759f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/effects.go` | `bc2c3bffaa982aa00544b2c776233e5b34cfb517` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/p13_agent_fixture_test.go` | `c16d010c9dafb98231e01206e154c7910b26d6b8` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/rehearsal-samples.go` | `e9e32c209da085b3554ff66534ca25a59b2a0024` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/runtime-integration_test.go` | `e664b6be0ca215405617f71d352ee9ad4e93f892` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/runtime.go` | `1f897c11dfe0ddaa2dc69afe9dfcca199c04b9cc` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `repository-components.json` | `d9bd45d2d71b90f152118aee2f0f6d67fa79dbbc` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `scripts/generate-p13-agent-schema.mjs` | `f9b4af47c5dbe6b6a32ed123b2a8ecf46854e490` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `scripts/test/components.test.mjs` | `4067f315cb96431a8ce182848c1b0d4ec867b0ab` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-model-gateway/src/galaxy_model_gateway/response_guard.py` | `d9ad86bd1c1e54dbe7b4c14aa449ab88573a4e6f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-model-gateway/tests/test_connection_robustness.py` | `0eaf867fcd33bb9140226c0852db9dae1a53469f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-model-gateway/tests/test_failure_status_surface.py` | `3035cba2600604bbca97ee90f7e49176579bcbe5` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-model-gateway/tests/test_response_diagnostics.py` | `80068493cb31f46e54f1f5d172a00b3605fde142` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/pyproject.toml` | `5382315ca3777da194504c833e1be2f2ca135e2b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_message_drafts.py` | `f2dcc79f5e0d063af3668b2203bcdcbc891f6c02` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tool_contracts.py` | `72a2928032918a57149cf16e92f3f2840473a93c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tools.py` | `6c2d345032480e10f78ab2dab6450d7c918f625c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/p13_configuration.py` | `7ecd939ace05c882ed34bad19caced76969c5dd4` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/p13_configuration_schema.json` | `3f145d0831386b7fd5215a5dd8b97164134a642d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/provider_retry.py` | `e3ccfa98ffbd347acc95e4e7e5a43f9e73d312fa` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/run_view.py` | `1e2e42f8fbb2613d9c2077531585a9fcbf724942` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/tool_reliability.py` | `6b4aee4ab1c06d8159d3f05cafdb3ded58d8c309` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/tool_schema_feedback.py` | `3e9b4e03154af868d2cda8330c12c7c2e54efc3f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/fixtures/p13_configuration.json` | `d418cfab18a39c9c1347b54f54295be4cb3a17a0` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_message_lifecycle_sdk.py` | `39096759d15aad341c3af904acaca95461d159bd` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_p13_configuration_schema.py` | `cc8b5361ad718c9ab05542a2442d1613df411b2e` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_provider_retry.py` | `67171e3bfad33a626657e0fcbfed1fd51108d5f2` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_run_view_times.py` | `1b2480eb1e8c1d8d6f1d71f10237699b00e1bc71` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_strategy_rehearsal_sdk.py` | `dbf011b6d01a8b3733d2c182fb89d2c9e0511571` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_tool_reliability.py` | `b0407047f124f19453e6ad08981416fc87996e40` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_tool_schema_feedback.py` | `974814c31062380ae6af5cd479f5cb7b64b6dbee` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |

本节：66条记录。

## 前端 差量 bac5caf 部分阅读

固定区间：`685f1298c08727d29a498972dd4c4aea801481bb` → `bac5caf92d3df87a0b9a7841dea356394fac4335`。

证据索引：web/delta-bac5caf-ledger.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `apps/galaxy-admin/src/components/ai-runs/AiRuns.tsx` | `1045b42766c830046f0e14efef8666983387acef` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/ai-work-accounts/AiWorkAccounts.tsx` | `679740e61654cafe9f94dac0cd7d58f1afcfa049` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/autonomy/AutoOperations.tsx` | `c82dde82ee453c1af6906f5ff003cf2f2769ea28` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/autonomy/AutonomyShared.tsx` | `dc107ed8d884702197a6e3b738bff0f25825a3d0` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/workbench/WorkbenchCommunication.tsx` | `f860c8a75e2420b6baaeb69a9143138f294cbb4c` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/components/workbench/workbench.css` | `da878e1360eeeccf9c100b6c1bb17580c3950001` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/lib/autonomy/ai-runs-view-model.ts` | `73035ca81cdef2203080ab35ec309e88ecdffc08` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/lib/autonomy/autonomy-view-model.ts` | `d26507c76a79e1121916194015fd109b39a9535e` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/lib/strategies/strategies-view-model.ts` | `201dcdbe5663b98e850850106b67b209ae6507ec` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/src/lib/workbench/workbench-view-model.ts` | `effe533dac5802698b02b44b7d27fb3a6f6e26b2` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |
| `apps/galaxy-admin/test/workbench-message-queue-ui.test.mjs` | `de8ec8991c1fcf4341316f1724dc777d6486d037` | complete comparison：完整变更段及必要上下文 | 完整变更片段及必要上下文已读，但未独立重读未变化正文；不包含后端授权或运行效果验证。 |

本节：11条记录。

## 差量 bac5caf 清单中尚无本轮局部审阅记录

固定区间：`685f1298c08727d29a498972dd4c4aea801481bb` → `bac5caf92d3df87a0b9a7841dea356394fac4335`。总路径数93；这是本区间局部内容审阅记录的补集，未跨历史版本去重。

证据索引：delta-bac5caf.json；web/delta-bac5caf-ledger.json；auth/delta-bac5caf-permissions-ledger.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `WORK_STATUS.md` | `37ae4b82bf43f88b5b17c90b80aafa318b26e7f5` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `docs/technical/agent-runtime.md` | `e910bd0504a8b14370edb12cfa64ae55593f5f28` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/agentos-actions.go` | `f863f945e0b06fd0c25c2b0ec6c1a0538add0aca` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/agentos-execution.go` | `381c513c9a343b3f2e91436faa3f7cc4ac530020` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/agentos_file_task_source_test.go` | `453a5a32f78c58e9bd07fdc61072d0e81fa3f104` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/agentos_original_receipt_test.go` | `4865edfd921fed39cf938cabb366764ed3b45c42` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/strategy-file-access-preview-integration_test.go` | `ec36caa75bf67e59b0b0535727529c14c89ff53d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/strategy-file-access-preview.go` | `c9268db760a570cd7a087a525e8ab3fbc68723ad` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/strategy-file-access-preview_test.go` | `470667d1a1b6149111aec235deac55529ae1e4e2` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/account_duty_receipt_integration_test.go` | `72c0d8478850201229866408d8a5c5bcee6697c9` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/duty.go` | `b325e705397abe55067e2d857b9d3e961dc9c396` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/execute.go` | `c703e25a8d7ae9971a61a700d3247c81ebc343fc` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/file_access_duty_integration_test.go` | `b30fe160afe505636289b7a3b41b712a828e8c09` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/prepare.go` | `0976458bf596f16d1b556da0ea70626d763644f6` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/schema.go` | `7fd754983276a49c2c21ebb2eb38bd4fb8dea179` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/service.go` | `48c6d3c918d93a3f28db91996450ce22ec16e191` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-rehearsal-summary-integration_test.go` | `4ad63cfe4096f83249ce33d50c6efbca8df17156` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-summary-cards.go` | `592a86c750bfbc4cb5ac8b5aa6c093d83300c8a4` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation-tool-failure.go` | `6b0dcf70e1fa2eb115a18c07b542837a74eca4be` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/conversation_tool_failure_test.go` | `a88ad6e0ba938971858e574e8eb14a42a5f3fed5` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/workbench-run-metadata.go` | `e904c22868532496872c92b645b43ef889f1cae1` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/businessadmin/ai_original_receipt.go` | `64945c25fe6372a9ff87e50455a6ffabdd3b92cf` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/businessadmin/trim_action_text.go` | `9a2075d2e3382236bae42cb672f48c42b9da6fa2` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/databaseschema/catalog.gen.go` | `14da165ffe63bf79ab68e530d5febb1eaefd0ef2` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/databaseschema/sql/140.sql` | `65907467fa33c83da0536e684ddd0771959e29dc` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/databaseschema/sql/worker-role.sql` | `4b8b3b4780ecbe2afcb187f762013dc3cf50e342` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/filegovernance/access.go` | `5ed5d5391c3959ece5e2a61330c305c0da7c9435` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/filegovernance/access_gate.go` | `22f6b62dfa917ad2efb873c3393d783f2dbfb5fa` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/filegovernance/file_access_scope_test.go` | `a63860c47f98b98a48a54ff40e24ee59cc8c2169` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/filegovernance/original-ai-receipt.go` | `04bb98113ae739f24fb3307d16dcf2695bb55d14` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/filegovernance/read.go` | `3eb3830d40f5fe2878ec88aec6b26ad41c39f54e` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/messaging/domain_test.go` | `c313684bb8f613d7f1e15e10a2ecaecf9e61f32b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/messaging/model.go` | `528babdb7d0b230c4815323eae56726f395ec84e` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/messaging/notice-read-content.go` | `3b714088cd7bbb6ac9d4738aa98ae9919514304f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/messaging/notices.go` | `c64a21e010076ebf82ad7aa710a27e7941af6155` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/messaging/worker_plan_role_test.go` | `773c7501154f65f6067e104ae9cbad5257b98653` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsaccounts/commands.go` | `3537c151fcea72dd8a21f6f26fbe0222947cf30b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsaccounts/original-ai-receipt.go` | `63af87b6fe56a5e3096891120dbd8670928e4e41` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsaccounts/restriction_request.go` | `e9896480383af841a893ff42632c5940ab639117` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/ai_original_receipt.go` | `6b3ed79a6b683039c95ad7b2496c2940cb86f1bc` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/worker-workbench.go` | `a326cf708d1eefbd82c1e41f017296c8f56fd2f7` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationscommunity/case-read-source.go` | `ff0fc6b819bbf0126ace897239c8aa7007f57d04` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationscommunity/case_duty_receipt_test.go` | `b6706edf30d90f15214739df364b03e9e1970ac7` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationscommunity/case_read_source_test.go` | `06f4f4eff282661ceca3e56323cd182b79400d5b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationscommunity/original-ai-case-receipt.go` | `efdfe9be507d051ce062dc29a06ec4488bd8742f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsjobs/equal_test.go` | `2cc9bb2b9e0d8293922a6e72b2b4262f96c0d25b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsjobs/retry_integration_test.go` | `63556938eeedac803799724daffb5fbc9bad304e` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsjobs/service.go` | `cfc3981178440b2f4e15746be171c008f8db2c3c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/input.go` | `5d4851aa70a06d013727ef02c4aa559ded46a050` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/integration_test.go` | `f04f2d4c85c0425245288eabf990de363deba88f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/messaging.go` | `4ed2152057bea558cb70ccd3d50ed98c4081b509` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/notices.go` | `2bec18286ef2657c6e97068e71b93ba67345da3f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/policy-read.go` | `48f2bc043838f7c0e6ea5f95564b16af414e6acf` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/preparation-integration_test.go` | `be67255507d073e4fdf2255d44a136f8e8bee3d6` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/preparation-projection.go` | `1c686dea0f7a8fc9d1309268fbe461578a76e2e0` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/preparation-projection_test.go` | `be469d005f6df7bc9c31f990d96bce71d72b4329` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/strategy_version_rehearsals_test.go` | `084dbb561d0a0ab66f1efe74c10b312d8d8cab68` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/strategy_version_test.go` | `08e7cf80be3add308cae5b9e484b84d8093a2859` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsquerycontract/query-contract.json` | `1b1d07750fb7cc3011c5796f8dc21ea6c6d43a8d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/query-reader.go` | `11bcdc0c474405f547aa4cca39941e54491256c5` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/version-rehearsals.go` | `28aeea4e83ebb1c273326cb9292ba575e138b168` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsstrategies/version_rehearsals_test.go` | `432ba69757ba97e4af5769815c95982ac1cacd33` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/workerconfig/autonomy.go` | `da1a48d1dce1146c8a36d05e3db0c4dcc9c7aa37` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/workerconfig/workbench-observer-integration_test.go` | `b88c4aedc2394802f936967c6dfa4f55f095a86b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/workerconfig/worker.go` | `663dc880b31026d880272cd8212cf51f3455c337` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `packages/galaxy-contracts/src/operations-agentos-query-schema.mjs` | `03a0ddcb3fb6cf8f479d69ca243eb1d23c039222` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_message_drafts.py` | `e548f5e37b7196f43898f85587d6948b86965e7f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_task_operations.py` | `44a4f346a64d835244f0da8f6c8df0960a39ae73` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tool_contracts.py` | `1a248f97ed7ddbb32d5bb2715b00f4560f0c386c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tools.py` | `1d8f8931afbe51ccc55e66416551b5e818510db5` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/gateway.py` | `458b539ebb650569309bc9106cc8615fdf341ae1` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/tool_reliability.py` | `16a6ac5b82f37b1fb0d3dda232de10a2645664fa` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_conversation_task_operations.py` | `f86d88746432ca88471708f31e7d0a611fedba1c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_message_lifecycle_sdk.py` | `5c2b4c6a198ec2972a9c8c7a1dd87146bbff4556` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_read_object_filters.py` | `81fb68c05cb741a69511eeb04f2f899b394d6106` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_strategy_publish_receipt_sdk.py` | `7090324f5da5eeada0c51b5db34f1bfd2e5b3260` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_tool_reliability.py` | `da034e54db031eb361670348616a8c55c62c8e8d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |

本节：77条记录。

## 差量 95f7197 清单中尚无本轮局部审阅记录

固定区间：`bac5caf92d3df87a0b9a7841dea356394fac4335` → `95f7197cc2eb59a30f014e316a431c4f9c5f4bb7`。总路径数65；这是本区间局部内容审阅记录的补集，未跨历史版本去重。

证据索引：delta-95f7197.json；web/delta-95f7197-ledger.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `WORK_STATUS.md` | `b8fd0cca00c6d2b2ffe3dca8694298f1afa239ce` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `docs/technical/agent-runtime.md` | `5646d5ccfea4c2daf9b985af625312893b8c171c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/cmd/galaxy-api/agentos-actions.go` | `c251b48fd78ade473422d683abc232214491628d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/account_duty_receipt_integration_test.go` | `4523a4bc0b1de0947dfa0743e3d04876b59ad714` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/duty.go` | `041c25fb1a902cd0cf35c8fd77e64fcca68ef395` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/file_access_duty_integration_test.go` | `90dfc42a70f1b5caad9b7dba74c29bfb2a29949d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/actions/ordinary_create_duty_integration_test.go` | `5ad4746834c37f53e2ef7fe9c1db0544d5dc1d93` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/autonomy.go` | `dc9b5d4b9e3b5cd56890da711d4340191f719768` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/agentos/autonomy_test.go` | `272ab0e49ba0fbad736fc19f4be49efb9c432dd3` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/databaseschema/catalog.gen.go` | `814ddf36b697b6dadb3213d9dbf96d713129eea0` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/databaseschema/sql/141.sql` | `ef19f1659d25fd24fc830b5727e162f6630dea09` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/databaseschema/sql/142.sql` | `59fa335d803feb52f7b51d45ab62550510ed2e67` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/jobs/adoption_payload.go` | `291b107cf5ad56ee198e155c77e0178edd4b7214` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/jobs/autonomy-payload.go` | `d1dcc75b9eb25fd7466c32590acff6b118147fde` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/jobs/autonomy_payload_test.go` | `7f8eede32299c10566e5a196c5857413ffde8afb` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/jobs/queue.go` | `a7e721fad3bdd5cec405be7dcfeb3a23873486c6` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/authorize.go` | `ab2bf8f745dc41dee1da660628f9a7a81df219b0` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/completion.go` | `7870265dd4a25141323896d327a354a934bb1f03` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/control.go` | `93f11bda350562628ec30435ef573c3799ac3f6b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/duty-strategy-artifacts.go` | `14cd4a8a9261aa4d061d4a082542e7d3d2e8c241` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/duty.go` | `b3a4e19ac276ed5506bc190cadc8972d845ffae4` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/manual-pause.go` | `35a9981fc3d0d0dd5fdb8075da9cee4f10b3562d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/manual_pause_integration_test.go` | `9de7e232ed2c3c4045f990a223e8bd9fa982687a` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/model.go` | `5e4872cb5c584c8fff4ff527b428618af96e6f84` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/native-attempt.go` | `c6a119f12aa640e6df28796a4665ba5dc9926bc6` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/native-usage.go` | `21742dba14f8cd3c52b0d27a1c194010ab229d1d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/native.go` | `590bdf6ab54c0863c1fed4e97139c0811fcf924d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/native_retry_integration_test.go` | `b2fbf99d0aaef1b3e838a7756505c50ecbc889f9` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/native_usage_integration_test.go` | `0f9597ae983ed9e5b5252f8f6af72b202fa9fe28` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/operation-authority.go` | `9e8d7cbb5176cae2b07806bb96b0fb63ebbb6877` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/ordinary_create_schedule_integration_test.go` | `5a5b4aaef7d248aded63ab719ada715c40871e20` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/pre-dispatch.go` | `42a44e8f599488eb4f2f0a421756f07952ef558d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/preparation-rejection.go` | `3455334922a7d40a58261c398b11bfef68352fd3` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/queue_test.go` | `176a6ba2fd2a6ec6245316c7526da7d45b236215` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/read-coverage.go` | `8d169c7d4921ea21abf2bb354b16415452e8ed70` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/read-resolution-integration_test.go` | `d088fcf6aa927d9f6d7daf155040f2742750b359` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/read-resolution_test.go` | `fd42bb48da19bbd956429099db500e377dd17572` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/recovery-duty.go` | `fe3dc852bed573a7674b4d1e6594848c141f0cb1` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/report.go` | `6a27d4865316a9fdabedd19a675c30446147388d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/task-sources.go` | `b659ef19bf7b617fadcc155864c9e797b611d392` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/task-views.go` | `1e617ad6acc7d705bdfc9201fce71f2dfb5ac365` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/tool.go` | `fcd884ffbc3ad7f43f95461ca2d72d7b9b6f132c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/unresolved-writes.go` | `3b67e66057087375b3f6c1c7c21437a1e752203e` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/workbench.go` | `9518e90f86102d48997efe4d13779ebe6474bfda` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsautonomy/worker.go` | `1b50991950103f5cb8916634d185d5340369ff7b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/policy-read.go` | `1877096478e9419d30387926282e182ddae77d2c` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `go/internal/operationsqueries/strategy_version_rehearsals_test.go` | `be8837fa39ee2130eedcf6463da2df77b9f7ef63` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/authorization.py` | `3c574ecf45434238cbbcf2c104b3b7347d79d1cb` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/conversation_tool_contracts.py` | `d2f4944e064f13b27cd2ea324b52ff7b133aad22` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/duties.py` | `ed9332c100ce115bca175c1df6c52a0c3d90d477` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/duty_attempt.py` | `af7f144eab97659ea4a446c99cbd1df077a06914` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/duty_completion.py` | `0451dea1386c4d54eecd56f9657a011239da943b` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/duty_continuation.py` | `bac0aded5ce7aa0c0a18c812f5e9be35f747b335` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/duty_storage.py` | `d49838fd62c05f781182eea13b7f0928092e850f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/duty_surface.py` | `3653afbb7e7448d9cd844542594f04bd244aad02` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/gateway.py` | `cc12679d42200742dc12c886ee16f859278c7973` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/src/galaxy_agentos/read_model.py` | `04c5d3f2d3e1b9341f41f2d7712f9762cc47c56a` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_conversation_business_tools.py` | `2a12afef525720335d0b179c1324e78eaadaa4d8` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_duties.py` | `e1ac66fa9bfa341beea1b747669d37591a6254af` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_duty_attempt.py` | `9ced62ae5eba67912cf2ef00b4832c9b9d557914` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_duty_usage_snapshot.py` | `226c1f656628cb58f0a8d1ef2b182cc8642299b6` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_ordinary_create_contract.py` | `88e90efc7b167b12fbdf349832f2a6d3a7319691` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `services/galaxy-operations-agentos/tests/test_read_resolutions.py` | `b9f9e14feebbc044b92738e6a2063fb68eec3eae` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |

本节：63条记录。

## 差量 0bd3e35 清单中尚无本轮局部审阅记录

固定区间：`95f7197cc2eb59a30f014e316a431c4f9c5f4bb7` → `0bd3e351192fd76c7bf8f01419ed6cb126b12aa1`。总路径数2；这是本区间局部内容审阅记录的补集，未跨历史版本去重。

证据索引：delta-0bd3e35.json。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `WORK_STATUS.md` | `80575dd107d561091aa2d711718dadf4e3adc09f` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `docs/technical/agent-runtime.md` | `ebdc4e20531ae77dda03b56e2f72339dee37af8d` | 未纳入已保存局部审阅；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |

本节：2条记录。

## 认证与权限 8179704 继承基线的变更比较

固定区间：`aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2` → `81797043ca9e871c353608c4c990a8daeb155f35`。

证据索引：auth/delta-8179704-ledger.md。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `go/internal/operationspermissions/catalog.gen.go` | `7affd12d9d73b889ceb5cbaffe01392b288e1b01` | complete comparison：完整差量；未变字面量继承基线 | 变更片段已比较；未变化的生成字面量沿用基线记录，没有独立重读本版本全文。 |

本节：1条记录。

## 8179704 未见内容审阅记录的清单路径

固定区间：`aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2` → `81797043ca9e871c353608c4c990a8daeb155f35`。

证据索引：delta-8179704.json；对应Server/Web/Auth差量账本。

| 路径 | blob | 保存状态 | 缺少的证据 |
|---|---|---|---|
| `WORK_STATUS.md` | `077a4a4afa3ba2d30a523b53392f088da22f6d1d` | 未见本轮分区审阅记录；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `docs/technical/agent-runtime.md` | `24b0ccd34c383259d64ffaa2e5b5920ef08a3ca2` | 未见本轮分区审阅记录；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `docs/technical/reference/api-error-catalog-v0.1.json` | `cd6c5f04866d267a1b74b2d3582a255bc60f4588` | 未见本轮分区审阅记录；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `packages/galaxy-contracts/src/operations-agentos-query-schema.mjs` | `6058e0ba1f12238ba9a8e99d8498df5455d916eb` | 未见本轮分区审阅记录；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `packages/galaxy-contracts/src/operations-ai-action-registry.mjs` | `0655856425f6e1a8d397c0176ce3fe3d3673fe44` | 未见本轮分区审阅记录；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |
| `scripts/go/generate-query-contract.mjs` | `cf9178bb6d57c42cdb0cc904c7345552622f004d` | 未见本轮分区审阅记录；仅清单登记 | 仅有路径和版本清单，未取得本区间内容审阅记录；未提供可独立核验的完整边界。 |

本节：6条记录。

## 尚缺完整路径映射的证据

- bac5caf权限辅助函数新增的files/accounts/cases（文件、账户、案例）原始回执消费者，其对象、任务、操作和原请求绑定没有形成完整审阅证据。现有元数据没有列出全部消费者路径，不能补造路径列表。
- 95f7197前端两文件审阅不包含后台retry/pause/resume（重试、暂停、恢复）控制的当前权限、原运行绑定、版本检查、资源限制及执行效果。完整后端路径映射未提供。
- 0bd3e35两条文档路径仅登记版本元数据，未读取内容；不能据文档文件名推断部署或测试已经验证。

## 使用说明

本稿是独立编写的交接清单，技术限制来自列明的既有证据索引。缺少证据不等于漏洞已成立，也不等于该路径安全。下一轮仍须区分静态实现证据、跨文件依赖证据和运行验证；未完成部分在取得相应证据前保持未完成。
