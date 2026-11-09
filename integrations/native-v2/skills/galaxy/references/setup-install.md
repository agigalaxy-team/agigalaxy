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

**安装完成就回复。** 原样复制安装器输出的三行，结束这一轮。不追加状态检查，不改写「MCP：已配置，待验证」。用户之后询问 MCP 状态时，才从当前宿主调用银河 MCP；终端命令的结果不能说明宿主已经加载它。
