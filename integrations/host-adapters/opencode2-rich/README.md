# OpenCode 2 富交互（可选增强）

OpenCode 2 的 Beta TUI Plugin API 可注册 Slash Command、Dialog 和选择器，因此可作为 `rich-dialog` Renderer 的候选实现。

它不是 Galaxy 的默认安装目标：

- 先读取 Core 的 `GalaxyInitializationContract`；
- 仅在 `richDialog`、`nativeSingleSelect`、`nativeConfirm` 都可用时使用富交互；
- 任何 API、加载或版本检测失败时，立即改用同一 Contract 的 `numbered-list`；
- 不把 Beta 版本、特定渲染库或自定义字符布局写入 Core；
- 仍通过 MCP/Core 的预览与最终确认执行状态变更。

等通用 Contract 的阶段转换、已有 ID 绑定和多级隐私均有可执行语义后，再实现并测试此可选 Renderer。
