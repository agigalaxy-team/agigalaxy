# 原生客户端发行许可与 NOTICE

2026-09-13。依据 CUR-33 下完整 `ROOT-Q-RELEASE-POLICY` 授权代选，CUR-35 恢复执行。选定自有独立发行组件采用 Apache-2.0，第三方维持原许可；本次不改变整个仓库、未发行服务代码、用户数据或运营资料的许可，不发布 Git 仓库。

`integrations/native-v2/legal/LICENSE` 是 Apache 官方完整文本，来源 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt)，本轮取得 11358 字节，SHA256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`。同目录 NOTICE 将许可范围限定到本次选定的 Galaxy 自有原生代码、Skill、集成辅助工具和说明文件；第三方及商标权另列。

MCP 2.0.0 的确切安装包 `package.json` 声明 MIT，实际 LICENSE 同时保留许可过渡说明、Apache、原 MIT 和文档 CC-BY-4.0 范围。生成器保留原文和元数据差别，不归并成一张全包 Apache 许可证。官方历史参考：[MCP 原 LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)；实际发行证据以锁文件和安装包中的精确文本/摘要为准，不能以浮动 main 内容替换已安装版本。

当前 bundler 外置第三方 npm 依赖，发现 node_modules 被嵌入源输入时拒绝使用此许可 profile。`source-hashes.json` 记录实际选定的源文件；其哈希不证明法律权属，开放依据仍为已确认项目发布政策。外置依赖的实际版本、原 package 与 lock 许可字段、原始许可证/NOTICE/COPYING 等文本和 hash 进入 `license-inventory.json`。esbuild 的原文只作构建工具归属说明，不意味着安装包包含编译器二进制。

流程必须分开生成和验证。用新的绝对候选目录，不能重写已签名包：

```powershell
$repo='C:/Users/USER1/Documents/ChatGPT/projects/active/银河项目/agi-galaxy-network/05-build/repos/galaxy-founding-beta'
$candidate='<新的绝对候选目录>'
$prepared='<新的绝对准备目录>'
$node='C:/Program Files/nodejs/node.exe'
Set-Location -LiteralPath $repo
& $node scripts/build-native-v2.mjs $candidate
Set-Location -LiteralPath $candidate
# 新候选没有 lock 时按 builder 精确直接依赖形成 lock；已有已核验 lock 用 npm ci。
& $node 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' install --ignore-scripts --no-audit --no-fund
Set-Location -LiteralPath $repo
& $node scripts/native-license-notices.mjs generate $candidate
& $node scripts/native-license-notices.mjs verify $candidate
& $node scripts/native-client-release.mjs $candidate $prepared 'C:/Windows/System32/tar.exe'
```

这里的绝对 Node/npm/tar 路径是本机已核验路径，其他机器应定位自身运行时。上述命令只构建无凭据候选，不签名、安装宿主配置或公开发布。生产签名继续由既有调用者以短期注入方式完成，不能为了生成 NOTICE 读取发行私钥。

导出函数为 `generateNativeLicenseNotices({candidate})` 和 `verifyNativeLicenseNotices({candidate})`。前者无网络，按准确 lock 对全部已安装运行组件提取原文，新建 `third-party-licenses/`，拒绝覆盖旧输出；后者只读重新计算、比较原文与清单。缺少依赖原许可证、版本不匹配、lock 改变、原文遗漏/篡改会阻止新的准备。未知可选平台组件也不能标成已检查：此 profile 要求对应 lock 成员实际安装，否则报出缺失，不假造跨平台覆盖。

`prepareNativeClientRelease` 先只读验证，再把全部许可文件纳入实际 tar 成员、字节校验及 `package-files.json`；已有协议验收报告的 artifacts hash 覆盖这些文件。`createNativeClientRelease` 不修改已准备包；旧已签名包保留旧字节，后续需新发行才能带上补齐内容。

2026-09-13 的实际验证使用 `05-build/native-v2-candidates/native-v2-20260913-license-check-1`：118 源输入、6 个直接依赖、7 个锁定运行组件；新增加的 canonicalize 4.0.0 来自已实施的信任包，其他依赖无升级。7 个运行组件原许可加 esbuild 构建归属均已复制。压缩包 32 成员，其中 12 个许可/声明/清单文件。

无凭据实际封包位于 `native-v2-20260913-license-prepare-1`，`galaxy-native-client-0.2.0.tgz` 为 162448 字节，SHA256 `26b5452937f953c5e70b9d1b43c2dcde4b973c5446640ac298f1c147c79f6f4f`。本轮候选是检查材料，未自行签名或发布。

必要验证已通过：原生许可反例 1 项（真实 MCP 混合文本逐字保留、只读检查不改 mtime、缺文本/改文本/改版本拒绝、生成拒绝覆盖，临时目录清除）；实际压缩包逐成员精确核对；已安装候选 HTTP 4 项、stdio 3 项；合成签名/主张篡改拒绝 1 项。协议范围依旧为 `local-stdio-http-fixtures`，不是八宿主或真实用户验收。
