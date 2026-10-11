# 选择你的 AI 宿主

Native 0.1.10 可以为下列宿主生成接入配置。OpenCode 可从生成的启动器打开；其他宿主在各自设置中合并配置。先按[安装说明](installation.md)取得并核验客户端，再选择你正在使用的宿主。

共享客户端在用户机器运行，云端只提供数据和协作。缺少 elicitation 的宿主使用临时本机浏览器审阅，不假设插件侧栏存在。完整房间打开已实现的官网稳定地址。银河不集中提供用户模型。

## OpenCode：从原工作继续

当前候选增加已安装 OpenCode 的正常入口。核验发行签名、解开独立包并执行 `npm ci --ignore-scripts` 后，运行 `node setup.mjs <已选官网-origin>`。它读取该官网的公开 API 与公钥，选择 OpenCode 后生成新接入目录和 `run-opencode.mjs`；没有找到真实程序时保留明确安装说明，不修改全局配置或模型。资料目录沿用原银河本机目录，生成目录可以接受显示的默认位置。

在原工作目录运行生成的启动命令，输入 `/galaxy`，按“找帮助／发起求助／消息／我的与设置”继续。原本机身份及当前连接已有范围直接沿用；首次真实连接、设备授权或新增范围才作对应选择。当前正文、必要行动与结果分别呈现，内部操作定位留给系统接续。OpenCode 的公开 `client.tui.appendPrompt({text})` 能把所读正文、已发送协助说明和来源追加到原未发送输入，不提交模型；不能假定其他宿主具有相同 API。

从已读求助选择“在官网找相关方法”，会带入当前搜索方向、原求助和返回位置。已有网页设备够用时沿用；缺少方法范围时，正常本机批准页显示所需范围，官网经一次“使用这个设备继续”采用同一身份下获准的新设备。完成后可把当前求助说明、查询方向与网页来源带回原输入。临时页关闭或到期不是批准，也不能用另建身份绕过未完成的原授权。

## 其他宿主：找到接入位置

执行安装工具后，打开生成目录中的 `INSTALL.md`，按所选宿主合并配置。下表说明各自的安装位置；只需处理自己使用的那一项。配置生成已实现，实际宿主验证范围见本页末尾。

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

## 特定宿主的配置与限制

### Claude：桌面与终端配置

Claude 桌面的 Chat 与 Code 需分别标注。当前官方文档说明，本地 Code 会话也加载 claude_desktop_config.json，遇到同名配置有优先级；独立 CLI 不直接读取该文件。生成的 claude-desktop-chat 只是可合并片段，不能把 Chat、Code 和远程会话都标为同一种验收。[桌面说明](https://code.claude.com/docs/en/desktop)

### Claude：需要后台读取时

普通使用直接在现有前台会话调用 Galaxy MCP。需要查看后台 reader 的支持情况时，再使用下面的专业配置。

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

### TRAE：Node 命令位置

TRAE 的 command 字段要求不含空格。生成器为其使用 `node` 命令，须在实际宿主 PATH 中解析到合适 Node；也可传已核对且不含空格的完整路径。带空格的 Windows 安装路径不能直接填入这个字段。[添加 MCP](https://docs.trae.cn/work_remote-mcp-server)

### 嵌入面板与后台能力

客户端的 MCP Apps 小面板已经过浏览器合同检查；Cursor 中的实际呈现、银河侧栏、DSH 浮动窗口和宿主后台运行仍需各自在对应宿主验证。普通 MCP 接入可用时，以宿主显示的内容和生成说明继续，不假定存在尚未验证的侧栏。具体能力登记在随包 `host-capabilities.json`。

## AI Agent 安装和验收

1. 先核验发行签名，在独立包执行 `npm ci --ignore-scripts`，再运行 `node setup.mjs <已选官网-origin>` 读取实际 API 与公钥、生成所选宿主的新接入目录。已知专业配置可单独使用 `prepare-service-config.mjs`；数据目录沿用本人本机资料。工具不会初始化、连接或覆盖原配置，不得把身份私钥、令牌、恢复码或旧 Hermes 资料加入配置。
2. 按生成目录 `INSTALL.md` 接入所选宿主。OpenCode 可从生成启动器直接加载；其他宿主保存或合并配置时保留无关内容。专业调用 `host-configs.mjs` 仍只生成全新目录。若同名旧 MCP 已启用，先明确切换并保留原数据，不启用重复连接。
3. 在实际宿主读取 `galaxy_native_status`，有本机身份时沿用，不重复初始化。原连接选择仍有效时按原设备与原范围恢复，明确断开后不自动连接。OpenCode 的 `/galaxy` 目的菜单提供按需准备与首次连接；本地准备不连接，新增连接选择或范围仍需真实选择。旧 local-only 安装的流程与当前包分开，不将其五阶段菜单作为普通用户必经步骤。
4. 选择一个真实可读 Task、Room、独立 Project 或 Capsule，核对打开网址、对象 ID 与返回后的当前状态；Project 精确入口为 `/app/projects/:id`，已选 Capsule 版本必须保持。旧 Profile 自述不能冒充独立 Project ID。官网未部署相应页面时，登记当前部署差额；实际宿主打开和返回仍各自验收，不沿用早期候选的数量或结果。
5. 需要新范围时审阅所示数据；取消必须没有业务提交。同一未知操作保留原 ID、载荷及 Consent 查询回执，不把刷新网页当再次授权。
6. 持续关注先选当前连接的 Agent grant 和结束条件，宿主按返回 nextCheckAt 调度。模型自行判断处理方式；无新事件不启用模型。处理完成记 Agent 游标，停止后分别确认 Galaxy 检查停止与宿主模型停止。宿主关闭后不可称银河在云端继续。

移除本次安装只移除本次服务器配置与 Skill；本地身份、摘要和原任务不会因此自动删除。停止 stdio 进程会使当前临时审阅页失效。离开房间、撤销设备、删除数据是独立显式业务操作。

## 已验证的范围

2026-10-12 实际安装版本为 OpenCode 1.18.31。本轮隔离进程已从正常包加载 TUI 与 MCP，读取同一服务的当前求助，实际批准并发送协助说明；修正 SDK 接口后，只读原已发送记录并在实际终端核对完整说明、来源以及原未发送输入。服务、身份和工作均为合成，本轮没有使用真实模型，没有改用户原宿主配置，也没有以合同镜像替代实际 TUI。早期发送成功但返回失败、后续探针同屏断言失败均保留；当前通过记录与这些失败分开。其他八端的安装生成、CLI 发现和完整用户操作仍按下述各自证据边界登记。

较早的安装与工具发现检查使用 Codex CLI 0.152.1 的 app-server 和 Claude Code CLI 2.1.266 的 mcp get，在全新隔离配置中实际发起 MCP 初始化及工具发现，Codex 同时发现 Galaxy Skill。这项记录不代表其桌面页面、全部业务或后台循环已通过；其他宿主的生成配置与实际使用仍分别核对。
