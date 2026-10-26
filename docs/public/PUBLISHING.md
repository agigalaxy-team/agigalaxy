# 公开资料维护与本地同步

公众正文位于本目录：本目录顶层保存公开主题，`native-client/<version>/` 保存准确版本指南，`site-files/` 保存公开仓库首页、宣言、支持、许可范围、贡献说明和 Issue/PR 模板，`examples/` 保存合成示例。这里是主源码仓库维护的唯一正文；公开仓库中的对应文件及阅读包是生成镜像。源码仓库自己的首页、工程贡献和许可说明按其源码职责维护，不用公开介绍替代。

`publish-manifest.json` 明确列出每个输入和公开目标；不根据文件夹自动发现或递归复制。现有公共 URL 继续使用公开仓库根目录、`docs/`、`docs/native-client/<version>/` 和 `examples/`。本目录内的链接指向真实正文位置，同步时按清单换成公开布局的相对链接。六个资源由现有 `docs/assets/` 的单文件白名单提供，均有实际引用，不搬动原资源目录。

在主源码仓库根目录运行（Python 3.12+）：

```text
python tools/sync_public_docs.py --output ../agigalaxy-public --dry-run
python tools/sync_public_docs.py --output ../agigalaxy-public
python tools/sync_public_docs.py --output ../agigalaxy-public --check
```

显式输出可为公开仓库的本地克隆，也可为独立的临时预览目录。输出不得是主源码仓库或其祖先、子目录。dry-run 不创建目录或文件；check 仅比较。所有目标在写入前完成路径检查，逐文件在相同目录原子替换并清理临时文件；清单外文件保留，不递归清除。使用者在独立预览目录使用 Git 或文件差异核对新增与变化，再决定是否提交和上传。这些命令没有上传、提交、推送、部署或网络步骤。

需要单独生成可选阅读包时：

```text
python tools/build_reader_bundle.py --output ../agigalaxy-public --dry-run
python tools/build_reader_bundle.py --output ../agigalaxy-public
```

阅读包只从同一 manifest 的选定公开正文生成，`llms-full.txt` 不作为正文回导。公开仓库原来的同名工具只是迁移提示，不再独立维护内容或合并规则。主源码根 `llms.txt` 仅指向源码文档入口，不保留重复的公开全文包。该单独命令仅输出阅读包；完整预览使用同步命令。

同步不读取 `originals/`、产品内部设计、历史讨论、私有记录、运行配置、凭据或项目私人目录。只有 `docs/public/` 明确列出的公开文件与工具内固定六个资源允许成为输入。新增公众资料时同时调整显式清单和它的实际相对链接；不要为方便把整个 `docs/`、根目录或新资源目录加入复制范围。

Native 0.1.16 / 0.1.19、技术核对、许可观察和网站截图保留各自日期与准确版本。指南镜像仅在明确说明的范围做公开整理；不得通过改版本号伪造重新验收。公众状态页不携带内部部署版本表或私有 CI 工作记录。当前服务和最新发行由官网入口查询，本地文档工作不证明运行现状。

最小定向检查：

```text
python -m unittest discover -s test -p test_public_docs_tools.py
```

工具会拒绝越界来源、路径穿越、符号链接／目录联接、清单外相对链接和已知私人路径。测试验证显式公开范围、输出限界、dry-run、幂等和临时文件清理；它不取代人工公开内容审阅或准确版本的产品验证。

主题正文的主要归属：`client-entry.md` 解释使用方式、身份与账户；`getting-started.md` 维护当前安装前提与操作顺序；`vision-and-architecture.md` 解释组成部分与五层职责；`ecosystem-and-hubs.md` 展开 Hub 角色与信息流；`technology.md` 汇总技术依赖；`open-components.md` 维护开放交付与许可边界；`privacy.md` 解释使用者的数据选择与位置边界，`technical-faq.md` 保留带核对日期的精确字段和机制。贡献激励由 `growth-and-contribution.md` 展开，资助与治理由 `community-governance.md` 展开，经济收益与费用由 `business-and-participation.md` 展开。其他页面保留主题必要上下文并直接引用主要正文，随版历史指南保持独立版本合同。
