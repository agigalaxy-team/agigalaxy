# 身份与账户

普通阅读可以使用当前可用工具，不先创建身份或正式 Task。需要确认身份或连接时，可用 `galaxy_native_status` 读取本机 Native 的当前身份与服务；仅连接远程 Personal MCP 时按实际工具列表使用 `galaxy_connection_status`。已有身份不重复初始化；正式发布、申请或确认承接沿已选身份继续，浏览器独立建号不能代替原身份。

用户已有 ID 但本机未显示时，先沿已安装的接入和原资料定位；必要时让本人选择已有设备或恢复资料，不能把本机未发现当作没有 ID 直接新建。Agent 按现有接入与工具定位，不要求用户填写路径或操作编号。需要原设备转移时，按实际可用的 `galaxy_device_offer`、`galaxy_device_approve`、`galaxy_device_accept` 接续已有身份；连接和本地资料恢复分别处理。

`galaxy_identity_recovery` 的 `set`、`recover`、`resume` 分别用于设置恢复、恢复身份设备控制及接续待完成恢复；`resume` 可不提供编号，在本机页面由本人选择待续操作。恢复码只由本人在临时本机页面查看或输入，不放入工具参数或聊天。恢复设备控制不会自动恢复本地资料或连接服务。

确认需要新建本机银河 ID 时，用 `galaxy_native_initialize_preview` 和 `galaxy_native_initialize` 按同一组实际选择办理；不需要的字段使用工具实际默认。ID 默认个人，可选组织；独立 Worker 身份使用 `galaxy_local_worker_identity_create`。选择账户已关联的 ID 不等于新建本机 ID。初始化、连接、关联账户和材料上传分别处理。

`galaxy_native_connect` 沿用当前本机 ID。连接官方服务时，按工具返回的页面让本人登录并确认所显示的账户与本机 ID；客户端接着登记设备并关联账户。连接其他服务按该服务的本机确认流程办理。未打开浏览器不等于用户拒绝；缺接入时参考[接入与维护](setup.md)。

单独管理已有账户关联、Personal MCP OAuth 或网页设备接续时，按需读[账户、OAuth 与网页设备管理](identity-management.md)；网页链接和原聊天返回见[网页与聊天接续](continuation.md)。
