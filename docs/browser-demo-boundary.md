<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/d7/d7036ace7636c2d03034adfcd4e3df6dd524694326b7fe80540497a1d86024a9.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 浏览器演示与正式接入边界

| 表面 | 数据来源 | 可以做什么 | 不代表什么 |
|---|---|---|---|
| 本仓app/page.tsx | 浏览器localStorage中的galaxy-browser-demo-v2 | 演示Case、披露、模拟授权、未签名Proof，导出示例 | 不是官网、真实Galaxy身份、Core记录或远程连接 |
| Core与原生/galaxy | 用户明确初始化后的本机文件和密钥 | 本地工作流，按确认执行可信宿主连接 | 浏览器演示不会替它初始化或导入资料 |
| 05-build/official-site | 独立静态官网源码与发布记录 | 公共说明与文档 | 不代表动态Official或Hub已部署 |
| packages/galaxy-official | 经认证授权的服务及数据库 | 当前本地开发中的绑定/Consent/事实服务 | 不读取或接受浏览器模拟身份作为持钥证明 |

演示ID以DEMO-开头，其他记录以demo_开头；不再构造形似GUID的随机字符串。随机标记不是公钥指纹。缓存要求version2及galaxy-browser-demo标记，严格验证结构；旧v1缓存不读取、不迁移、不删除。无效v2缓存保留并提示，后续明确演示操作可写入新的演示状态。

导出标明kind、signed=false、authoritative=false，用户输入原样包含，不能声称输入内容一定无秘密。页面提示仅用示例数据。浏览器不会读取文件系统私钥，也无远程发送调用。将来任何正式网页接入必须建立独立身份/认证/签名和精确Consent流程，不能直接把此缓存升级为正式事实。

AI-agent验证：运行scripts/test/browser-demo.test.mjs及网页build，检查DEMO不能作为Genesis验证、旧缓存拒绝、导出非权威标记、页面无Core/Official导入或网络发送。真实排版/交互体验另作人工验收。此批不注册、发布Sites或改变官网；已有依赖、锁文件和hosting配置保留。

回退仅回退网页代码，保留两代浏览器缓存；不得批量清除用户localStorage。更新存储格式应另版本化，不迁移至Core。当前/galaxy复制提示只复制文字，不执行本机操作。
