# 威胁模型和攻击入口

保护对象是跨用户共享的 API、数据库容量和连接、当前授权下的数据，以及账户与设备关联的完整性。静态证据只说明所示路径，不能证明整个仓库或部署安全。

```text
匿名调用者
  ├─ POST /v2/search/reference ── 请求校验与 IP 配额 ── 当前可见性判断
  │                                                    └─ 内部分页重复重建语料 → A03
  └─ POST /v2/information/query ── 独立 IP 配额与最多 8 项选择
                                                       └─ Search.Reference → A03
普通官方账户会话
  └─ /v1/account/archives/create 与 chunk
       └─ Cookie / Origin / CSRF / 当前账户 / 单归档上限
            └─ 官方账户未纳入累计预算 → PostgreSQL 持久内容 → A01
有合法范围与签名能力的设备主体
  └─ POST /v2/cases/events ── 自有 case / 当前来源 / 精确同意
       └─ 已存储有限无环来源图
            └─ POST /v2/capsules/preview ── 当前来源权限
                 └─ 重复读取共享子图 → API 与数据库工作量 → A02

条件边界，不是已证实互联网攻击
  受害者接受转交的 IdP 授权 URL → 身份关联同意边界待确认
  已取得受限数据库 SQL 能力 → 条件性函数所有者权限边界
  可达私有 Redis 且允许 Lua → 条件性容器内执行风险
```

## 攻击者权限与真实防护

匿名搜索不等于匿名读取私有数据：被检索语料仍受当前可见性和同意判断限制。A03 利用的是合法可见语料的重复处理成本，不是绕过 ACL。

归档路径需要真实官方账户及正常写保护，拒绝 Bearer 替代；账户 ID 不是任意请求字段决定。设备来源归档还有额外来源主体检查。A01 只描述跨多个归档累计存储的资源边界。

Capsule 预览需要设备控制、case-teaser 与 capsules 范围及有效事件同意；自有 case 可以满足，不需要受害者参与。A02 不是签名绕过，也未证明攻击者可发布一个供匿名用户触发的恶意 Capsule。

管理员页面、私有 AgentOS 服务和受信任构建输入不能自动当作匿名攻击输入。已有静态反证包括受限 HTTPS 获取、固定动态 SQL 表名、附件所有权、私有服务认证、CMS 路径限制及 Web 文本渲染。这些反证只覆盖原记录中的具体调用链，不扩展为全局保证。

入口依据：此次 server 三份候选报告、independent-resource 与 independent-search 报告、auth/attack-notes、web/checkpoint 及差量报告；精确位置见发现页。未绘制已中止 runtime 工作的新增技术链。
