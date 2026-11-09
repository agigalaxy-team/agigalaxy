# 安装与回执

**运行官方安装器。** 已有 `galaxy` 就沿用。首次安装从[发行清单](https://agigalaxy.org/release.json)的 `currentNativeClient.packages` 取当前平台的 `archive` 和 `executable`，[核验](https://agigalaxy.org/downloads/verification/)并解压。执行解压目录根部的 `./galaxy`，Windows 用 `.\galaxy.exe`。

```text
./galaxy setup https://agigalaxy.org --host <当前宿主> --sync-tier N
```

用用户选的编号替换 `N`。补装可沿用原选择。安装器会写入用户目录和当前宿主配置；遇到 `setup_write_permission_required` 时，用宿主支持的单次命令授权重试同一条命令。宿主无单次授权或用户未批准，就报告安装停在哪一步。

用户明确要求离线安装时，只运行这一条：

```text
./galaxy setup --local-only --host <当前宿主> --sync-tier N
```

**回执**

- **安装** · 已装组件、本机身份新建或沿用。
- **接入** · 银河服务、在线账户、MCP 分开报告。账户区分已关联、未关联和未查明。当前聊天调用成功才写 MCP 可用。
- **下一步（按需）** · 仅提示当前可办的事，例如确认未关联时说明关联可使用网页账户收藏，或工作记录需要宿主授权。用户要关联时见[身份与账户](identity.md)。

排版随宿主，省略档位、身份编号和诊断。
