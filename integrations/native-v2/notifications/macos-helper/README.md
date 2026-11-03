# macOS 通知 helper

`GalaxyNotifications.swift` 是现有的本机 `UNUserNotificationCenter` 适配器，运行于 `GalaxyNotifications.app`，通过私有 stdio 与 Go Native 通信；它不是后台服务，也不携带消息正文。通知的授权、系统受理、实际展示与业务已读是不同状态。

在有 macOS SDK 的 Mac 上，可用下面的开发入口构建未签名候选。目标目录必须是尚不存在的绝对路径，且其父目录已存在：

```sh
node integrations/native-v2/notifications/macos-helper/build.mjs /absolute/new/helper-build
```

产物是 `helper-build/GalaxyNotifications.app` 和 `build-report.json`。该入口不签名、不公证、不安装、不启动 App，也不请求系统通知权限。它所写的 `signed: false` 只描述构建步骤结束时的结果；若之后另行签名，应以实际签名检查结果为准，不要把旧 report 当成签名证明。

完整发行包可由 Native 构建入口选择性携带已准备好的 `GalaxyNotifications.app`。同目录的 `stage-bundle.mjs` 提供构建入口调用的 `stageMacOSNotificationBundle({source, destination})`：`source` 是该 `.app` 的绝对路径，`destination` 是新候选包根目录。它复制整个 bundle 的常规文件和资源目录；若存在 `_CodeSignature/CodeResources` 也一并复制。未签名的开发版 App 可选入，签名状态不会据此推断。该函数为每个文件返回候选内相对路径及 SHA-256，并保留 helper 入口的执行权限；安装器据此校验和复制完整候选。源 bundle 与目标候选不能互相包含，符号链接和特殊文件会被明确拒绝。失败时可能留下新候选中的部分文件，不会替换已有 app。

`CodeResources` 存在只是签名资源存在，不证明签名有效、签名主体可信或已经公证。应在 macOS 的发行流程中对最终交付的完整 app 独立核验签名与目标机器可用性；从其他平台复制、交叉构建、文件哈希匹配和安装成功都不等于 macOS 签名或通知验收。签名后不能单独改写、替换或遗漏 bundle 内资源。

当前 Go Native 在 macOS **不会自动选择包内 helper**。如果在明确选择通知功能时使用已安装的 app，需在现有 Native v2 配置中将 `command` 指向实际安装位置的可执行文件，而不是源码目录或候选目录：

```json
{
  "hostNotifications": {
    "kind": "macos-user-notifications",
    "command": "/absolute/installed/release/notifications/GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications"
  }
}
```

上面仅是配置片段；实际绝对路径来自本机已安装的 release，不能照抄。无该配置时不会自动搜索或启用 App。替换 release 后应检查原配置引用是否仍指向可用的已安装版本。复制或配置不会自动请求通知权限；权限只能通过现有明确的权限操作处理，不应把 helper 的 `accepted` 响应说成用户已看到或读过通知。

候选构建可通过 `--macos-notification-app <绝对App路径>` 选择已有 App，开发候选也可使用未签名版本。所有已有资源按字节复制；存在签名资源不等于已完成签名或公证验证。通知命令仍按安装后实际路径配置，不自动请求系统权限。
