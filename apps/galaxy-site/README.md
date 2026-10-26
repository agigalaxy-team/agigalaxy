# 银河官网生成器

product_pages.py/guide_pages.py生成页面和指南，chrome.py提供共享外壳，public_reading.py生成受约束的公开内容树。入口、Web制品配对、缓存、发行参数和CSP见[官网内容树](../../docs/technical/development.md#官网内容树与制品配对)。

从仓库根运行：

```sh
npm run build:site
# 或统一构建：
npm run build
```

Node24.13+、Python3.11+。默认输出apps/galaxy-site/dist；公开历史文件的准确来源/摘要由public-archive.json维护，发行观测由release-data.json维护。固定历史指南/下载保持原字节。
