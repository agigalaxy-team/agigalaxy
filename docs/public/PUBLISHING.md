# 公开文档维护

[agigalaxy](https://github.com/agigalaxy-team/agigalaxy) 主源码仓库是唯一维护和公开来源，不再向独立介绍仓库同步另一份首页、许可或贡献正文。根 [README](../../README.md)、[RIGHTS](../../RIGHTS.md)、[CONTRIBUTING](../../CONTRIBUTING.md) 各维护一份；本目录保存面向使用者的专题，`native-client/<version>/` 保留准确版本指南，`site-files/` 仅保留独有宣言与支持说明；Issue／PR 模板直接维护在根 `.github/`，`examples/` 保存合成示例。

修改直接提交到实际正文位置。页面保留产品用途、必要图示和使用入口；专题展开细节，不用另一份首页重复维护。历史 Native 指南、技术观察和截图保留各自日期与版本；源码公开不把候选功能变成已上线或已验收能力。部署、发行与源码上传各按实际授权和结果记录。

`publish-manifest.json` 只选择可选本地阅读导出的文件，使用与主仓库相同的路径，不再定义第二个仓库布局。根说明、选定技术许可说明、公众专题与六个实际引用资源为显式来源；不递归复制整个仓库。没有新的 `llms.txt` / `llms-full.txt` 正文生成路径；AI 直接从[阅读入口](ai-reading.md)选择主仓库原文。

需要离线预览或临时阅读包时，可在主仓库运行：

```text
python tools/sync_public_docs.py --output <仓库外的本地预览目录> --dry-run
python tools/sync_public_docs.py --output <仓库外的本地预览目录>
python tools/build_reader_bundle.py --output <仓库外的本地阅读目录>
```

前者按清单导出相同路径的选定文件，未导出的链接指回主库；后者仅生成 `reader-index.md` 和 `reader-bundle.md`，均不是需要提交的第二正文。`--dry-run` 不写入，`--check` 只比较。工具不提交、不上传、不部署；拒绝源／输出越界及符号链接，不递归删除清单外文件。工具检查覆盖主库唯一来源、相同路径导出与不再生成旧 llms 产物的合同。

运行配置、凭据、私钥、用户数据和私人记录不属于文档导出范围。银河自有代码统一按根 [Apache-2.0](../../LICENSE) 提供，归属与例外见 [NOTICE](../../NOTICE) 和 [RIGHTS](../../RIGHTS.md)；第三方原文、用户内容权利及历史已签名 Native 包不因文档整理而重新授权。
