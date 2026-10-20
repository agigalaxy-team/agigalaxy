# 客户端读取与交互模块

这些模块服务网页阅读、宿主面板和原操作接续，按真实使用过程复用；页面继续决定可读内容、授权、草稿及对象选择。

| 职责 | 实现 |
|---|---|
| 读取任务的单飞、取消与旧结果失效 | [read-task.mjs](../integrations/shared/read-task.mjs) |
| React 范围生命周期 | [use-read-task.ts](../packages/galaxy-web/src/use-read-task.ts) |
| 区域等待、慢读及失败操作 | [interaction-feedback.tsx](../packages/galaxy-web/src/interaction-feedback.tsx) |
| 轨道品牌 | [galaxy-mark.tsx](../packages/galaxy-web/src/galaxy-mark.tsx) |
| 原样复制、选区、焦点及静态页接管 | [interaction-copy.mjs](../apps/galaxy-site/interaction-copy.mjs) |

## 读取任务

用当前服务、实际账户或主体及有效会话组成范围。范围变化时释放旧控制器；不同对象不能因显示相同名称而共用读取范围。

控制器以 `lane` 区分正文、列表、回复或账户选项等独立区域，以 `key` 表示该区域内的准确对象、查询及分页位置。同一范围、区域和位置的并发读取共用一个任务；替换该区域读取时，取消旧信号，旧成功、错误与结束回调都不再更新界面。已有接口支持 `signal` 时传入；只支持宿主工具调用的接口仍需按任务有效性处理返回，不宣称所有在途请求均已中断。

`run({lane,key}, read, callbacks)` 的 `read` 接收 `{signal}`，回调为 `onStart/onSuccess/onError/onSettled`。返回结果区分 `success/error/superseded`。取消及离开页面是失效，不显示成用户操作失败。读取可调用 `cancel(lane)` 或释放全部任务；React 使用 `useReadTasks(scopeKey)` 绑定范围和卸载。

正文先按当前许可读取，版本、讨论和其他附属材料分别接续。附属区域失败不清除有效正文；正文权限失效、离线或无法核对时，仍由页面执行原有保护，并保留准确的阅读选择和本地输入供恢复。控制器没有资料缓存或授权策略，也不重放保存、发布、删除或认证动作。

## 等待与失败反馈

`LoadingFeedback` 接收 `active/label/scopeKey`，短读取不显示旋转提示；等待较久时才补充 `detail`。计时随范围和读取结束清理，不把等待时间当作操作失败。反馈出现在当前区域，沿用轨道标志，减少动态偏好下停止旋转。

`ReadFailure` 接收已映射的简短 `message` 和当前读取的 `onRetry`，可由 `retrying` 防止重复重试。页面负责错误含义及原上下文。页面初次读取使用 `PageLoading`；原 `site-shell` 导出保留，现有调用无需另造加载组件。

## 复制与页面接管

`attachCopyTarget({scope,instanceId,trigger,content,onStatus})` 返回 `copy/dispose`。作用域是当前页面，实例标识区分正文中的具体代码块；相同文字的两块内容不会认领彼此的状态。复制内容直接取原样 `textContent`，不裁剪或改换行。

状态为 `idle/copying/copied/selected/manual`，文字映射由 `copyStatusText` 提供。只有实际建立完整选区后才报已选中；等待期间用户已换焦点或选区时，不替他恢复。静态页到 React 的 DOM 替换接续同一文档内最近一次操作，状态不写持久存储。静态页以 module script 加载同一源文件，Web 将其正常打包。

认证表单的等待控制保留在认证脚本内，使用身份提供方原表单动作。离线、等待反馈及页面返回只影响当前显示和重复提交保护，联网不自动重发，也不推断服务端认证结果。

实际接入位置包括账户工作与私有会话、发现介绍、社区正文及附属读取，以及本地履历面板。工程检查仍按[项目工作规则](../../../../02-architecture/current/WORK_RULES.md)集中处理，版本与操作结果见[当前状态](../../../../02-architecture/current/chapters/11-current-state.md)。

