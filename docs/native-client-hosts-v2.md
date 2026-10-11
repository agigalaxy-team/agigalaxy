# 八个首批客户端的共享接入

核验日期：2026-09-13。采用现行 M15/M16/M17 范围。下表是已实现的安装配置生成与官方格式依据；真实宿主版本、插件加载、打开页面、返回与关闭仍分别登记。除合成协议客户端外，本机 Codex CLI 0.152.1 的 app-server 与 Claude Code CLI 2.1.266 的 mcp get 已在全新隔离配置中实际发起 MCP 初始化及工具发现，Codex 同时发现 Galaxy Skill。没有调用模型、登录或修改原配置。这项 CLI 发现证据不代表桌面 UI、八端全部业务或后台循环通过；具体候选和工具数量保留在对应探针报告中。

共享客户端在用户机器运行，云端只提供数据和协作。缺少 elicitation 的宿主使用临时本机浏览器审阅，不假设插件侧栏存在。完整房间打开已实现的官网稳定地址。银河不集中提供用户模型。

| 产品和本次方式 | 生成内容及安装位置 | 官方依据 |
| --- | --- | --- |
| Claude Code：终端、IDE 聊天、本地 Code 桌面任务 | claude-code 下 .mcp.json 合并到项目；.claude/skills/galaxy 安装到同一项目。 | [MCP](https://code.claude.com/docs/en/mcp)、[Skills](https://code.claude.com/docs/en/skills) |
| GitHub Copilot：本次先覆盖 VS Code Agent 聊天 | .vscode/mcp.json 的 servers.galaxy；.github/skills/galaxy。其他 Copilot 模式不套用此配置形状。 | [IDE MCP](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp)、[Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) |
| Codex：终端、IDE 聊天、本地桌面任务 | 可选生成的完整 galaxy-native-v2 插件，或 config.fragment.toml 加 .agents/skills/galaxy；二者只启用一套。没有修改全局配置或市场。 | [MCP](https://developers.openai.com/codex/mcp)、[Skills](https://developers.openai.com/codex/skills) |
| Cursor：本机 Agent 聊天 | .cursor/mcp.json、.cursor/skills/galaxy；关闭与重启由真实宿主接管。 | [MCP](https://prod.cursor.com/docs/mcp)、[Skills](https://prod.cursor.com/docs/skills) |
| WorkBuddy：桌面连接器 | connector-meta.json、mcp.json、icon.svg、skills/galaxy；本机审阅包使用已安装 Node 和包路径。元数据最低版本 4.24.0。尚未提交市场，不承诺 source 已获注册。 | [连接器](https://open.workbuddy.cn/docs/connector) |
| TRAE / TraeWork：桌面本地任务 | 设置 → MCP → 本地 → 手动配置，使用 mcp.local.json；Skill 为项目 .trae/skills/galaxy。不要选云端运行。 | [运行环境](https://docs.trae.cn/work_mcp-overview)、[添加 MCP](https://docs.trae.cn/work_remote-mcp-server)、[Skills](https://docs.trae.cn/work_skills) |
| Hermes Agent：聊天 | 新生成 config.fragment.yaml 的 mcp_servers.galaxy 合并到本人当前配置；skills/galaxy 按宿主 Skill 安装路径放置。没有读取本机 Hermes 资料。 | [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)、[Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills) |
| DeepSeek Harness：本机 Harness 网页与聊天 | 将 mcp-plugin.fragment.json 作为一项加入实际插件组合；Skill 安装到项目 .dsh/skills/galaxy，复用现有 Skill registry/filesystem/consumer。 | [MCP 插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)、[Skill 文件源](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md) |

Claude 桌面的 Chat 与 Code 需分别标注。当前官方文档说明，本地 Code 会话也加载 claude_desktop_config.json，遇到同名配置有优先级；独立 CLI 不直接读取该文件。生成的 claude-desktop-chat 只是可合并片段，不能把 Chat、Code 和远程会话都标为同一种验收。[桌面说明](https://code.claude.com/docs/en/desktop)

Claude Code 的前台 Skill + MCP 接入与后台 reader 分别核验。2026-10-02 本机 CLI 为 2.1.266；本轮只执行 `--version`、`--help` 和配置来源的本机元数据检查，没有发送真实模型 prompt。正式本机配置已接受 `claude-code`，可在原服务配置中增加以下 `watchHost` 片段。两条路径须替换为本人实际的 Claude 原生可执行文件和已授权工作目录的绝对路径；它不代替宿主连接 Galaxy MCP 的 `.mcp.json`。

```json
{
  "watchHost": {
    "kind": "claude-code",
    "command": "C:\\Tools\\ClaudeCode\\claude.exe",
    "cwd": "C:\\Work\\my-project"
  }
}
```

`galaxy_watch_host_capabilities` 通过这个正式入口查询版本和帮助，不创建模型会话、不启用 Watch。当前会分别说明固定 reader 参数是否有文档依据，以及有效配置是否已确认：`readerProfileDocumented` 可以为 `true`，但 `readerConfigurationConfirmed`、`effectiveManagedPolicyConfirmed` 和 `backgroundReaderSupported` 仍为 `false`。配置不接受额外启动参数、认证环境变量或“已经验证”的布尔声明。

缺少完整有效配置证据时，明确选择 `galaxy_watch_host_activate` 也会返回 `foreground-fallback`，通常原因是 `host_reader_configuration_unconfirmed`；后台模型未启用，模型调用为零。用户仍可在现有 Claude 前台会话使用 Galaxy MCP，读取 `galaxy_watch_check` 返回的授权工作，实际处理完成后再明确 `galaxy_watch_ack`，只更新 Agent 游标。原未知执行通过 `galaxy_watch_host_reconcile` 查询时保持 `unknown`，不会另建会话或重放工作；这也不是原模型已停止的证明。

这个限制来自当前有效配置的证据边界：官方说明 `--restricted` 保留 managed settings，`--safe-mode` 仍可保留 managed hooks、status line 和 file-suggestion commands，managed settings 的优先级高于 `--settings`。本机 managed 文件或注册表键缺席也不能证明远端或动态 policy 缺席。因此，旗标存在、零 turn 握手、工具发现和协议替身测试都不作为后台 reader 已完成的依据；当前正式入口提供诊断和前台回退，Claude 后台持续协作仍待可验证的官方配置能力及真实宿主验收。[CLI 参数](https://code.claude.com/docs/en/cli-reference)、[配置优先级](https://code.claude.com/docs/en/settings)、[managed 来源](https://code.claude.com/docs/en/managed-settings)

TRAE 的 command 字段官方明确要求不含空格。生成器为其单独使用 node 命令，必须在实际宿主 PATH 中解析到合适 Node；也可传已核对且不含空格的完整路径。不要将带空格的 Windows 安装路径强塞进去。此次该页面对普通 User-Agent 返回 400，按网站要求以真实模型名称 User-Agent 读取到 200 的正文，确认其属于 TraeWork 桌面文档。[添加 MCP](https://docs.trae.cn/work_remote-mcp-server)

Cursor 文档列有 elicitation、MCP Apps 等能力；本包未实现、未验证银河侧栏或 MCP Apps 页面。DSH 的浮动窗口和宿主后台运行也是独立后续适配项，不能从“插件能连接 MCP”推导为完成。能力登记使用 host-capabilities.json；目前只直接确认上述两种 CLI 的本机版本，其余端仍待真实宿主验收。

## AI Agent 安装和验收

1. 先确定实际官网与 API，运行 `node prepare-service-config.mjs <官网-origin> <API-origin> <本机数据目录绝对路径> <新的配置文件绝对路径>` 读取官方公开配置并核对当前公钥；数据目录放在本人本机。该工具不会初始化、连接或覆盖原配置。不得把身份私钥、令牌、恢复码或旧 Hermes 资料加入配置。
2. 安装独立包依赖，运行 host-configs.mjs 生成全新配置目录。检查绝对 Node、包路径和公开配置路径属于本机。保存或合并到选定宿主时保留其无关内容；若同名旧 MCP 已启用，先明确切换并保留原数据。
3. 在实际宿主中读取 native_status，再执行原有五阶段 /galaxy 初始化。本地初始化不连接；仅在选择连接后产生绑定。已接续身份不得另生成 GUID。
4. 选择一个真实可读 Task、Room、独立 Project 或 Capsule，核对打开网址、对象 ID 与返回后的当前状态；Project 精确入口为 `/app/projects/:id`，已选 Capsule 版本必须保持。旧 Profile 自述不能冒充独立 Project ID。官网未部署相应页面时，登记当前部署差额；实际宿主打开和返回仍各自验收，不沿用早期候选的数量或结果。
5. 需要新范围时审阅所示数据；取消必须没有业务提交。同一未知操作保留原 ID、载荷及 Consent 查询回执，不把刷新网页当再次授权。
6. 持续关注先选当前连接的 Agent grant 和结束条件，宿主按返回 nextCheckAt 调度。模型自行判断处理方式；无新事件不启用模型。处理完成记 Agent 游标，停止后分别确认 Galaxy 检查停止与宿主模型停止。宿主关闭后不可称银河在云端继续。

移除本次安装只移除本次服务器配置与 Skill；本地身份、摘要和原任务不会因此自动删除。停止 stdio 进程会使当前临时审阅页失效。离开房间、撤销设备、删除数据是独立显式业务操作。
