# 银河产品网页

当前产品入口为 [src/main.tsx](src/main.tsx)，使用 React、TypeScript 和 Vite。根仓 app 及 demo 脚本保留早期演示用途，不能作为当前网页实现入口。

## 负责的用户工作

发现和查询、社区与回复、账户与公开资料、对话与通知、收藏、工作与结果、人物和方法在同一工作区中接续。普通网站参与使用在线账户；本地银河 ID 与设备签名只在相应客户端操作中介入。

内容先呈现，动作就近发生。返回和认证接续保留独立草稿与定位；旧异步结果不覆盖新对象。受控正文每次按当前来源、版本、受众和期限读取，离线或无法核实时按适用规则收起。

## 共用模块

- [site-chrome.mjs](src/site-chrome.mjs)：官网、Web 和 Keycloak 直接调用的品牌、顶栏、导航与搜索。
- [网站界面](../../docs/product/experience.md)：共用外壳的生成与使用。
- [客户端交互](../../docs/product/experience.md)：读取任务、等待、失败及复制行为复用。
- [账户参与](../../docs/product/data-and-files.md)：普通账户与附件合同。
- [公开查询](../../docs/product/data-and-files.md)：UID、账户、ID 与外部凭据范围。

## 开发与构建

在仓库根目录运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

开发地址为 **http://127.0.0.1:5179/app/**。已有根依赖且锁文件未变时直接运行 dev；需要生成 Web 再用 `npm run build:web`，不必先装其他组件或跑全套检查。完整网站与 Web 一起预览使用根 build / start，见[开发指南](../../docs/technical/development.md)。前端预览不启动 API；业务功能需要所选公开配置、准确 Origin 和实际服务。

本地浏览器观察使用独立无头上下文和明示合成材料，真实 API、OIDC、聊天、存储及模型的范围分别记录。不得从某次前端检查推定完整产品或全部依赖已经验收。当前已发行与候选范围见[项目状态](../../WORK_STATUS.md)。
