# Project、Contact 与长期招募客户端

2026-09-13。延续 M10 的 PRE-M10-01/02、PRE-M10-F01/F02。需求依据及独立验证见[开发记录](../../../../07-logs/development/project-contact-client-v2.md)。

## 网页入口

`packages/galaxy-web/src/project-contact-workspace.tsx` 导出 `ProjectContactWorkspace({runtime,subjectId,connected,navigate})`，独立辅助模块 `project-contact-client.mjs` 复用当前 runtime 的 api、getLocal、putLocal；没有改动 runtime 或新建身份存储。

页面提供找人交流、项目管理、长期招募、联系与回应四个区域，保留发布任务、参与任务及普通聊天入口。临时查询不要求项目或失败 Case。精确机会引用保持服务原样，模型或用户根据真实资料判断；可以单选、多选后分别发送同一份已编辑说明，每个对象独立显示接收、拒绝或结果未知，错误不改写为成功。选择候选不预建房间；只在实际 Contact state=accepted 且服务返回 roomId 后打开双方普通房间。多人共同房间仍走独立成员同意流程，本页不自动拉群。

项目表单支持项目/模块、自报主体类别、功能及技术、可发现声明与本次公开/私有范围；修订保留已有扩展字段，不重写历史 Profile。owner 可授予/撤销编辑或代表、发出/取消管理转交、归档/恢复。Project get/list 追加 current management 投影：owner 可读当前有效角色和未决转交，受让人可见本人待接受事项。私有项目未开放全文时仅返回必要待办；不能因为收到转交就读取全部原始资料。转交接受仍要求原资料当前可读。撤回、原所有者变化、归档或授权失效都重新判断，公开读者不获得角色/转交清单。

招募由真实 owner/representative 选已有项目发布，填写持续角色、功能、条件及1—30天期限。修订、续期、暂停、关闭分别调用真实事件。发布者是本人接触人，不承诺别人代接。关联已有任务先获取当前 Task 版本，再提交 link-task，不创建虚假任务或更改其状态。联系人列表按收到/发出查询，对方亲自接受或拒绝，发起者可撤回尚未接受的请求。

意愿设置支持读取和修改长期目的、显式开关、用户明确选择暂停24小时、取消临时意愿，以及本项目独立覆盖。它们不会自动开启云模型或后台监听；显式长期关闭继续优先。24小时按钮是当前可选界面操作，未改服务允许的实际期限范围。

## 写操作和失败恢复

每次明确动作先构建规范事件，并由 `BrowserClient.authorizePayload` 取得当前本地身份签署的精确 Consent，再提交原业务入口。所有提交表单显式指定 submit 类型，避免依赖 UI Button 的默认类型。

本地账本按服务 runtime 与身份隔离，保留 operationId、对象ID、精确JSON、授权范围和已取得的签名提交。第一次获得明确4xx拒绝时可修订重新提交；网络未知、成功回执丢失或重试后的拒绝仍保留原定位。先GET查询当前对象，再显式重试原operation和已有Consent，不把对象存在或高版本号当作本次操作成功。只有匹配operationId和对象ID的写回执才清除账本。该账本在同一runtime内串行，跨浏览器标签的统一锁和单独操作回执API并未新增；不能据此宣称所有跨端恢复都已验收。

## MCP 接入

`packages/galaxy-official/src/personal-mcp-discovery-v2.mjs` 导出 `discoveryToolDefinitions(services,actor)`，由主代理接入总装。13项工具包含v2发现查询/详情、项目查询/读取/事件/偏好读写、联系人查询/读取/事件、招募查询/读取/事件。读取使用当前授权服务；三类签名事件都接收 `{consentId,payloadJson}`。history scope 只授权操作类别，不能代替精确用户签名；招募关联Task另由服务核对 assistance scope。Galaxy不在MCP端生成用户签名或运行用户模型。

## 部署 Agent 接线与验证

页面建议挂 `/app/projects`，在主导航及发现页增加入口；组件内部导航复用 `/app/tasks/:id` 和 `/app/rooms/:id`。无需新迁移、密钥或第三方账户配置。后端只增加 Project get/list 的只读派生字段，保留旧字段和权限，依赖已经存在的53表及API角色权限。MCP总装 import 上述factory并spread，不替换旧v1工具。

客户端协调器/工具定义的 HTTP、真实本地 OIDC、生产Account及签名Consent综合测试通过；另一个测试覆盖身份变化拒绝重试、重试被拒仍保留旧定位，共2/2。该测试对本机KV与运行时桥接使用注明的替身，不冒充IndexedDB或真实浏览器验收。受影响 Project/Contact 流程在隔离PostgreSQL18.6 galaxy_api角色1/1通过，包含新的管理可见性断言，临时集群 removed:true。独立浏览器bundle构建及新增模块语法检查通过。

主应用路由/MCP总装、真实浏览器点击、跨标签行为和线上部署状态由主代理分别验证。本切片不声明完整M10、通知分发或全部宿主体验完成。
