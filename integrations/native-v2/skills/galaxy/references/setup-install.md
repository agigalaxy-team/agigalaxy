# 安装与回执

**运行官方安装器。** 复用可用客户端，或从[官网下载](https://agigalaxy.org/downloads/)选包并[核验](https://agigalaxy.org/downloads/verification/)。将用户所选编号直接填入 `N`，执行下面这一条。补齐现有接入时省略 `--sync-tier N`。

```text
galaxy setup https://agigalaxy.org --host <当前宿主> --sync-tier N
```

安装器会装齐当前宿主支持的组件。官网和 Skill 可读只说明相应资源可用。MCP 地址及配置由安装器生成。

用户明确要求离线安装时，只运行这一条：

```text
galaxy setup --local-only --host <当前宿主> --sync-tier N
```

**回执**

- **安装** · 已装组件、本机身份新建或沿用。
- **接入** · 银河服务、在线账户、MCP 分开报告。账户区分已关联、未关联和未查明。当前聊天调用成功才写 MCP 可用。
- **下一步（按需）** · 仅提示当前可办的事，例如确认未关联时说明关联可使用网页账户收藏，或工作记录需要宿主授权。用户要关联时见[身份与账户](identity.md)。

排版随宿主，省略档位、身份编号和诊断。
