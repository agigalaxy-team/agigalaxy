# 主机维护Agent

本目录实现UDS/HMAC私有维护服务、动态备份footprint及恢复适配器。运行入口server.mjs、命令入口manage.mjs，配置以configuration.mjs与configuration.example.json为准。

```text
node packages/galaxy-official/deploy/maintenance-agent/server.mjs --config <保护agent JSON>
node packages/galaxy-official/deploy/maintenance-agent/manage.mjs backup --config <保护agent JSON>
node packages/galaxy-official/deploy/maintenance-agent/manage.mjs resume-writers --config <保护agent JSON>
```

备份/隔离恢复流程见[恢复](../../../../docs/operations/recovery.md)；UDS安装、当前安全态合并、原生Garage/Grafana/Prosody和对象贡献的实现合同统一见[恢复适配](../../../../docs/operations/recovery-adapters.md)。当前配置仅接受production.enabled=false，具体阻断保留在正文。
