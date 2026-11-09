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

**回执。** 直接转述安装器的三行结果，不加前言、选择记录或下一步。若当前宿主已有 `galaxy_native_status`，调用成功后把第三行改为「MCP：可用」。工具尚未加载时照抄「已配置，待验证」。本机进程启动与否不能替代回执里的银河服务连接结果。

[其他安装和维护操作](https://agigalaxy.org/docs/galaxy/getting-started/)。
