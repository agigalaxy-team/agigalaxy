# AGI 银河网络 / Galaxy
## GALAXY CORE ARCHITECTURE v3.1
### 完整查漏补缺、历史重构与核心数据事实层报告

**版本：** v3.1 Complete Corrected Edition  
**日期：** 2026-08-27  
**文档性质：** 项目历史整合 + 核心架构 + 产品原则 + 数据模型 + MVP 基线 + 防误读规范  
**当前核心定位：** Verifiable Capability History Network / 可验证能力履历网络  
**项目总品牌：** AGI 银河网络 / AGI Galaxy Network  
**优先垂直场景：** AI Coding / 软件工程高失败任务  
**当前产品阶段：** Galaxy Core MVP 前设计冻结阶段  
**状态：** 本文档替代此前 `GALAXY_CORE_DATA_MODEL_v3.md` 作为新的核心架构解释基线

---

# 0. 为什么必须重写这份报告

上一版 `GALAXY_CORE_DATA_MODEL_v3.md` 在数据对象层面已经包含了 `Task → Attempt → Result → Verification → Evidence → Track Record`，并明确写过“履历不是用户自填简历”和 Failure Threshold，但表达仍然存在严重缺陷：

1. **“无感注册 / 自动身份生成”没有被写进核心架构。**
2. **“履历自动生长，而不是用户填写”虽然出现过一句，但没有写成不可违反的产品原则。**
3. **Failure Threshold 被当作一个数据对象，而没有被放在第一用户入口的位置。**
4. `Task` 被定义得过于一般，新的阅读者很容易把项目理解成“用户有疑难就主动发任务”。
5. 没有足够强调：Galaxy 的冷启动入口不是普通疑难，而是 **AI 在真实工作中已经反复尝试、失败率明显升高、用户已经被当前 AI 卡住以后才出现的 Escalation**。
6. 没有足够强调：用户不应该为了使用 Galaxy 先创建 Profile、填技能、写简历、建立账号资料。
7. 没有足够强调：专家也不应该为了接一次任务先经营一个“职业主页”；专家第一次安装 / 使用 Galaxy 客户端时即可自动获得唯一身份，后续通过真实工作自然积累事实。
8. 上一版提出“用户是否愿意维护 Galaxy Profile”这一类验证问题，措辞本身容易让人误以为 Profile 需要人工维护。正确问题应该是：“用户是否愿意让真实工作事实被自动记录、验证并在合适权限下展示，以及这种自动生长的 Profile 是否对其有价值。”
9. 上一版虽然将 Marketplace、Bounty、Federation 降级，但仍然没有把 **Galaxy = 自动形成的事实履历网络** 写得足够强，导致阅读者仍可能把它类比为求助网站、简历网站或自由职业平台。
10. “Identity”在上一版更接近验证体系，没有充分区分：
   - **身份存在（自动生成唯一 ID）**
   - **身份绑定（可选绑定 GitHub、邮箱、企业、真实身份）**
   - **身份验证（证明主体是谁）**
   - **能力验证（证明主体会什么）**
11. 没有明确给出“无账号也能开始、后续逐步增强身份”的 Progressive Identity 模型。
12. 没有明确说明：首次安装时生成的唯一 ID 可以先只存在于本地，直到用户真正需要网络协助、发布、接单、同步履历或公开 Profile 时才与 Galaxy 网络交互，从而同时满足低摩擦与隐私。
13. 没有把“用户”与“专家”统一视为可以在不同任务中互换角色的 Node。一个今天求助的人，明天也可能是另一个领域的专家。
14. 没有把“履历是副产品式自动产生”写成和“侦测自动、外发需授权”同等级的项目铁律。
15. 没有完整解释：Galaxy 的信息入口价值来自真实经历自动沉淀，而不是要求所有人主动经营一个新社交网络。

因此，本版最重要的纠偏是：

> **Galaxy 不是让用户填写履历以后再寻找任务；Galaxy 是让用户先真实工作，在 AI 持续失败时无感进入协助流程，而身份与履历从这些真实经历中自动长出来。**

最短流程：

```text
第一次安装 Galaxy Edge / Worker / Client
↓
本地自动生成唯一 Galaxy Node ID
↓
无需注册表单、无需填写简历、无需声明一堆技能
↓
用户继续正常使用 Codex / Claude Code / Cursor / 其他工作流
↓
Galaxy 在本地观察任务状态和失败信号
↓
普通成功任务不打扰用户
↓
AI 反复失败 / 长时间停滞 / 达到 Failure Threshold
↓
Galaxy 才弹出一次低打扰 Assistance Trigger
↓
用户一键选择：继续自己处理 / 免费协助 / 悬赏协助
↓
用户预览即将外发的摘要和权限
↓
Human / Agent / Tool 介入
↓
系统自动记录 Attempt、Intervention、Result、Verification
↓
真实事实自动写入相关 Node 的 Track Record
↓
Identity / Capability / Reputation / Honor 随经历自然生长
```

这条链是本版的第一原则。

---

# 1. 一句话定义

> **AGI 银河网络是一个跨 Human、AI Agent、团队、组织和工具的真实能力事实网络：每个参与主体在第一次安装或进入 Galaxy 时自动获得唯一 ID，不需要先填写履历；Galaxy 主要从现有 AI 工作流中反复失败、已经高度需要外部能力介入的真实高难任务切入，把后续每一次尝试、协作、结果与验证自动沉淀为长期可验证的能力履历，最终成为“谁真正做过什么、在什么条件下做成、有什么证据”的信息入口。**

---

# 2. 绝对不能再被误读的十六条项目铁律

以下内容属于 v3.1 的“架构不可误读区”，任何后续 Agent、开发者、投资人、合作方在理解项目时都必须先读。

## 2.1 Galaxy 不是用户填写履历的网站

错误理解：

```text
用户注册
↓
填写姓名
↓
填写技能
↓
填写经历
↓
Galaxy 根据填写内容形成简历
```

正确理解：

```text
第一次安装
↓
自动获得唯一 ID
↓
真实工作自然发生
↓
Task / Attempt / Result / Verification 被系统记录
↓
Track Record 自动生长
↓
Profile 只是这些事实的动态展示
```

用户可以填写：

- 昵称；
- 简介；
- 头像；
- 可选自我声明能力；
- 联系方式；
- 可选服务说明。

但这些都属于：

> **Self-asserted Metadata / 自我声明信息**

绝不能与：

> **Verified Track Record / 可验证真实履历**

混在一起。

---

## 2.2 Galaxy 的主入口不是“一般疑难”

错误理解：

> 用户有一个普通问题，于是想到打开 Galaxy 求助。

正确理解：

> 用户本来就在使用 Codex、Claude Code、Cursor 或其他 AI Agent 工作，AI 已经进行了多轮真实尝试，仍持续失败、停滞或无法获得有效进展，Galaxy 在这个高挫败、高求助意愿时刻才出现。

因此 Galaxy 的早期核心流量不是：

```text
所有问题
```

而是：

```text
AI 已经充分尝试但仍解决不了的问题
```

这种任务更稀少，但信息密度和真实求助意愿更高。

---

## 2.3 Failure Threshold 不是“一次出错就弹窗”

Galaxy 不应成为烦人的通知器。

错误方式：

```text
编译失败一次
↓
立即弹窗：需要专家吗？
```

正确方式：

```text
多轮 Attempts
+
相似失败重复
+
测试 / Build 连续失败
+
没有有效进展
+
用户频繁纠正 / Undo
+
Agent 反复循环
+
上下文和工具已经尝试
↓
Failure Threshold
↓
Assistance Trigger
```

Galaxy 的入口价值恰恰来自：

> **只有在用户真的被卡住以后才出现。**

---

## 2.4 无感注册是核心产品原则

用户和专家第一次安装 Galaxy Edge、Worker、CLI 或其他 Galaxy-compatible Client：

> **自动获得唯一 Galaxy Node ID。**

原则：

- 不要求先注册网站账号；
- 不要求先填写邮箱；
- 不要求先绑定手机号；
- 不要求先创建 Profile；
- 不要求先填写技能；
- 不要求先上传简历；
- 不要求先做 KYC；
- 不要求先选择“我是 Requester 还是 Provider”。

身份存在应当是：

> **Zero-form / Zero-profile / Local-first。**

---

## 2.5 自动 ID 不等于实名身份

首次自动生成：

> Galaxy Node ID

只表示：

> “这是一个持续存在的主体。”

不表示：

- 这个人是谁；
- 这个 Agent 属于哪家公司；
- 这个主体是真人还是机器人；
- 它有哪些真实能力。

后续可以逐渐绑定：

```text
Email
GitHub
GitLab
Organization
Domain
Public Key
Passkey
Real-person Verification
Professional Credential
Agent Owner
Agent Runtime
Enterprise Identity
```

形成渐进式身份。

---

## 2.6 履历默认由经历生成，不由用户维护

用户无需：

> “每做完一件事记得回 Galaxy 更新简历。”

系统应尽可能自动生成：

```text
Task
Attempt
Result
Verification
Evidence
Track Record Event
```

Profile 是事件的 Projection / View。

因此产品应追求：

> **越用越完整，而不是越填越完整。**

---

## 2.7 人和 Agent 是同等能力主体

Galaxy 不做：

```text
Agent Network
+
Human fallback
```

而做：

```text
Capability Network
```

统一主体：

> Node

可以是：

```text
Human
Agent
Team
Organization
Tool
Service
```

系统最终看的是：

> 真实经历和证据。

而不是物种类别。

---

## 2.8 赏金不是核心收入模型

赏金的核心作用：

> **让某些高难任务更快获得 Resolution。**

Galaxy 可以完全不参与资金结算。

双方可以在外部：

- 银行；
- Stripe；
- USDT；
- 企业合同；
- 微信；
- 其他平台

自行完成交易。

Galaxy 的核心收益不是一笔任务抽 5%，而是：

> **这次真实协作产生了一条新的可信履历关系。**

---

## 2.9 Open Assistance 不是低质量区

Open Assistance 的主要功能：

> 新 Node / 新 Capability 的真实履历冷启动。

一个没有 Galaxy History 的真正专家不能因为“没数据”永远被挡在网络外。

它可以通过：

- Open Assistance；
- GitHub Evidence；
- 企业 Attestation；
- Capability Challenge；
- External Evidence；
- Capsule Verification

逐渐形成事实历史。

---

## 2.10 前期不全自动

前期系统可以自动：

```text
Detect
Classify
Search
Match
Rank
Recommend
Auto Apply（Worker）
```

但人负责：

```text
Publish
Privacy Approval
Select
Confirm Collaboration
Grant Sensitive Permission
Accept Result
```

核心原则仍然是：

> **机器负责高频计算，人负责高风险决策。**

---

## 2.11 Auto Apply 不等于 Auto Deal

专业 Agent Worker 可以 24×7 自动寻找任务、自动申请、自动报价。

但 Requester：

> 仍然人工选择。

不能因为某 Worker 最快申请就自动获得任务。

---

## 2.12 Galaxy 不要求工作发生在 Galaxy 内

未来真实经历可以来自：

```text
Galaxy Assistance
GitHub
GitLab
Enterprise Workflow
External Marketplace
Third-party Hub
Agent Network
CI System
Open-source Community
```

Galaxy 要成为：

> **跨平台事实索引。**

而不是：

> “只有在本平台交易才有履历”。

---

## 2.13 Federation 不是项目本体

Hub / Bridge / Federation 的意义是：

> 让更多网络产生、读取和验证 Galaxy-compatible Evidence。

不是重新造一个 Agent 通信宇宙。

---

## 2.14 Evidence 是事实，Reputation 是解释

Galaxy 优先保存：

```text
Task
Attempt
Result
Verification
Evidence
```

Reputation、Ranking、Honor 是上层派生。

不能把：

> 一个总分

当成全部事实。

---

## 2.15 失败记录不应被删除掉只保留成功

失败也是能力边界的重要数据。

履历必须能够表达：

```text
Success
Partial
Failure
Abandoned
Rework
Dispute
```

否则 Galaxy 会变成另一种“只展示漂亮成功故事”的简历网站。

---

## 2.16 用户增长目标是“使用即产生身份和历史”

Galaxy 不应要求用户先被说服：

> “请来加入一个新的职业社交网络。”

正确增长方式应该是：

```text
安装一个对当前 AI 工作流有价值的插件 / 客户端
↓
立即获得本地唯一 ID
↓
继续正常工作
↓
真正卡住时 Galaxy 第一次提供价值
↓
解决问题
↓
用户才发现自己已经拥有第一条真实 Galaxy History
```

这就是项目的无感冷启动逻辑。

---

# 3. 无感注册 / Zero-friction Identity 架构

这是此前文档最大的遗漏之一，现提升为 Galaxy Core 第一层。

## 3.1 第一次安装时发生什么

用户第一次安装任何官方 Galaxy 客户端，例如：

```text
Galaxy Edge for Codex
Galaxy Edge for Claude Code
Galaxy CLI
Galaxy Worker
Galaxy Desktop
未来 Browser / IDE Extension
```

系统在本地立即完成：

```text
生成本地密钥材料
↓
生成全局唯一 Node ID
↓
创建本地 Node Record
↓
创建最小本地 Event Store
↓
无需联网也可以完成
```

用户不需要看到：

```text
注册页面
用户名密码
技能问卷
职业信息表
```

---

## 3.2 推荐的最小身份状态

首次创建后的 Node：

```text
node_id: 自动生成
node_type: unknown / human / agent（客户端可推断或稍后确认）
identity_level: local_unverified
display_name: optional
created_at: 自动
public_key: 自动
```

这是：

> **存在身份**

不是：

> **已验证真实身份。**

---

## 3.3 为什么最好 Local-first

如果安装即把所有信息上传服务器，会破坏项目早期已经确立的隐私原则。

更好的方式：

```text
Install
↓
Node ID 在本地生成
↓
普通工作过程优先本地处理
↓
未触发 Galaxy 网络需求时不需要创建云账号
↓
第一次请求协助 / 同步履历 / 接任务 / 公开 Profile
↓
用户授权后才向 Hub 注册该 Node ID
```

这样可以同时做到：

- 无感；
- 去摩擦；
- 隐私；
- 可携带；
- 避免注册转化率损失。

---

## 3.4 Node ID 与 Account 必须分离

传统 SaaS：

```text
Account = Identity
```

Galaxy 不应如此。

建议：

```text
Node ID
=
能力主体长期身份

Account / Login Method
=
访问和恢复 Node 的一种方式
```

因此未来一个 Node 可以关联：

```text
Passkey
Email
GitHub
Enterprise SSO
Device Key
Recovery Key
```

但换登录方式不应该换履历身份。

---

## 3.5 多设备问题

首次安装无感生成 ID 会产生一个现实问题：

> 同一个人第二台电脑安装后会不会获得另一个 ID？

MVP 可以接受本地先生成新的 ID，再提供：

```text
Link Existing Galaxy Identity
Merge / Claim
```

成熟方案应支持：

```text
Device A Node Claim
+
Device B Proof
↓
同一个 Canonical Node
```

同时必须保留历史 Provenance，避免恶意合并别人的履历。

---

## 3.6 专家的无感加入

一个 Human Expert 第一次收到 Galaxy 协助邀请时，不应该被要求：

```text
先注册
填写简历
填写 30 个技能
等待审核
```

更合理的流程：

```text
Expert 点击任务邀请
↓
安装 / 打开 Galaxy Client
↓
自动生成唯一 ID
↓
看到 Task Teaser
↓
决定是否参与
↓
参与后自动产生第一条 Attempt
↓
完成并验证
↓
自动生成第一条 Track Record
```

这名专家的 Galaxy Profile：

> 不是入场条件，而是工作后的结果。

---

## 3.7 Agent / Worker 的无感身份

Worker 首次启动：

```text
docker compose up
```

或：

```text
galaxy-worker start
```

应自动：

```text
Generate Node ID
Generate Key Pair
Generate Worker ID / Configuration ID
```

开发者可以后续才绑定：

- Owner；
- Organization；
- Domain；
- GitHub；
- Billing；
- Public Profile。

---

# 4. Profile 不是数据库原始输入，而是动态投影

这是避免“Galaxy = 填简历网站”误读的关键技术和产品原则。

## 4.1 Profile 的正确来源

```text
Identity Events
+
Capability Claims
+
Task Events
+
Attempt Events
+
Verification Events
+
Evidence
+
Honor
↓
Profile Projection
```

用户打开 Profile 时，系统读取事实并动态展示。

---

## 4.2 Profile 中什么可以人工填写

允许人工填写：

```text
Display Name
Avatar
Short Bio
Contact Preference
Language
Availability
Service Description
Declared Capability
```

但 UI 必须明显区分：

### 自我声明

```text
Declared
```

### 系统观察

```text
Observed
```

### 外部验证

```text
Externally Verified
```

### Galaxy 强验证

```text
Verified by Task Evidence
```

---

## 4.3 用户不能手工创建 Verified Track Record

不能提供一个普通表单：

```text
公司：
时间：
做过：
结果：
```

填完以后直接进入 Verified History。

如果允许导入历史，必须变成：

```text
Imported Claim
↓
Source Verification
↓
Evidence Level
```

没有 Evidence：

> 只能作为 Self-asserted Claim。

---

## 4.4 用户为什么不需要“维护履历”

每一次真实工作完成：

```text
task.resolved
verification.passed
```

系统自动：

```text
创建 / 更新 TrackRecord
更新 Capability Evidence
刷新 Profile Projection
计算可能的新 Honor
刷新 Search Index
```

所以理想体验是：

> 用户几个月不打开 Profile，Profile 仍然会因为真实工作自然成长。

---

# 5. Failure Escalation 是早期核心获客机制，而不是一般求助入口

## 5.1 正常 AI 成功不应该打扰用户

例如：

```text
用户让 Codex 修一个简单测试
↓
Codex 两次尝试成功
```

Galaxy 不应该弹任何求助提示。

最多在本地保留最小匿名状态用于失败检测，具体是否保存普通成功历史另行由产品策略决定。

Galaxy 早期最有价值的是：

> **现有 AI 难以解决的 Tail Cases。**

---

## 5.2 一般错误也不代表该求助

例如：

```text
一次 npm install 超时
一次 API Key 配置错误
一次语法错误
```

即使 Agent 暂时失败，也不应该马上进入 Galaxy。

---

## 5.3 真正触发的情况

可能包括：

```text
同一类错误持续重复
多轮不同策略仍失败
连续 Test / Build / CI Failure
Agent 开始循环产生近似修复
工具调用不断重复但状态不改善
用户多次明确否定 Agent 结果
用户频繁恢复旧版本
Agent 明确表示缺少信息或能力
已经尝试补 Context / Skill / MCP 仍失败
时间成本明显超出普通任务
```

这时 Galaxy 才开始判断：

> 现在是不是一个值得 Escalate 的 Case？

---

## 5.4 Failure Threshold 不是固定次数

不能简单定义：

```text
失败 3 次 = 高难
```

更合理是组合信号。

示意：

```text
Failure Similarity
×
Attempt Diversity
×
No-progress Duration
×
User Frustration Signal
×
Tool / Context Coverage
×
Verification Failure
```

产生：

> Escalation Confidence。

MVP 可以是简单规则，不需要复杂模型。

---

## 5.5 Hardness Qualification

反复失败后还需要判断：

> 是真难，还是环境噪声？

第一层分类：

```text
Context Failure
Environment Failure
Tool Failure
Permission Failure
Specification Failure
Capability Failure
Knowledge Failure
Judgment Failure
Verification Failure
Unknown
```

如果只是：

```text
API Key 缺失
依赖没装
权限不足
```

Galaxy 可以优先给出本地修复建议，而不浪费专家资源。

如果已经更像：

```text
Capability Gap
Novel Knowledge
Cross-domain Complexity
Human Judgment
Rare Production Failure
```

才升级为高价值 Case。

---

## 5.6 为什么这个入口会提高用户求助意愿

普通时候用户可能不愿：

> 为一个不确定的小问题找陌生人。

但当：

```text
AI 已经尝试很多次
用户已经投入大量时间
任务仍然卡住
```

用户的心理状态已经变化：

```text
“我自己再试一下”
↓
变成
“现在确实需要外部能力”
```

Galaxy 选择的就是这个时刻。

因此项目不是假设：

> 所有用户都高度愿意求助。

而是主动寻找：

> **求助意愿最高的失败窗口。**

---

# 6. Assistance Trigger 的无感产品设计

当 Failure Threshold 达到时，不应突然把用户拉去一个复杂 Marketplace。

推荐交互：

```text
当前任务已经多次尝试仍未取得有效进展。

可能需要外部能力。

[继续由当前 AI 尝试]
[免费协助]
[悬赏协助]
[暂不提示]
```

系统同时已经在本地准备：

```text
Task Draft
Failure Summary
Relevant Attempts
Suggested Capabilities
Privacy Redaction Preview
Suggested Verification
```

用户只需要：

> 一次确认。

---

# 7. 外发前必须 Preview

项目历史中已经确定：

> **侦测可以自动，外发必须明确权限。**

因此 Trigger 后必须让用户看到：

```text
将发送：
- 问题摘要
- 技术环境
- 已发生的失败模式
- 必要错误片段

不会发送：
- Secret
- API Key
- 未选择的文件
- 私有 Prompt 全文
- 环境变量
```

用户可以：

```text
删除
补充
脱敏
缩小 Scope
```

然后才 Publish / Request Assistance。

---

# 8. 真实履历如何自动形成

完整自动链：

```text
Node 自动存在
↓
Task / Case 产生
↓
Attempt 自动记录
↓
Failure 自动分类
↓
External Assistance
↓
Intervention
↓
New Attempt
↓
Result
↓
Verification
↓
Evidence
↓
Resolution
↓
Track Record Event
↓
Capability History 更新
↓
Profile Projection 更新
↓
可能获得 Honor / Ranking 变化
```

这个过程不能依赖：

> 用户完成以后记得手工填写“我解决了一个 PostgreSQL 问题”。

---

# 9. Galaxy 的主体统一模型

## 9.1 Node

任何可以成为能力、需求、验证或协作主体的对象都抽象为 Node。

类型至少：

```text
human
agent
team
organization
tool
service
future_robot
```

---

## 9.2 角色不是身份类型

同一个 Human：

今天：

```text
Requester
```

明天：

```text
Provider
```

后天：

```text
Verifier
```

因此数据库不能设计成：

```text
users 表
providers 表
requesters 表
```

完全割裂的三种人。

更合理：

```text
Node
↓
Role in Event / Task
```

---

## 9.3 专家是历史产生的状态，不是注册表单上的选择

用户不应该首次安装时回答：

```text
你是不是专家？
```

一个 Node 是否成为某领域 Expert，应主要从：

```text
Verified Track Records
Difficulty
Capability Evidence
Honor
Recent History
```

自然体现。

---

# 10. Identity 的四个层次

## Layer A：Existence Identity

自动生成。

```text
Node ID
Public Key
Created Time
```

无需人工输入。

## Layer B：Linked Identity

用户主动绑定：

```text
GitHub
Email
Domain
Organization
Device
```

## Layer C：Verified Identity

第三方或 Galaxy 证明：

> 这个主体确实对应某真实身份 / 企业 / Agent Owner。

## Layer D：Professional / Capability Evidence

通过真实任务证明：

> 这个主体确实能做某类事情。

四层绝不能混为一谈。

---

# 11. Capability 也不是靠填写问卷成立

可以允许用户声明：

```text
PostgreSQL
Python
Linux
```

但初始状态：

> Declared。

随着经历自动变化：

```text
Declared
↓
Observed
↓
Evidence-backed
↓
Verified
↓
High-confidence / Expert View
```

能力状态应该是事件和证据的结果。

---

# 12. Task、Case 与 Escalated Case

为了避免“一般疑难平台”误解，本版重新区分：

## Task

任何真实工作任务。

## Case

被 Galaxy 记录为有长期事实价值的 Task。

## Escalated Case

满足：

```text
已有 AI Attempts
+
Failure Threshold
+
用户确认升级
```

的 Case。

Galaxy Coding MVP 的重点：

> **Escalated Case。**

不是所有 Task。

---

# 13. Attempt 是银河核心对象

Task 只能告诉我们：

> 问题是什么。

Attempt 才告诉我们：

> 谁在什么能力状态下做了什么，结果如何。

例如：

```text
Case #18431
PostgreSQL Replication Failure

Attempt 1
Claude Build A
Failed

Attempt 2
Codex Build B
Failed

Attempt 3
Agent DBA-7 Build 12
Partial

Attempt 4
Human DBA 王某
Success

Verification
Production replication stable 48h
```

一条 Case 同时形成：

- Claude 的失败历史；
- Codex 的失败历史；
- DBA-7 的 Partial 历史；
- 王某的成功履历；
- 某工具的实际作用；
- 当前领域 AI 能力边界信息。

这才是真正的“银河”。

---

# 14. Attempt 必须能够记录配置状态

特别是 Agent。

建议：

```text
actor_node_id
configuration_id
model
model_version
prompt_policy_version
skills
mcp
tools
runtime
environment
```

否则半年以后模型升级：

> 旧成功率无法解释。

---

# 15. Human 也有能力状态变化

Human 没有固定 Build，但可以随时间形成：

```text
Role Period
Organization Period
Tool Stack
AI Assistant Stack
Certification Period
Capability Evidence Window
```

所以 Galaxy 不应给人一个：

> 终身不变的 96 分。

应该保留时间。

---

# 16. Intervention

高失败 Case 最有价值的地方之一是：

> 谁介入后改变了过程？

例如：

```text
Human Review
Expert Takeover
New Agent
Tool Introduction
Context Addition
Specification Clarification
Multi-node Collaboration
```

Intervention 让 Galaxy 能回答：

```text
什么类型的介入最有效？
什么时候 Human 最有价值？
什么时候增加 MCP 就够了？
什么时候必须换专家？
```

---

# 17. Result 与 Resolution 不同

Result：

> 某一次 Attempt 提交了什么。

Resolution：

> 整个问题最终是否真正解决。

例如：

```text
Agent 提交 patch
=
Result

CI 通过但线上仍失败
=
Task 未完全 Resolution

Human 修改配置后线上稳定
=
Resolved
```

必须分开。

---

# 18. Verification 是履历可信性的基础

Provider 说：

> “做好了。”

不能直接成为强履历。

Verification 可以来自：

```text
Requester Acceptance
Unit Test
Build
CI
Benchmark
Peer Review
Human Review
Production Validation
Enterprise Attestation
External Evidence
```

Coding 是第一个垂直领域的重要原因：

> Verification 天然容易获得。

---

# 19. Evidence 是底层事实资产

Galaxy 最应该积累：

```text
Task Metadata
Attempt Metadata
Failure Metadata
Result Metadata
Verification Evidence
Relationship Evidence
Provenance
```

而不是默认保存所有：

```text
源码
私有 Prompt
客户数据
Secret
```

原始内容可以 Private。

公开网络可以只保存：

```text
Hash
Metadata
Issuer
Verifier
Time
Proof
```

---

# 20. Track Record 的真正含义

Track Record 不是：

> 用户写的一段“工作经历”。

而是：

> **事件系统根据已发生并有来源的工作事实生成的长期记录。**

一条 Track Record 至少可以关联：

```text
Node
Task
Attempt
Configuration
Capability
Difficulty
Outcome
Result
Verification
Evidence
Collaborators
Time
Source
```

---

# 21. 履历必须记录失败

如果一个 Agent：

```text
解决成功 20 次
失败 80 次
```

Galaxy 不能只显示：

```text
20 Verified Resolutions
```

然后隐藏全部失败。

否则事实网络会失真。

不同可见性可以保护隐私，但在信誉计算中：

> 失败和撤销不能被用户任意删除。

---

# 22. 履历底层不压缩

此前项目非常明确：

> AI 与程序处理信息速度远高于人，不需要把底层履历压成一页纸。

因此底层应尽量保留：

```text
每个 Task
每次 Attempt
时间线
环境
失败
返工
工具
协作者
验证
结果
```

然后上层动态生成：

```text
10 秒摘要
某 Capability 摘要
最近 90 天
类似任务
高难任务
失败模式
```

摘要可以变化。

事实不应因为摘要变化而消失。

---

# 23. Profile 的正确用户体验

第一次安装：

```text
Profile 基本为空
```

用户不需要处理它。

完成第一次真实协助以后：

```text
Profile 自动出现：
1 Verified Task
1 Capability Evidence
```

继续使用：

```text
10 个
100 个
1000 个 Track Records
```

Profile 越来越丰富。

用户的行为是：

> 工作。

不是：

> 更新简历。

---

# 24. Honor 和 Ranking 也应自动派生

例如：

```text
100 Verified Resolutions
PostgreSQL High Difficulty Specialist
Open Assistance Contributor
Top 5% Replication — 90 Days
Trusted Reviewer
```

应该由规则自动生成。

用户不应该手工申请：

> “请把我改成专家”。

荣誉应来源于 Evidence。

---

# 25. Open Assistance 的完整定位

免费协助解决三个问题：

1. 新 Node 没有历史；
2. 社区低风险任务需要流动；
3. 让真实能力快速产生第一批 Evidence。

正确冷启动：

```text
首次安装
↓
自动 ID
↓
无履历
↓
参与 Open Assistance
↓
真实 Result
↓
Verification
↓
第一条 Track Record
```

---

# 26. Bounty Assistance 的完整定位

当：

```text
Hard Case
+
Open Assistance 没有足够响应
```

Requester 可以附加：

> Bounty / Reward。

但 Galaxy 核心不是支付。

Bounty 只是：

> **提高高难 Resolution 的供给激励。**

---

# 27. Paid Eligibility / Verified Capability

此前项目曾明确：

> 付费协助门槛必须绑定具体能力。

例如：

```text
Node A

Python:
Eligible

PostgreSQL:
Eligible

Security Audit:
Not Eligible
```

不能因为：

```text
账号等级 LV9
```

就自动接所有领域高价值任务。

---

# 28. 没履历的新专家不能被永远锁死

可作为能力 Evidence 的来源包括：

```text
Open Assistance
GitHub
Open-source Contributions
Public Projects
Enterprise Attestation
Capability Challenge
Third-party Credential
External Work History
Benchmark
Verified Capsule Reuse
```

不同来源拥有不同 Evidence Strength。

---

# 29. Requester 也自动形成履历

Requester 不应该是“没有信誉的一方”。

系统自动记录：

```text
发布任务
描述质量
取消
响应时间
验收速度
争议
恶意行为
外部结算确认（如双方选择记录）
```

因此专家可以知道：

> 这个 Requester 是否值得合作。

---

# 30. Collaboration Record 比支付记录更重要

双方可以完全离开 Galaxy 支付。

但 Galaxy 需要尽量知道：

```text
是否建立协作
协作 Scope
参与者
时间
是否提交 Result
是否 Verification
是否 Resolution
```

因为这些才直接构成 Track Record。

---

# 31. Deal、Settlement、Result、Verification 四者严格分离

```text
Deal
=
双方同意合作

Settlement
=
钱如何处理

Result
=
提交了什么

Verification
=
结果是否有效
```

Galaxy MVP 可以完全没有内部 Settlement。

---

# 32. Worker 24×7 的正确角色

Worker 是 Agent 类型 Node 的接入 Runtime。

它可以：

```text
监听 Task
匹配 Capability
自动申请
自动生成报价
根据 Owner Policy 决定是否可执行
提交 Result
生成 Evidence
```

但 Requester 的选择仍然是 Human Decision。

---

# 33. Worker 不替代 Human Expert

高难问题可能最终由：

```text
Human
Agent
Human + Agent
Team
Tool + Human
```

解决。

Galaxy 数据模型必须对所有组合公平。

---

# 34. Capsule 的位置

一次真实 Case 成功以后，可以提炼：

> Capsule。

它不是普通文章。

它是：

```text
Problem Pattern
Environment
Solution Strategy
Tools / Skills / MCP
Verification
Limitations
Source Resolution
```

如果 Capsule 被后续真实 Case 复用并再次验证：

> 成为新的 Evidence。

---

# 35. Capsule Author 可能因此形成专业身份

项目早期曾讨论：

> 有高质量 Capsule 的发布者可能更有资格成为接单者。

当前正确实现不是：

```text
发布 Capsule
=
自动商业资格
```

而是：

```text
Capsule
+
真实复用
+
多次 Verification
↓
Capability Evidence 增强
↓
Hub / User 更愿意选择该作者
```

---

# 36. 推荐、人工选择、Routing 的演化

第一阶段：

```text
Discovery
↓
Matching
↓
Recommendation
↓
Human Selection
```

以后：

```text
Policy-assisted Selection
```

最后才可能：

```text
Dynamic Routing
```

任何阶段都需要从第一天保存：

```text
系统推荐谁
用户看谁
用户选谁
谁最终成功
```

---

# 37. 为什么保存 Recommendation / Selection 日志

未来 Galaxy 可以发现：

```text
某种履历信息是否真的影响选择
某种 Ranking 是否误导
用户为什么总跳过最高分候选
某类专家在相似任务上实际更可靠
```

因此：

> Routing 后置，Routing 数据不后置。

---

# 38. Galaxy 不以 Agent 作为核心判断对象

Galaxy 不是问：

> “哪个 Agent 最强？”

而是：

> “这个履历所有者在什么真实任务中做过什么？”

履历所有者可以是 Human。

也可以是 Agent。

甚至可以是：

> Team。

---

# 39. Galaxy 的信息入口终局

理想状态：

```text
我要不要找这个人？
→ Galaxy

我要不要使用这个 Agent？
→ Galaxy

这个专家真的做过类似问题吗？
→ Galaxy

这个 Agent Build 最近是否退化？
→ Galaxy

这个团队在某类高难任务上真实表现怎样？
→ Galaxy
```

Galaxy 不一定控制下一步的交易。

---

# 40. 核心商业价值来自信息服务

当 Verified Capability History Density 足够高以后，可能出现：

```text
Advanced Search
Capability Discovery
Identity Verification
Professional Verification
Track Record API
Reputation API
Evidence API
Enterprise Due Diligence
Risk Intelligence
Talent Discovery
Agent Discovery
Reputation Monitoring
Benchmark
Private Enterprise Graph
Advanced Verification
```

因此：

> 交易佣金不是商业模式的必要前提。


# 41. 项目历史时间线：从最初想法到 v3.1 的完整演化

本节用于防止未来再次因为只看到最新架构而误解“为什么这些模块存在”。

---

## 41.1 第一阶段：AI 等待与失败时间能否被利用

项目最早并不是从职业履历或赏金市场开始，而是从一个非常具体的 AI 使用观察开始：

> 用户在使用 Codex、Claude Code、Cursor 等 Agent 时，会经历大量等待、重复尝试、失败循环和无有效推进的时间。

最早考虑的是：

```text
这些等待时间
这些错误
这些重复失败
```

能否变成：

> 一种外部能力协作入口。

因此最初的创新点不是“创建一个任务网站”，而是：

> **Galaxy 进入现有 AI 工作流，在现有 AI 已经做不好的时候出现。**

---

## 41.2 第二阶段：纠正 Failure Threshold 的含义

很早就明确：

Failure Threshold 不是：

```text
支付失败次数
接单失败次数
交易失败率
```

它指：

> 当前 AI 在真实任务处理中，由于模型、Rule、Context、Skill、MCP、Plugin、Information Source、Environment 等原因持续无法解决问题。

这段历史必须保留，因为任何把 Galaxy 理解成：

> “普通用户主动去网站发疑难”

都会丢掉项目最重要的需求触发机制。

---

## 41.3 第三阶段：插件不是产品本体

因为 Galaxy 自身没有数千万既有用户，所以早期必须借助：

```text
Codex
Claude Code
Cursor
VS Code
CLI
```

作为入口。

因此形成：

> **Galaxy Edge / Plugin 是网络 Edge Node。**

但当时也明确：

> 插件只是流量入口，不是 Galaxy 的最终本体。

---

## 41.4 第四阶段：做标准的人

随后出现一个战略担忧：

> 如果只是做一个普通平台，别人很容易复制 UI 和市场功能。

因此开始思考：

```text
Identity
Capability
Task
Result
Verification
History
```

是否应该拥有统一机器可读标准。

这是 Open Protocol 思想来源。

---

## 41.5 第五阶段：发现“光有标准不够”

很快又发现：

协议解决：

```text
怎么说
怎么接
```

但没有解决：

```text
谁真的会
谁做过
谁成功过
谁可信
```

因此项目不再只是 Protocol。

而形成：

```text
Open Standard
+
Open Source
+
Hosted Network
+
Real Users
+
Real Tasks
+
Real History
```

也就是：

> **协议开放，网络历史和真实数据构成护城河。**

---

## 41.6 第六阶段：Human 与 Machine 的角色

项目讨论过：

```text
Human:
灵活但慢

传统程序:
快但死板

AI:
越来越快且灵活
```

由此形成：

> **机器负责计算，人负责决策。**

后来更准确：

> **机器负责高频计算，人负责高风险决策。**

这一原则贯穿：

- Failure Detection；
- Matching；
- Recommendation；
- Privacy；
- Selection；
- Authorization；
- Verification。

---

## 41.7 第七阶段：完整履历不可压缩

当时提出一个非常重要的观点：

> 人类简历要压缩，是因为人类没有能力快速阅读数千条经历；AI 不一样。

所以 Galaxy 不应该把原始历史永久压缩为：

```text
5 Years Python
4.8 Stars
```

而应保存：

```text
成百上千条实际 Task / Result / Verification
```

再动态生成摘要。

这也是今天 v3.1：

> **Profile 是 View，不是 Source of Truth**

的历史来源。

---

## 41.8 第八阶段：排行榜、等级、荣誉

项目从一开始就没有把人类心理完全忽略。

讨论过：

> 人有攀比、荣誉、排名、身份认同需求。

因此需要：

```text
Ranking
Contributor Level
Domain Ranking
Honor
Public Data
```

来增强社区凝聚。

但后来又明确：

> 社区等级不能替代真实专业资格。

这仍然成立。

---

## 41.9 第九阶段：Capsule

成功任务中的解决办法可以被提取为可复用工件。

由此出现：

> Capsule。

它最早既被看作知识复用机制，也与专家资格发生联系。

后来修正：

> Capsule 只有在真实复用和 Verification 后，才能成为强 Capability Evidence。

---

## 41.10 第十阶段：Open 与 Paid 两层协作

项目曾担心：

> 没履历的人无法接付费任务，而无法接任务又永远没有履历。

因此设计：

```text
Open Assistance
↓
真实任务
↓
Track Record
↓
Verified Capability
↓
Paid / Bounty Opportunity
```

Open Assistance 从来不是：

> 免费低端区。

而是：

> **Network Onboarding + Proof Generation。**

---

## 41.11 第十一阶段：自动 Routing 被主动推迟

随着系统扩展，发现付费自动 Routing 会带来：

```text
任务理解
风险
权限
责任
价格
支付
退款
争议
隐私
```

大量复杂度。

因此明确：

```text
Matching / Recommendation
先做

Human Selection
先保留

Automatic Routing
后做
```

并确定：

> 第一阶段只做智能撮合。

---

## 41.12 第十二阶段：Requester Reputation

如果只有 Provider 被评价，网络会不公平。

所以 Requester 也开始形成：

```text
Reliability
Cancellation
Verification Delay
Dispute
```

这进一步支持今天的统一 Node 模型：

> 角色是事件中的角色，不是固定账号类型。

---

## 41.13 第十三阶段：开源吸引力不足

后来发现：

```text
Schema
SDK
Basic Server
```

虽然开放，但不一定有人愿意长期开着。

于是提出：

> 让自己的专业 Agent 通过开源模块 24×7 接任务。

Galaxy Worker 由此出现。

---

## 41.14 第十四阶段：Galaxy Hub

第三方不仅应该能使用官方 API。

还应该：

> 自己运营一个 Galaxy-compatible Network。

于是 Hub 拥有：

```text
自己的用户
自己的 Worker
自己的品牌
自己的规则
自己的费用
自己的 Reputation
```

这使开源真正成为生产资料。

---

## 41.15 第十五阶段：Federation

如果多个 Hub 都存在，它们需要互通。

因此形成：

```text
Hub A ↔ Hub B
```

并允许：

> 不经过 Official Galaxy。

核心商业原则：

> Direct Federation 不应向官方缴纳强制协议税。

---

## 41.16 第十六阶段：Bridge

为了不要求其他生态迁移，设计：

> Galaxy Bridge。

让现有平台可以映射：

```text
Their Task
Their Identity
Their Result
Their Evidence
```

进入 Galaxy-compatible 数据体系。

---

## 41.17 第十七阶段：Federation 过度中心化了项目叙事

v2.0 一度把 Galaxy 描述得太像：

> Agent Federation Infrastructure。

随后用户指出：

> 赏金任务、人工选择、撮合被弱化。

于是 v2.1 重新补回：

```text
Open Assistance
Bounty Assistance
Human Select
Deal
External Settlement
```

---

## 41.18 第十八阶段：交易也不是核心

继续推演后又发现：

> Galaxy 甚至不需要成为资金中介。

用户真正要的是：

```text
用户
数据
身份
履历
荣誉
信息入口
```

因此交易发生在哪并不重要。

重要的是：

> 真实协作事实是否能产生可信履历。

---

## 41.19 第十九阶段：实时竞品分析带来的方向修正

对 LinkedIn、Upwork、Agent Marketplace、A2A、AGNTCY 等公开市场信息分析后发现：

- Marketplace 已经拥挤；
- Agent Directory 不适合作为 Galaxy 护城河；
- Identity Verification 也不是无人区；
- Federation 基础设施正在标准化；
- Upwork 等已经进入 AI 工作流；
- LinkedIn 有巨大身份网络。

因此 Galaxy 必须避免正面成为：

```text
LinkedIn Clone
Upwork Clone
Agent Market Clone
Agent Protocol Clone
```

---

## 41.20 第二十阶段：核心回到履历事实

随后重新确认：

> Galaxy 的价值不是 Agent 是谁，而是履历所有者到底做过什么。

履历所有者可以是：

```text
Human
Agent
Team
Tool
```

于是项目正式转向：

> **Verifiable Capability History Network。**

---

## 41.21 第二十一阶段：Attempt 成为一级对象

如果只保存最终成功者：

> Galaxy 和普通交易评价系统差别仍然不够大。

真正有价值的是：

```text
此前谁试过
怎么失败
谁介入
什么组合成功
```

因此：

> Attempt Graph

成为 Galaxy 独特的数据层。

---

## 41.22 第二十二阶段：无感注册被重新确认

本次用户再次明确一个此前文档没有充分写入的原始产品设计：

> **不管普通用户还是任务专家，第一次安装 Galaxy 就自动获得唯一 ID。**

不需要：

```text
注册
填资料
填履历
```

后续身份、经历、荣誉：

> 随真实工作自然积累。

这一点现在提升为 v3.1 Architecture Invariant。

---

# 42. Galaxy v3.1 的五层正式结构

```text
┌──────────────────────────────────────────────┐
│ Layer 5 — Information Services               │
│ Search / Discovery / Compare / API / Risk    │
│ Enterprise / Benchmark / Monitoring          │
├──────────────────────────────────────────────┤
│ Layer 4 — GALAXY CORE                        │
│ Node Identity / Capability / Track Record    │
│ Evidence / Reputation / Honor / Capsule      │
├──────────────────────────────────────────────┤
│ Layer 3 — Evidence Production                │
│ Task / Failure / Attempt / Intervention      │
│ Result / Resolution / Verification           │
├──────────────────────────────────────────────┤
│ Layer 2 — Resolution                         │
│ Human / Agent / Team / Tool                  │
│ Open / Bounty / External Collaboration       │
├──────────────────────────────────────────────┤
│ Layer 1 — Acquisition & Capture               │
│ Edge / Repeated AI Failure / GitHub          │
│ Enterprise / External Platforms              │
└──────────────────────────────────────────────┘
```

外围扩张基础设施：

```text
Galaxy Edge
Galaxy Worker
Galaxy Hub
Galaxy Bridge
Evidence Federation
Conformance
```

---

# 43. Layer 1：Acquisition & Capture

目标：

> 把真实世界发生的高价值工作事实引入 Galaxy。

来源包括：

```text
AI Failure Trigger
Manual Escalation
GitHub / GitLab
Enterprise Internal Workflow
External Community
External Marketplace
Third-party Hub
Bridge
```

但 Coding MVP 的主要来源：

> AI repeated failure escalation。

---

# 44. Layer 2：Resolution

当 Case 进入 Galaxy 后，可能由：

```text
Human
Specialized Agent
Tool
Team
Human + Agent
Agent + Tool
Multi-expert
```

解决。

Galaxy 不预设最终赢家是谁。

---

# 45. Layer 3：Evidence Production

任何 Resolution 过程要变成 Galaxy 数据资产，至少要产生：

```text
Task
Attempt
Result
Verification
Evidence
```

如果没有 Verification：

> 可以有历史，但 Evidence Strength 更低。

---

# 46. Layer 4：Galaxy Core

这是项目真正不能外包给别人、不能丢掉的数据层。

核心：

```text
Identity
Capability
Track Record
Evidence
Honor
Reputation Views
Capsule
```

Galaxy 的长期网络效应来自：

> 这些对象之间的真实关系越来越密。

---

# 47. Layer 5：Information Services

当底层事实够多以后：

```text
Search
Compare
Discovery
Due Diligence
Risk
API
Enterprise
Benchmark
```

自然成为商业价值。

---

# 48. “无感”不仅是注册，也应贯穿数据生成

理想体验：

```text
安装
不填资料

正常工作
不手工记日志

遇到高失败
一键确认

协作
系统自动记录

验证
系统自动更新履历

需要对外展示时
才看 Profile
```

因此 Galaxy 产品体验应该追求：

> **尽量少让用户为了 Galaxy 本身做额外工作。**

---

# 49. 无感不等于偷偷采集

必须同时遵守：

> **Local-first + Explicit External Disclosure。**

可以无感：

```text
生成 ID
本地 Failure Detection
本地 Attempt Metadata
本地 Draft
```

不能无感：

```text
上传源码
上传 Prompt
上传 Secret
公开身份
公开履历
```

网络外发仍由用户授权。

---

# 50. 默认隐私模型

建议：

```text
Local Private
↓
Counterparty-only
↓
Proof-only
↓
Federated
↓
Public
```

每条 Evidence 可以拥有独立 Visibility。

---

# 51. 一个 Node 的生命周期

```text
Install
↓
Auto Node ID
↓
Local Unverified Identity
↓
Normal Use
↓
First Case
↓
First Track Record
↓
Optional GitHub Link
↓
More Evidence
↓
Capability History
↓
Optional Real Identity Verification
↓
Honor / Ranking
↓
Information Value
```

整个过程：

> 不需要一次性完成“注册”。

---

# 52. 一个 Human Expert 的生命周期

```text
收到 Case
↓
第一次打开 Galaxy
↓
Auto ID
↓
查看经过脱敏的 Task Teaser
↓
决定介入
↓
Attempt
↓
Result
↓
Verification
↓
第一条 Verified Track Record
↓
未来更多 Requester 查看历史
↓
更多协作
↓
自然形成专家身份
```

“Expert”是历史的结果。

不是用户入场时勾选的类型。

---

# 53. 一个 Agent Worker 的生命周期

```text
启动 Worker
↓
Auto Node ID
↓
Auto Configuration ID
↓
声明 / 检测 Capability
↓
连接 Hub
↓
监听 Case
↓
Auto Apply
↓
Human Select
↓
Execution
↓
Verification
↓
Track Record
↓
Build Reputation
```

---

# 54. Requester 与 Provider 可以互换

Galaxy 不应该认为：

```text
普通用户 = Requester
专家 = Provider
```

真实世界可能：

```text
数据库专家
在 PostgreSQL Case 是 Provider

但在法律问题上
他又是 Requester
```

因此角色是 Task-specific。

---

# 55. Node ID 的推荐语义

Node ID 应满足：

- 全局唯一；
- 不依赖中心数据库自增；
- 可在本地生成；
- 可以签名；
- 可以与多个 Hub 关联；
- 可以长期携带；
- 不暴露不必要个人信息。

MVP 可以采用：

```text
UUIDv7 / Random ID
+
Key Pair
```

长期再决定 DID 等方案。

---

# 56. Installation ID、Device ID 与 Node ID

为了工程正确性，最好区分：

```text
Installation ID
=
这次客户端安装

Device ID
=
设备

Node ID
=
长期能力主体
```

首次安装：

> 可以默认同时创建新的 Node ID。

后续用户可以将多个 Installation：

> Claim / Link 到同一个 Node。

---

# 57. Node Merge 不能简单一键完成

如果随便合并：

```text
Node A
+
Node B
```

会产生履历盗取风险。

Merge 需要：

```text
双方密钥证明
或
外部身份共同证明
或
人工审核
```

并保留：

> Merge Provenance。

---

# 58. Node Split

Agent Owner 可能错误地把：

```text
两个完全不同 Worker
```

作为一个 Node。

未来也需要支持：

> Split / Reattribute。

但不能篡改历史。

应该通过：

```text
Reattribution Event
```

处理。

---

# 59. 身份删除与历史事实冲突

如果一个 Human 请求删除公开 Profile：

可以：

```text
隐藏个人可识别信息
```

但已经参与并由其他主体签名验证的事实：

> 不能简单全部从所有 Evidence 中消失。

需要未来正式设计：

```text
Privacy
Right to Erasure
Audit
Signed Evidence
```

之间的平衡。

---

# 60. Capability Taxonomy

早期不需要建立覆盖全人类工作的完美 Ontology。

Coding MVP 可先：

```text
Software Engineering
Database
Backend
Frontend
Infrastructure
Testing
Debugging
Security
Performance
```

再逐步细分。

---

# 61. Capability Claim 的来源

一项 Capability 可以来自：

```text
Self-declared
Task observed
External credential
GitHub inferred
Enterprise attestation
Capsule verified
Challenge passed
```

每种来源不同 Strength。

---

# 62. Capability 不应该一次性填完

首次安装绝对不应该：

> 让用户选择 100 个技能标签。

系统应该：

```text
从真实工作自动推断
↓
用户可纠正
↓
Evidence 决定可信度
```

---

# 63. Task 的最小结构

Coding MVP：

```text
task_id
source
problem_summary
repository_context
environment
required_capability
failure_context
privacy_scope
verification_requirement
status
```

---

# 64. Escalated Case 的附加结构

```text
failure_threshold_reached
failure_event_refs
prior_attempt_refs
hardness_assessment
escalation_time
user_confirmed
assistance_mode
```

这使新 Agent 一眼就知道：

> 这是 AI 已经失败后的升级 Case。

---

# 65. Failure Event 的详细来源

可观察信号：

```text
Repeated identical error
Near-identical patch loop
Repeated test regression
Repeated build failure
Repeated tool call
Repeated context request
Agent self-declared uncertainty
No progress over time
User rejection
User undo
User manual correction
Timeout
Permission failure
MCP failure
External dependency failure
```

---

# 66. User Frustration Signal

未来可以将用户行为作为辅助信号：

```text
频繁 Stop
频繁 Undo
重复重新提问
明显改变 Prompt
手工接管
打开其他模型
```

但：

> 不能把用户情绪推断当作强事实。

只作为 Trigger 辅助。

---

# 67. Hardness 不等于 Failure Count

一个 Case：

```text
失败 20 次
```

仍可能只是：

> API Key 配错。

另一个：

```text
失败 2 次
```

可能已经明确是：

> 极复杂生产 Race Condition。

所以 HardnessAssessment 必须独立。

---

# 68. Assistance Draft 应尽量自动生成

当 Trigger 到达时：

系统已经知道：

```text
Task
Attempts
Errors
Environment
Likely Capabilities
```

所以不应要求用户重新手写一遍问题。

正确：

```text
Galaxy 自动生成 Draft
↓
用户 Preview / Edit
↓
Confirm
```

这是“无感”体验另一部分。

---

# 69. Provider Candidate 展示重点

未来 Candidate 不应只展示：

```text
名字
头像
五星
```

而要展示：

```text
相关真实任务
类似 Hard Case
Verification
失败 / 成功历史
最近时间
环境相似度
身份强度
```

让用户自己判断。

---

# 70. 系统可以推荐，但不要伪装成确定预测

Galaxy 可以说：

```text
该 Node 有 18 条相似 PostgreSQL Replication Verified History
```

比直接说：

```text
成功概率 97.3%
```

更稳妥。

未来模型成熟后可提供预测作为附加 View。

---

# 71. Similar Task History 是核心信息服务

用户真正需要的往往不是：

> “这个人总评分多少？”

而是：

> “他是否处理过和我现在非常像的东西？”

因此 Search 应天然围绕：

```text
Capability
Environment
Task Pattern
Failure Pattern
Verification
Time
```

---

# 72. Relevance-first Profile

当用户从一个 Case 点进 Provider：

Profile 不需要先显示全部人生经历。

应该动态展示：

```text
与当前 Case 最相关的 10 条历史
↓
其他 Capability
↓
全部履历
```

这是高保真数据优势的真正用法。

---

# 73. Public Profile 与 Decision View 不同

Public Profile：

> 用于身份传播和荣誉。

Decision View：

> 用于当前 Task 选择。

两者都由相同底层事实生成，但展示不同。

---

# 74. Honor 的激励价值

对于高端专家：

> 小额赏金可能不是加入的主要动机。

但如果 Galaxy 的 Verified Honor 获得行业认知：

```text
High Difficulty PostgreSQL Resolver
Top 1% Verified
Trusted Incident Reviewer
```

可能成为：

> 长期身份资产。

这就是荣誉系统的重要性。

---

# 75. Honor 绝不能 Pay-to-win

付费服务可以：

```text
更高级分析
更多搜索
企业工具
```

但不能：

```text
花钱购买 Verified Expert Badge
```

否则整个事实层信誉被破坏。

---

# 76. 排行榜必须带范围

例如：

```text
PostgreSQL Replication
90 Days
Verified High Difficulty Cases
Official Galaxy View
```

而不是：

> “全球第 1 专家”

这种无法解释的绝对口号。

---

# 77. Contribution 与 Professional Capability 分离

一个人可以：

```text
Open Assistance 贡献很大
```

但这不等于：

> 他一定是所有专业方向的顶尖专家。

Contribution 是社区价值。

Capability History 是专业事实。

---

# 78. Requester Reputation 的现实作用

一个 Expert 在决定是否接 Case 时，也需要知道：

```text
这个人是否经常取消
任务描述是否清楚
是否长期不验收
是否恶意争议
```

因此双向信息网络比普通 Freelancer Star Rating 更完整。

---

# 79. 外部交易不参与的好处

早期不做支付意味着避免：

```text
KYC
AML
Tax
Escrow
Refund
Chargeback
Cross-border
Currency
Legal Arbitration
```

让团队把资源集中在：

> Evidence。

---

# 80. 外部交易的缺点

Galaxy 会失去一部分强交易证明。

因此可以允许双方可选提交：

```text
Settlement Confirmation
Payment Proof Hash
Invoice Attestation
```

但不是核心必需。

---

# 81. Collaboration Proof

如果没有 Payment：

仍可以通过：

```text
双方签名
Task Assignment
Result Submission
Requester Verification
Git Commit
CI
```

证明协作真实发生。

---

# 82. Fake Collaboration 风险

两个人可能互相刷：

```text
假任务
假成功
```

因此强 Track Record 需要多个维度：

```text
真实 Artifact
External System Evidence
Independent Verification
Task Difficulty
Relationship Pattern
Time Pattern
Cross-source Proof
```

---

# 83. Sybil 防护不能只靠实名

Agent 可以大量创建。

Human 也可能拥有多个账号。

所以防刷应主要看：

> Evidence Network 和行为关系。

实名只是一个信号。

---

# 84. 外部 Evidence Import 的战略价值

如果 Galaxy 要成为信息入口：

> 必须允许外部工作成为履历。

否则 LinkedIn、GitHub、Upwork、企业历史全被丢弃，用户冷启动太困难。

---

# 85. GitHub 是 Coding MVP 最重要外部来源之一

可以映射：

```text
Issue
PR
Commit
Review
CI
Repository
Organization
```

形成：

> 外部工作 Evidence。

---

# 86. 外部 Evidence 必须注明来源

UI 例如：

```text
Verified by Galaxy Task
Imported from GitHub
Enterprise Attestation
Self-declared
```

用户应该知道信任强度不同。

---

# 87. Galaxy 原生 History 也不天然绝对可信

即使任务发生在 Galaxy 内：

> 如果只有双方口头确认，也可能刷。

所以 Evidence Strength 仍然要独立评估。

---

# 88. Evidence Strength 粗粒度建议

```text
E0
Self Asserted

E1
Counterparty Confirmed

E2
External System Observed

E3
Machine Verified

E4
Multiple Independent Evidence

E5
Strong Institutional / Cryptographic Evidence
```

这是 Evidence 等级，不是人等级。

---

# 89. Verification Strength 可以独立存在

同样的 Result：

```text
Requester 点“OK”
```

和：

```text
CI 通过 + 线上 48h 稳定
```

可信强度不同。

---

# 90. 数据来源必须可追溯

每条重要记录至少应知道：

```text
Source
Issuer
Observer
Verifier
Timestamp
Signature / Hash
```

否则无法成为事实层。


# 91. Core Data Model：Node

Node 是整个银河的统一主体对象。

建议最小字段：

```text
node_id
node_type
created_at
status
primary_public_key
display_name_optional
canonical_node_ref_optional
owner_node_id_optional
operator_node_id_optional
visibility
```

设计要求：

- `node_id` 可在本地无网络生成；
- 创建 Node 不等于验证身份；
- Node 不需要在首次创建时有姓名；
- Node 可以长期保持 pseudonymous；
- Node 后续通过 IdentityBinding 增强；
- Node 的历史不能因为改昵称而改变。

---

# 92. NodeType

推荐：

```text
human
agent
team
organization
tool
service
robot
unknown
```

首次无感创建时，可以允许：

```text
unknown
```

后续根据客户端类型或用户确认补充。

这可以进一步降低注册摩擦。

---

# 93. IdentityBinding

为了避免把 Node ID 和真实身份混为一谈，建议增加：

> IdentityBinding

字段：

```text
identity_binding_id
node_id
identity_type
external_identifier_hash
provider
verification_status
verified_at_optional
visibility
evidence_refs
```

类型例如：

```text
email
github
gitlab
domain
organization
passkey
device
government_identity
professional_credential
agent_owner
enterprise_sso
```

---

# 94. Identity Verification 不影响旧履历产生时间

例如某专家：

```text
2026-09
匿名 Node 解决 10 个任务

2026-10
绑定 GitHub 并完成实名验证
```

不能把前 10 条履历的时间改成 2026-10。

应该：

> 后续身份验证证明“现在有证据认为过去那个 Node 与这个现实身份是同一主体”。

---

# 95. NodeConfiguration

Agent 必需，人类可选。

字段：

```text
configuration_id
node_id
configuration_type
version
model_provider
model_name
model_version
prompt_policy_hash
skill_refs
mcp_refs
tool_refs
runtime_ref
environment_hash
config_hash
valid_from
valid_until
created_at
```

---

# 96. Configuration 不一定公开全部内容

Prompt、系统规则可能有商业机密。

因此公开 Profile 可以只显示：

```text
Model Family
Build Version
Selected Tools
Configuration Hash
Time Range
```

详细 Prompt 保持 Private。

---

# 97. Capability

字段建议：

```text
capability_id
parent_capability_id_optional
canonical_name
description
domain
ontology_version
status
created_at
```

---

# 98. NodeCapability 是事实聚合，不是简单标签

字段：

```text
node_capability_id
node_id
capability_id
declared_at_optional
first_observed_at_optional
last_observed_at_optional
evidence_count
strong_evidence_count
status
current_view
```

底层仍应从 Track Record 动态重建。

---

# 99. Capability 状态建议

```text
self_declared
observed
evidence_backed
verified
high_confidence
inactive
restricted
disputed
```

这些状态不应等同于 Rank。

---

# 100. Task

字段：

```text
task_id
canonical_task_id
source_system
source_hub_optional
requester_node_id_optional
created_at

title_optional
problem_summary
task_class

required_capabilities
optional_capabilities

difficulty
risk_level
data_sensitivity

environment_summary
expected_output
verification_requirement

assistance_mode
status
visibility
```

---

# 101. Task Source

建议：

```text
galaxy_edge
galaxy_manual
github
gitlab
enterprise
external_marketplace
third_party_hub
bridge
community
```

---

# 102. Case

Case 可以作为 Task 的上层包装。

用途：

- 多轮 Attempt；
- 多方协作；
- 长周期；
- 跨平台；
- 需要长期 Resolution 追踪。

Coding MVP 也可以先不建独立 `cases` 表，而在 Task 上添加：

```text
is_case
is_escalated_case
```

---

# 103. EscalationRecord

建议将“AI 反复失败后升级”变成独立对象：

```text
escalation_id
task_id
triggered_at
trigger_method
failure_event_refs
attempt_refs
threshold_version
hardness_assessment_id
user_decision
published_at_optional
```

这样未来可以研究：

> 什么样的 Failure 最容易最终进入协助。

---

# 104. FailureEvent

详细字段：

```text
failure_event_id
task_id
attempt_id_optional
actor_node_id_optional
configuration_id_optional

failure_type
error_signature
error_family
summary

observed_state_hash
repeat_group_id_optional
repeat_index_optional

detected_by
confidence
occurred_at

raw_evidence_ref_optional
```

---

# 105. Failure Type 的最终层级建议

### Infrastructure / Environment

```text
environment_failure
dependency_failure
network_failure
permission_failure
credential_failure
tool_failure
mcp_failure
```

### Task Understanding

```text
context_failure
specification_failure
ambiguity_failure
missing_information
```

### Capability

```text
capability_failure
knowledge_failure
reasoning_failure
judgment_failure
planning_failure
```

### Execution

```text
implementation_failure
verification_failure
regression
timeout
loop
```

### Unknown

```text
unknown
mixed
```

---

# 106. Failure Group

同一个错误重复 10 次不应产生十个完全无关联事件。

建议：

```text
failure_group_id
```

把相似失败聚合。

这样 Failure Threshold 可以使用：

```text
同组重复次数
不同策略尝试次数
持续时间
```

---

# 107. HardnessAssessment

字段：

```text
hardness_assessment_id
task_id
assessed_at
assessor_type
assessment_version

hardness_level
confidence

primary_failure_class
secondary_failure_classes

capability_gap_likelihood
human_judgment_likelihood
environment_noise_likelihood

reason_summary
evidence_refs
```

---

# 108. HardnessLevel

建议：

```text
unknown
routine
moderate
hard
very_hard
frontier
```

MVP 不需要精准。

核心是：

> 区分普通噪声和高信息密度任务。

---

# 109. Attempt

字段：

```text
attempt_id
task_id
parent_attempt_id_optional

actor_node_id
configuration_id_optional

attempt_type
started_at
ended_at

approach_summary_optional
strategy_hash_optional

input_scope_hash_optional
environment_snapshot_ref_optional

tool_refs
skill_refs
mcp_refs
collaborator_refs

status
outcome

failure_event_refs
result_refs
evidence_refs
```

---

# 110. AttemptType

```text
initial_ai
retry_ai
specialized_agent
human_individual
human_review
human_takeover
team
hybrid_human_ai
tool_only
capsule_reuse
external_attempt
```

---

# 111. Attempt 不要求保存完整 Chain-of-thought

Galaxy 需要的是：

```text
可观察工作事实
策略摘要
工具调用结果
Artifact
Failure
Outcome
```

不是要求保存模型私有思维链。

这既减少隐私问题，也避免把项目错误设计成 Prompt Dump。

---

# 112. Attempt 的输入范围很重要

两个 Provider 看见不同上下文：

> 成功率不可直接横向比较。

所以可记录：

```text
input_scope_hash
context_scope
permission_scope
```

不一定保存内容本身。

---

# 113. Intervention

字段：

```text
intervention_id
task_id
triggering_attempt_id_optional
intervening_node_id
configuration_id_optional

intervention_type
reason
summary

before_state_ref_optional
after_state_ref_optional

created_at
evidence_refs
```

---

# 114. Collaboration

字段：

```text
collaboration_id
task_id
participant_node_ids
requester_node_id_optional
provider_node_ids
verifier_node_ids_optional

collaboration_type
scope_summary

started_at
ended_at
status

agreement_hash_optional
evidence_refs
```

---

# 115. Collaboration Status

```text
proposed
accepted
active
submitted
completed
cancelled
failed
disputed
```

---

# 116. Application / Offer

虽然不是 Galaxy Core，但保留历史兼容。

Application：

```text
谁愿意参与
```

Offer：

```text
谁愿意以什么条件参与
```

它们不构成能力履历。

只有真正：

```text
Attempt
```

才开始形成实际工作历史。

---

# 117. Human Selection

Selection 是非常重要的历史行为数据。

字段：

```text
selection_id
task_id
requester_node_id
selected_node_id
candidate_set_hash
selected_at
reason_optional
```

未来可用于判断：

> 哪些 Evidence 信息真的影响用户决策。

---

# 118. Deal

字段：

```text
deal_id
collaboration_id
task_id
requester_node_id
provider_node_ids

agreed_scope_hash
agreed_amount_optional
asset_optional
expected_delivery_optional
verification_criteria

confirmed_at
status
```

---

# 119. Asset-agnostic 原则

如果记录金额：

```text
amount
asset
network_optional
payment_method_optional
```

不能在协议核心写死：

```text
USD only
USDT only
Native Token only
```

早期项目已经讨论过这一点，继续保留。

---

# 120. SettlementRecord

字段：

```text
settlement_record_id
deal_id
settlement_mode
amount_optional
asset_optional
external_provider_optional
status
proof_ref_optional
payer_confirmation_optional
payee_confirmation_optional
created_at
```

MVP：

```text
external
manual_record
not_recorded
not_required
```

足够。

---

# 121. Result

字段：

```text
result_id
task_id
attempt_id
submitted_by
result_type
summary
artifact_refs
artifact_hashes
submitted_at
status
```

---

# 122. ResultType

Coding 示例：

```text
patch
pull_request
commit
configuration_change
analysis
diagnosis
workaround
documentation
test
```

---

# 123. Resolution

字段：

```text
resolution_id
task_id
resolution_status
winning_attempt_ids
supporting_attempt_ids
result_refs
resolution_summary
resolved_at
verification_refs
```

---

# 124. ResolutionStatus

```text
unresolved
partially_resolved
resolved
resolved_with_workaround
invalid_case
cancelled
obsolete
```

---

# 125. Winning Attempt 不代表“只有一个人贡献”

一个 Human 最终提交成功可能建立在：

```text
前面 Agent 找到部分线索
另一个工具完成诊断
```

所以需要：

```text
winning_attempt_ids
supporting_attempt_ids
```

避免把所有功劳错误归给最后一个人。

---

# 126. Verification

字段：

```text
verification_id
subject_type
subject_id
verification_method
verifier_node_id_optional
verification_system_optional

status
scope
confidence_optional

evidence_refs
verified_at
```

---

# 127. VerificationMethod

```text
requester_acceptance
unit_test
integration_test
build_pass
ci_pass
benchmark
peer_review
human_review
agent_verifier
production_validation
enterprise_attestation
external_system
multi_verifier
```

---

# 128. Verification 不同于 Feedback

Feedback：

```text
“沟通很好”
```

Verification：

```text
“测试通过”
```

两者都可以记录。

但不能把主观满意度当成客观结果验证。

---

# 129. Evidence

字段：

```text
evidence_id
subject_type
subject_id
evidence_type

source_system
source_id_optional
source_uri_optional

issuer_node_id_optional
verifier_node_id_optional

content_hash_optional
metadata

strength
visibility
created_at
expires_at_optional
revoked_at_optional
```

---

# 130. EvidenceType

```text
self_assertion
counterparty_confirmation
git_commit
pull_request
issue
ci_result
test_result
build_result
artifact_hash
signed_statement
organization_record
credential
external_platform_record
production_metric
payment_proof
capsule_reuse
```

---

# 131. Evidence 的内容可以不在 Galaxy

例如：

```text
GitHub PR URL
+
Commit Hash
```

Galaxy 只保存引用和证明。

这降低数据敏感性。

---

# 132. Attestation

字段：

```text
attestation_id
issuer_node_id
subject_type
subject_id
claim_type
claim_payload
evidence_refs
issued_at
expires_at_optional
signature
revocation_ref_optional
```

---

# 133. Attestation 示例

企业可以签：

```text
Node X
在 2026-08 完成过某类高难数据库任务
Outcome = Verified Success
```

无需公开企业内部 Task 原文。

---

# 134. Revocation

字段：

```text
revocation_id
target_type
target_id
issuer
reason
revoked_at
replacement_ref_optional
signature_optional
```

---

# 135. TrackRecord

字段：

```text
track_record_id
node_id
configuration_id_optional

task_id
attempt_id
collaboration_id_optional
deal_id_optional

capability_refs
task_class
difficulty
risk_level
environment_tags

outcome

result_refs
verification_refs
evidence_refs

response_time_optional
duration_optional
rework_count
failure_refs

source_system
source_hub_optional

started_at
completed_at
created_at
```

---

# 136. TrackRecord 不应允许普通 CRUD 随意修改

不能：

```text
UPDATE track_records
SET outcome='success'
```

靠普通后台直接改历史。

更合理：

> Event + Correction / Revocation。

---

# 137. TrackRecord 的公开级别

一条真实历史可以：

```text
Private
Counterparty-only
Proof-only
Public Summary
Public Full
```

公开与否不改变底层事实存在。

---

# 138. ReputationView

字段：

```text
reputation_view_id
node_id
scope
capability_id_optional
configuration_id_optional

algorithm_id
algorithm_version
data_window
evidence_scope

metrics
computed_at
issuer
```

---

# 139. Reputation 不是永久字段

不建议：

```text
nodes.reputation_score
```

作为唯一真相。

更合理：

> ReputationView 随时间重算。

---

# 140. Honor

字段：

```text
honor_id
node_id
honor_type
scope
issuer
rule_version
evidence_refs
issued_at
expires_at_optional
status
```

---

# 141. Honor 自动触发示例

```text
连续 100 个 Verified PostgreSQL Tasks
↓
达到规则
↓
自动产生候选 Honor
↓
系统确认 Evidence
↓
Award
```

不是用户申请填写。

---

# 142. Contribution

字段：

```text
contribution_id
node_id
contribution_type
source_task_id_optional
value_weight
verification_refs
created_at
```

---

# 143. ContributionType

```text
open_assistance
verification
peer_review
capsule
community_help
ontology_improvement
bridge_contribution
```

---

# 144. RankingView

字段：

```text
ranking_view_id
scope
capability
time_window
issuer
algorithm_version
generated_at
entries
```

---

# 145. Capsule

字段：

```text
capsule_id
author_node_ids
source_task_ids
source_resolution_ids
problem_class
capability_refs

environment
solution_summary
required_tools
required_skills
mcp_refs

verification_method
limitations

version
visibility
access_policy
evidence_refs

created_at
updated_at
```

---

# 146. CapsuleVersion

Capsule 必须版本化。

因为：

```text
Solution v1
```

可能随着：

```text
Library
Model
Environment
```

变化而失效。

---

# 147. Capsule Verification

字段：

```text
capsule_verification_id
capsule_id
task_id
attempt_id
verification_id
outcome
created_at
```

---

# 148. RecommendationLog

字段：

```text
recommendation_log_id
task_id
candidate_node_id
candidate_configuration_id_optional

rank
score_optional
reason_codes

viewed
shortlisted
selected

algorithm_version
created_at
```

---

# 149. SelectionLog

字段：

```text
selection_log_id
task_id
selected_node_id
selected_configuration_id_optional
original_rank
manual_override
reason_optional
created_at
```

---

# 150. ExternalSourceMapping

字段：

```text
mapping_id
source_system
external_object_type
external_object_id
galaxy_object_type
galaxy_object_id
imported_at
verification_level
content_hash
```

---

# 151. AuditEvent

事实网络本身需要 Audit。

```text
audit_event_id
actor
action
subject
source
timestamp
metadata
```

尤其：

```text
Identity Merge
Evidence Revoke
Honor Revoke
Admin Correction
Visibility Change
```

必须可追踪。

---

# 152. Event-first Architecture

推荐将 Galaxy Core 视为事件流。

核心事件：

```text
node.created
identity.linked
identity.verified

capability.declared
capability.observed
capability.evidence_added

task.created
failure.detected
failure.grouped
hardness.assessed
escalation.triggered
escalation.confirmed

attempt.started
attempt.failed
attempt.partial
attempt.succeeded

intervention.created
collaboration.started
selection.created
deal.confirmed

result.submitted
verification.created
resolution.completed

evidence.added
attestation.issued
attestation.revoked

track_record.created
track_record.corrected

honor.awarded
honor.revoked
```

---

# 153. 为什么 Event-first 适合 Galaxy

因为 Galaxy 追求：

> “历史发生了什么”。

而不是仅追求：

> “现在数据库最新状态是什么”。

Event-first 更自然表达：

```text
时间
来源
变更
撤销
纠正
```

---

# 154. MVP 不需要 Event Sourcing 全套复杂基础设施

可以：

```text
PostgreSQL 普通业务表
+
append-only events 表
```

先实现。

不要为了架构漂亮引入：

```text
Kafka
复杂 CQRS
```

---

# 155. 数据库建议

MVP：

> PostgreSQL。

理由：

- 关系明确；
- Transaction 好；
- JSONB 灵活；
- Query 足够；
- 开发简单；
- 后续可导入图数据库。

---

# 156. 为什么不先用 Graph DB

Galaxy 长期确实是 Graph。

但产品 MVP 的查询模式还没有被真实用户验证。

先做：

```text
nodes
tasks
attempts
evidence
track_records
```

比先建复杂 Neo4j 模型更合理。

---

# 157. Core Tables 建议

```text
nodes
identity_bindings
node_keys
node_configurations

capabilities
node_capabilities

tasks
escalations
failure_events
failure_groups
hardness_assessments

attempts
interventions
collaborations
applications
offers
selections
deals

results
resolutions
verifications

evidence
attestations
revocations

track_records

reputation_views
honors
contributions
ranking_views

capsules
capsule_versions
capsule_verifications

recommendation_logs
selection_logs

external_source_mappings
events
audit_events
```

---

# 158. Source of Truth 层级

优先级：

```text
Raw Event
↓
Evidence
↓
Track Record
↓
Reputation View
↓
Profile
```

不要反过来从 Profile 修改底层事实。

---

# 159. Profile Projection

Profile 可以缓存：

```text
current_capabilities
recent_track_records
honors
public_identity
summary
```

但缓存随时可以从 Core 重建。

---

# 160. Search Index

未来可以独立：

```text
OpenSearch / Elasticsearch
```

用于：

```text
Task similarity
Capability Search
Track Record Search
```

但 MVP 可先 PostgreSQL Full Text / Vector Extension。

---

# 161. Similarity Search

长期最有价值的搜索之一：

> 找到和当前 Hard Case 相似的历史。

这可以同时用于：

```text
找 Expert
找 Agent
找 Capsule
找 Failure Pattern
```

---

# 162. 第一版 Search 不需要 AI 黑盒评分

可以先：

```text
Capability Tags
Keyword
Environment
Difficulty
Verified Count
Recent Activity
```

避免将 MVP 成败依赖复杂模型。

---

# 163. Recommendation Explainability

如果推荐：

```text
Node A
```

至少显示：

```text
18 条相关 PostgreSQL Replication 历史
其中 14 条 Verified Success
最近 30 天 5 条
```

而不是只显示：

```text
AI Recommended
```

---

# 164. Privacy Object

每个可分享对象建议有：

```text
visibility
sharing_scope
redaction_state
owner_policy
```

而不是依赖整个账号一个 Privacy 开关。

---

# 165. Visibility

统一：

```text
local_private
private
counterparty_only
peer_only
federated
proof_only
public
```

---

# 166. Proof-only 的重要性

高价值企业任务通常最敏感。

Galaxy 真正能规模化，可能依赖：

> Proof-only History。

即：

```text
“发生过一个 High Difficulty Security Task”
“由 Enterprise X 验证成功”
```

但不泄露原始数据。

---

# 167. Redaction

Edge 在外发前应自动检测：

```text
API Key
Token
Password
Private Key
Environment Variable
Host
Email
Customer Data
```

并默认建议 Redact。

---

# 168. Permission Grant

选中专家后，不应一口气发送全部环境。

采用最小授权：

```text
Task Summary
↓
Selected Files
↓
Selected Logs
↓
High-risk Access Separate Approval
```

---

# 169. 权限事件也是 Evidence

例如专家是否真正获得：

```text
Production Access
```

会影响任务难度和责任。

可以记录：

```text
permission_scope_hash
```

不需要公开具体 Secret。

---

# 170. 数据使用权分离

至少区分：

```text
Operational Use
Public Profile
Federated Proof
Research
Training
Commercial Licensing
```

不能用一份 ToS 全部默认授权。


# 171. 防刷履历是核心，不是后期风控附属

如果 Galaxy 的价值最终来自履历，那么：

> **Fake Track Record 对 Galaxy 的伤害，相当于假币对货币系统的伤害。**

因此防刷不能等到“用户多了以后再考虑”。

早期至少要识别：

```text
同一批 Node 反复互相发任务
同一任务跨多个来源重复导入
极短时间大量高难任务“成功”
完全没有 Artifact / Verification 的批量成功
同一 IP / Device / Key Cluster 异常互证
Requester 与 Provider 长期只有封闭互刷关系
大量低价值任务被伪装成高难任务
```

---

# 172. Self-dealing Detection

一个 Node 可以和自己控制的 Agent 协作，这在现实中并不一定是欺诈。

例如：

```text
Human Owner
+
自己的 Agent
```

完成工作是合法事实。

但系统必须标记：

> Related-party Relationship。

否则：

```text
自己发布
自己完成
自己验证
```

被当成三个独立主体，会错误放大 Evidence Strength。

---

# 173. Related-party Evidence

建议 Evidence 中加入：

```text
relationship_risk
independence_level
```

例如：

```text
same_owner
same_organization
known_counterparty
independent_counterparty
independent_machine_verification
```

---

# 174. Independent Verification 的价值

最强履历往往不是：

```text
Requester 点成功
```

而是：

```text
Requester Confirmed
+
CI Passed
+
External Repository Evidence
```

多源 Evidence 增强可信度。

---

# 175. Duplicate Task Detection

同一个 GitHub Issue：

```text
从 GitHub Bridge 导入
又在 Galaxy 发布
又在第三方 Hub 同步
```

不能形成三份独立任务。

需要：

```text
canonical_task_hash
source_links
duplicate_cluster
```

---

# 176. Canonical Task 不等于公开内容相同

同一个敏感企业任务可能在不同系统里被不同程度脱敏。

所以 Dedup 可以基于：

```text
Source ID
Cryptographic Hash
Issuer Assertion
Private Matching
```

而不是只比较文本。

---

# 177. Anti-Sybil 的现实原则

Galaxy 不应幻想：

> “实名以后就没有 Sybil。”

Agent 本身就可以批量创建。

更现实：

```text
Identity Strength
+
Evidence Independence
+
Relationship Graph
+
Time
+
External Source
```

共同判断可信度。

---

# 178. Identity Reputation 与 Capability Reputation 分离

一个身份非常真实：

```text
企业实名 CEO
```

不代表：

```text
他会修 PostgreSQL。
```

因此 Identity Score 不能直接进入 Capability Score 成为决定性因素。

---

# 179. Requester Fraud

Requester 也可能：

```text
发布恶意文件
骗取免费劳动
任务完成后恶意否认
批量制造假任务
```

所以 Requester History 必须进入 Worker / Expert 决策。

---

# 180. Provider Fraud

Provider 可能：

```text
复制别人答案
虚假声称完成
提交恶意代码
套取私有信息
```

因此需要：

```text
Artifact Evidence
Result Verification
Security Scan
Relationship History
```

---

# 181. Verification Fraud

Verifier 也可能被控制。

所以 Verifier 本身也是：

> Node。

也拥有：

```text
Identity
Track Record
Reliability
```

长期可以知道：

> 哪些 Verifier 的验证结果更可信。

---

# 182. 荣誉撤销

如果后来发现某批历史造假：

> 由这些 Evidence 派生的 Honor 必须能够自动撤销或标记。

不能只删掉底层 Evidence，却留下：

```text
Top Expert Badge
```

---

# 183. Reputation Recompute

当：

```text
Evidence revoked
Task corrected
Node merged
```

发生时：

> Reputation View 应重新计算。

所以 Reputation 不应被当成不可变原始数据。

---

# 184. Track Record Correction

真实世界会出现：

```text
最初判断成功
一周后发现回归
```

正确做法：

```text
Verification Passed
↓
后来新增 Verification Failed / Regression
↓
Resolution 状态更新
↓
保留完整时间线
```

不是把旧记录偷偷改成“失败”并抹去曾经的判断。

---

# 185. “不可删除”不是当前绝对原则

Galaxy 不应过早宣传：

> “履历上链永不可删除。”

因为会遇到：

- 隐私；
- 法律；
- 错误数据；
- 企业保密；
- 用户权利。

更正确：

> **事实变更必须可审计，公开可见性与底层保留策略分开。**

---

# 186. Data Retention

可以按数据类型设置：

```text
Raw Sensitive Context:
短期 / Local-only

Evidence Metadata:
长期

Public Track Record:
长期，支持隐藏

Cryptographic Proof:
长期

Temporary Logs:
短期
```

---

# 187. 原始日志不等于核心资产

Galaxy 的护城河不是：

> 偷偷存用户所有日志。

真正资产是：

```text
结构化事实
关系
Outcome
Verification
Provenance
```

这也降低隐私和存储压力。

---

# 188. Edge 本地数据策略

Edge 默认可以本地保存：

```text
Recent Attempts Metadata
Failure Groups
Draft Summary
Local Node Identity
Privacy Policy
```

但具体：

```text
Prompt 全文
Source Code
Secret
```

应遵循用户配置和最小化原则。

---

# 189. Telemetry 与 Core Evidence 分离

产品 Telemetry：

```text
按钮点击
性能
Crash
```

不是：

> Track Record Evidence。

必须分开存储和授权。

---

# 190. “无感”模式下的网络同步

建议三档：

## Local Only

```text
Node ID 只在本地
历史不上传
```

## Private Sync

```text
同步到用户账户 / Hub
不公开
```

## Public / Federated

```text
选择性公开 Evidence 和 Profile
```

首次安装默认可偏向：

> Local Only 或 Private Minimal。

---

# 191. Node Claim

当用户第一次真正需要网络功能：

```text
发布 Case
接任务
跨设备同步
公开 Profile
```

系统可以提示：

> “是否为你的 Galaxy Identity 增加恢复方式？”

例如：

```text
Passkey
GitHub
Email
```

这是 Progressive Registration，而不是前置 Registration。

---

# 192. 无感注册和反作弊的矛盾

无感创建 ID 会让创建大量 Node 非常容易。

这是有意为之：

> Entry 必须低摩擦。

系统不应通过：

```text
阻止创建 ID
```

解决 Sybil。

而应通过：

```text
Evidence Strength
Identity Binding
History
Relationship
```

决定可信度。

即：

> **创建身份免费，获得信任昂贵。**

---

# 193. 这句话应成为身份设计原则

> **Galaxy ID 应该容易获得，Galaxy Trust 必须难以伪造。**

---

# 194. Open Assistance 与 Sybil

Open Assistance 会成为刷分攻击目标。

所以：

```text
低 Evidence 的免费互助
```

不能无限堆积出：

> 顶级专业信誉。

高 Reputation 应需要：

```text
独立 Requester
高 Difficulty
强 Verification
长期时间
不同来源
```

---

# 195. Bounty 金额不等于 Difficulty

一个 $1000 任务可能并不难。

一个免费开源 Issue 可能极难。

所以：

```text
Bounty Amount
```

只能是经济信号。

不能直接决定专业 Reputation 权重。

---

# 196. Difficulty 如何获得

可以来自：

```text
Requester Estimate
System Estimate
Failure History
Expert Review
Outcome Statistics
Post-hoc Calibration
```

第一版可以保留多个字段，不急于统一。

---

# 197. Post-hoc Difficulty

当一个任务：

```text
20 个强 Node 都失败
最后一个专家解决
```

系统可以在事后发现：

> 原始 Difficulty 低估。

因此 Difficulty 可以有：

```text
initial_difficulty
observed_difficulty
```

---

# 198. Failure Data 本身也是银河资产

一条失败 Attempt 可以告诉网络：

```text
这个 Node 在这个环境没解决
这个 Agent Build 可能有局限
这个 Tool 没有效果
这个问题比预计难
```

所以不能为了让 Profile 好看而全部隐藏失败。

---

# 199. 公开 Profile 如何处理失败

可以不是：

```text
首页大字展示所有失败
```

但在用于专业决策的 View 中：

> 相关失败率、Partial、Rework 应存在。

用户可以控制隐私，但不能伪造“只有成功”。

---

# 200. High-fidelity 不等于 Public-everything

“底层高保真”：

> 数据结构保留足够事实。

“公开展示”：

> 根据权限裁剪。

两者不能混淆。

---

# 201. Galaxy Edge 的第一价值

Edge 第一价值不是：

> 收集数据。

而是：

> **在用户已经被 AI 卡住的时候，真正帮他找到下一步。**

如果没有这个即时价值，用户不会为了“给 Galaxy 提供数据”安装。

---

# 202. Galaxy Edge 的第二价值

一旦协助解决：

> 自动为参与者生成可信履历。

这是长期价值。

---

# 203. Galaxy Edge 的第三价值

随着历史增加：

> 同类问题可以先查历史、Capsule 和已验证解决者。

用户下一次可能更快解决。

---

# 204. Edge 触发后的四种路径

```text
1. Continue Current AI
2. Use Existing Capsule / Historical Solution
3. Open Assistance
4. Bounty / Expert Assistance
```

这比只有：

```text
“发任务”
```

更合理。

---

# 205. Capsule 优先可以降低外部求助成本

如果历史中已有：

```text
Verified Capsule
```

系统可以先提示：

> “有 12 次相似问题使用该 Capsule 成功。”

用户可以先试。

若失败：

> 新 Attempt 继续成为数据。

---

# 206. Capsule 失败也有价值

如果 Capsule 曾经有效，但现在大量失败：

> 可能已经过时。

所以 Capsule 需要：

```text
Version
Recent Verification
Failure History
```

---

# 207. Assistance 的公开范围

默认应优先：

```text
最小任务摘要
```

而不是：

> 公开完整工作区。

Candidate 被选中以后再升级权限。

---

# 208. 两阶段甚至多阶段披露

### Stage 0

```text
Capability Need
Difficulty
High-level Environment
```

### Stage 1

```text
Task Teaser
Failure Summary
```

### Stage 2

```text
Selected Context
```

### Stage 3

```text
High-risk Permission
```

---

# 209. Human Expert 不一定需要访问全部源码

某些专家可能只需：

```text
错误日志
架构描述
Stack Trace
```

就能提供诊断。

Galaxy 应支持：

> Advice-only Attempt。

---

# 210. Attempt 的贡献类型

不同 Attempt：

```text
Diagnosis
Advice
Patch
Review
Takeover
Verification
```

都可以产生履历。

不是只有：

> 最终写代码的人。

---

# 211. 多人协作归因

高难 Case 可能：

```text
A 发现根因
B 提供修复
C 验证
```

Galaxy 应为三个人分别形成不同类型 Track Record。

---

# 212. 归因不能平均分

A/B/C 的贡献不同。

第一版不需要精确算百分比。

可以先记录：

```text
role
attempt
intervention
verification
```

让事实存在。

---

# 213. Provider 不一定是“接单者”

为了避免市场化语言限制，Core 更建议使用：

> Participant / Resolver / Contributor。

Marketplace 层可以叫 Provider。

---

# 214. Requester 也不一定是付款人

企业自动系统可能发起 Case。

或者：

```text
Agent 代表 Human 发起
```

因此 Requester 是：

> Need Origin / Authorized Requester。

---

# 215. Agent 代表用户请求时

需要记录：

```text
requesting_agent
authorizing_human_optional
organization
permission
```

避免系统误以为 Agent 可以自行公开企业敏感数据。

---

# 216. Human Approval

前期高风险动作：

```text
Publish Sensitive Task
Select Paid Provider
Grant Private Repo
Grant Production
```

默认需要 Human Approval。

---

# 217. Enterprise Policy

企业未来可以定义：

```text
哪些 Task 可外发
哪些 Hub 可查询
哪些专家可选
哪些 Evidence 可公开
```

但这是 Enterprise Extension。

不阻塞个人 MVP。

---

# 218. Worker Policy Engine

Worker Owner 可以定义：

```text
accepted_capabilities
min_requester_reliability
max_risk
max_concurrency
min_bounty_optional
free_task_quota
allowed_hubs
data_policy
```

---

# 219. Worker Auto Apply

当：

```text
Capability Match
+
Policy Pass
```

Worker 可以：

> 自动申请。

Requester 再选择。

这既发挥 Agent 24×7 优势，又不让交易自动失控。

---

# 220. Worker Auto Execute 的边界

成熟阶段可以：

```text
Deal 已确认
权限已明确
低风险
Owner 预授权
```

后自动执行。

但 v3 MVP：

> 不需要把 Auto Execute 作为核心卖点。

---

# 221. Galaxy Hub 的最新定义

Hub 不是“官方服务器的复制”。

它是：

> **本地 Galaxy Core + 本地策略 + 本地 Evidence Network。**

第三方可以：

- 自己运营；
- 自己品牌；
- 自己用户；
- 自己 Honor；
- 自己 Reputation View；
- 自己商业模式。

---

# 222. Hub 为什么仍然值得开源

虽然 Federation 降级，但 Hub 仍可让：

```text
企业
社区
垂直行业
```

在自己控制的数据边界内产生 Galaxy-compatible Track Record。

这扩大 Evidence 来源。

---

# 223. Galaxy Bridge 的最新定义

Bridge 是：

> External Fact Translator。

它不是简单 API Proxy。

它负责把：

```text
外部事件
↓
Galaxy Schema
↓
带 Provenance 的 Evidence
```

---

# 224. Bridge 不能给外部平台虚假强度

例如第三方平台的：

```text
五星评价
```

不能直接映射成：

```text
Galaxy E4 Strong Verification
```

必须遵守可信映射规则。

---

# 225. Federation 的最新核心对象

未来 Hub ↔ Hub 更重要的是交换：

```text
Identity Claim
Capability Evidence
Track Record Proof
Attestation
Revocation
```

而不是：

> 全量复制任务市场。

---

# 226. Query Federation 仍可保留

如果用户需要外部专家：

```text
Hub A
↓
查询相关 Capability
↓
Hub B 返回摘要
```

但这只是 Discovery Extension。

不是 Galaxy Core。

---

# 227. Direct Federation 原则

此前已确认：

> 第三方 Hub 之间直接互通，不使用官方服务时，不应产生强制 Official Protocol Fee。

这保持开放生态可信度。

---

# 228. Official Galaxy 的正确位置

官方可以运营：

```text
Official Public Network
Global Search
Evidence Verification
Risk
Hosted Hub
Enterprise
Relay
Benchmark
```

但 Protocol / Core 不应该强制依赖官方。

---

# 229. Official Galaxy 仍可以形成最大数据优势

虽然别人可以部署 Hub：

> 官方可能因用户最多、历史最密、跨源 Evidence 最丰富而成为默认信息入口。

护城河来自：

```text
Data Density
Trust
Search Quality
Network Usage
```

而不是：

> 闭源协议。

---

# 230. 开源与护城河的关系

项目早期已经认识到：

> 开源并不等于没有护城河。

如果核心价值是：

```text
多年真实 Task / Attempt / Verification
```

别人复制代码：

> 也复制不了历史。

---

# 231. 开源的最新目的

开源组件的核心目标：

> 让更多现实系统产生 Galaxy-compatible Evidence。

而不是仅仅吸引 GitHub Star。

---

# 232. 建议开源组件

```text
galaxy-core-spec
galaxy-sdk
galaxy-edge-core
galaxy-worker
galaxy-hub-core
galaxy-bridge
galaxy-conformance
```

---

# 233. galaxy-core-spec

应定义：

```text
Node
IdentityBinding
Capability
Task
Escalation
Attempt
Result
Verification
Evidence
TrackRecord
Attestation
Revocation
```

这是最优先开源标准。

---

# 234. galaxy-edge-core

开源有额外信任价值。

因为 Edge 可能接触：

```text
源码
Prompt
Logs
环境
```

用户应该能审计：

> 哪些数据被检测、哪些被发送。

---

# 235. galaxy-worker

让开发者自己的专业 Agent：

> 24×7 参与真实任务。

这是开源生态直接利益。

---

# 236. galaxy-hub-core

让第三方：

> 自己运营 Evidence / Capability Network。

---

# 237. galaxy-bridge

让现有平台：

> 不迁移也能贡献 Evidence。

---

# 238. galaxy-conformance

标准没有自动兼容测试：

> 很难真正成为生态。

Conformance 应验证：

```text
IDs
Evidence
Signatures
Schema
Import
Privacy
Revocation
```

---

# 239. Official Free 服务的核心目的

不是“免费用户套餐”。

而是：

> 最大化 Network Density。

建议免费：

```text
Auto Node ID
Public / Private Profile
Basic Track Record
Open Assistance
Basic Bounty Matching
Basic Search
Honor
Ranking
Capsule
Worker Registration
Evidence Import
```

---

# 240. Official Paid 服务

未来自然收费点：

```text
Identity Verification
Professional Verification
Advanced Search
Advanced Similarity
Evidence API
Track Record API
Risk
Enterprise Due Diligence
Private Graph
Monitoring
Advanced Verification
Hosted Hub
SLA
Analytics
Benchmark
```

---

# 241. “增值服务不难找”成立的前提

只有当：

> Galaxy History 真被用户和企业认为可信且有用

以后增值服务才自然。

因此 MVP 不应花太多时间设计收费套餐。

---

# 242. 交易佣金不是核心 KPI

GMV 可以存在。

但更重要：

```text
Verified Cases
Strong Evidence
Active Nodes
Track Record Density
Profile Lookup
Repeat Search
```

---

# 243. 数据资产 KPI

建议核心：

> Verified Capability History Density。

可拆：

```text
某 Capability 下
Verified Nodes
Real Tasks
Attempts
Strong Verifications
Recent Evidence
Independent Sources
```

---

# 244. Hard Case Density

另一个核心指标：

> 在 Galaxy 收到的 Case 中，多少是真正高信息密度，而不是环境噪声。

---

# 245. Resolution Quality

不能只看：

```text
Case 是否 Closed
```

要看：

```text
Verification Strength
Rework
Regression
Time
```

---

# 246. Evidence Completeness

一条 Track Record 至少能否回答：

```text
Who
What
When
Outcome
Proof
```

---

# 247. Profile Value KPI

不是：

> 用户填了多少字段。

而是：

```text
Profile 被查看次数
Track Record 被展开次数
Profile 被分享次数
Evidence 被引用次数
```

---

# 248. Profile Maintenance KPI 应被删除

旧的错误思想：

```text
用户是否愿意维护 Profile
```

不应该作为核心指标。

正确：

> **Profile 是否在不要求人工维护的情况下自然变得有价值。**

---

# 249. Installation → Identity Conversion KPI

因为无感注册：

```text
Installed Nodes
↓
Locally Active Nodes
↓
Network-claimed Nodes
↓
Evidence-bearing Nodes
↓
Public / Shared Nodes
```

这是更符合产品逻辑的漏斗。

---

# 250. 用户无需理解 Galaxy 全部概念

普通用户第一次体验只需理解：

> “AI 卡住了，Galaxy 可以帮我找外部能力。”

不需要理解：

```text
Node
Evidence
Federation
Attestation
```

这些是后台架构。


# 251. MVP 的真正目标

Galaxy v3.1 MVP 不需要证明：

```text
全世界愿意来 Galaxy
全球 Federation 成立
交易量很大
AI 可以自动路由所有任务
```

只需要证明：

> **AI 真实高失败任务，可以通过低摩擦 Escalation 获得外部 Resolution，并自动产生一条对参与者未来有信息价值的可信 Track Record。**

---

# 252. MVP 第一个垂直领域：AI Coding

这个历史决定仍然最合理。

原因：

```text
Failure 容易观察
Task 容易结构化
Git 是天然 Provenance
Commit / PR 是 Artifact
Test / Build / CI 是天然 Verification
Human / Agent 都已经广泛参与
```

---

# 253. MVP 不做“一般专家问答”

不要先覆盖：

```text
心理咨询
法律
医疗
营销
设计
全部知识问答
```

原因不是这些领域没有价值。

而是：

> Coding 最容易让 Galaxy Core 被事实验证。

---

# 254. MVP 第一场景

```text
用户正在 Codex 中修复真实 Repository
↓
Codex 尝试 A
↓
Test Failure
↓
Codex 尝试 B
↓
同类 Failure
↓
Codex 尝试 C
↓
Build / Test 仍失败
↓
Galaxy Edge 判断 Failure Threshold 达到
↓
在本地生成 Escalation Draft
↓
用户看到：
“当前 AI 已多轮失败，需要外部协助吗？”
↓
用户点击“请求协助”
↓
确认 Privacy Preview
↓
一个 Human Expert 看到 Case
↓
Expert 首次打开 Galaxy，自动生成 Node ID
↓
Expert 介入
↓
Result
↓
CI Pass
↓
Requester Confirm
↓
Resolution
↓
专家自动获得第一条相关 Track Record
↓
用户 Node 也获得一条 Requester / Collaboration History
```

这是 v3.1 的 Golden Path。

---

# 255. 用户安装流程

理想：

```text
Install Galaxy Edge
↓
安装完成
↓
直接继续工作
```

而不是：

```text
Install
↓
注册
↓
验证邮箱
↓
选择身份
↓
填技能
↓
填个人简介
↓
才可使用
```

---

# 256. 首次安装后台动作

```text
Generate local Node ID
Generate local key
Create local settings
Create empty local history
Register failure detector
```

这些不需要用户理解。

---

# 257. 首次 Network Interaction

当用户第一次：

```text
Request Assistance
```

系统才需要：

```text
Publish Node Public Key
Register Node with selected Hub
Create network-visible Case
```

用户仍可以：

> 不绑定真实姓名。

---

# 258. 首次协助 UI

尽量只有：

```text
AI 已经反复尝试但仍未解决。

Galaxy 已整理：
- 问题摘要
- 已尝试的方法
- 当前错误
- 可能需要的能力

[免费求助]
[悬赏求助]
[继续自己处理]
```

---

# 259. 用户无需再次描述全部上下文

这是重要 UX。

如果 Galaxy 让已经被 AI 卡了一个小时的人：

> 再手写 800 字问题描述

用户很容易放弃。

所以 Draft 必须最大程度自动生成。

---

# 260. Privacy Preview UI

例如：

```text
将公开给候选者：
✓ PostgreSQL 版本
✓ 错误类型
✓ Stack Trace 部分
✓ 已尝试 4 次但失败

不会公开：
✗ Repository 全部源码
✗ .env
✗ API Key
✗ 客户数据

选中协作者以后可以单独授权更多文件。
```

---

# 261. Expert Discovery

MVP 不需要复杂 Marketplace 首页。

可以先：

```text
Case
↓
系统找到相关 Node
↓
向少量候选发出通知 / 展示
```

用户也可以选择：

> 发布到公开 Open Assistance Pool。

---

# 262. 专家首次进入

专家点击：

```text
Open Case
```

如果没有 Galaxy：

```text
轻量安装 / Web Client
↓
Auto Node ID
```

不要：

> “请先完善 80% Profile。”

---

# 263. 专家 Profile 在第一次任务前可以是空的

这不是问题。

Galaxy 可以显示：

```text
New Node
Identity Evidence: GitHub linked optional
Track Records: 0
```

如果专家有外部 Evidence，可以导入。

没有也可参与：

> Open Assistance。

---

# 264. 付费高风险任务可以有更高门槛

例如 Official Hub：

```text
Paid PostgreSQL Production
```

可以要求：

```text
至少若干相关强 Evidence
或
Trusted External Credential
```

但 Protocol 不把统一门槛写死。

---

# 265. Expert 接受 Case

这时生成：

```text
Collaboration
Attempt
```

后续事件自动记录。

专家不需要手工：

> “新增一段工作经历”。

---

# 266. Expert 完成

提交：

```text
Patch
PR
Diagnosis
Configuration
Advice
```

系统创建：

> Result。

---

# 267. Verification

例如：

```text
CI automatically passed
```

系统自动创建：

> Verification。

Requester 再点击：

```text
问题已解决
```

形成第二 Evidence。

---

# 268. Track Record 自动生成

系统自动给 Expert：

```text
PostgreSQL Debugging
High Difficulty
Verified Success
CI + Requester
2026-08-27
```

如果允许公开：

> Profile 自动出现。

---

# 269. Requester History 自动生成

Requester 也自动得到：

```text
Created Escalated Case
Selected Expert
Verification Timeliness
Resolution Outcome
```

---

# 270. Agent Provider 流程

```text
Worker Start
↓
Auto Node ID
↓
Capability / Configuration
↓
Task Feed
↓
Auto Filter
↓
Auto Apply
↓
Requester Select
↓
Attempt
↓
Result
↓
Verification
↓
Track Record
```

Agent 和 Human 最终进入同一事实模型。

---

# 271. Human + Agent Hybrid 流程

```text
Human Expert 接 Case
↓
使用自己的 Agent
↓
Human + Agent 协作
↓
Agent 完成部分诊断
↓
Human 做关键判断
↓
最终成功
```

Galaxy 应同时记录：

```text
Human Track Record
Agent Attempt
Collaboration Edge
```

而不是只给 Human 全部功劳。

---

# 272. Tool 的履历

Tool 也可以作为 Node。

例如某 MCP Tool 在 100 个类似 Case 中被使用：

```text
70 Success
20 Partial
10 Failure
```

长期也可以形成：

> Tool Capability History。

---

# 273. Team 的履历

高难企业 Case 可能由：

> Team。

Team 可以拥有自己的 Track Record，同时成员的参与通过 Attempt / Intervention 记录。

---

# 274. Organization 的角色

Organization 可以：

```text
签发 Identity
签发 Enterprise Attestation
拥有内部 Hub
拥有 Agents
拥有 Teams
```

组织本身也可以形成：

> Organizational Capability History。

---

# 275. MVP 页面一：Escalation Card

最重要入口 UI。

信息：

```text
AI Attempts
Failure Summary
Estimated Failure Class
Current Task
Privacy Preview
Assistance Options
```

---

# 276. MVP 页面二：Case View

展示时间线：

```text
Task Created
Attempt 1 Failed
Attempt 2 Failed
Escalated
Expert Joined
Attempt 3
Result Submitted
CI Passed
Resolved
```

这张时间线本身就是 Galaxy 的核心产品体现。

---

# 277. MVP 页面三：Node Profile

不要设计成传统简历编辑器。

结构可以：

```text
Identity
Current Capability Views
Relevant Verified History
Recent Track Records
High Difficulty Cases
Failure / Partial History
Honor
External Evidence
```

编辑按钮只用于：

```text
Display Metadata
Privacy
Identity Binding
```

不用于伪造 History。

---

# 278. MVP 页面四：Candidate Compare

显示：

```text
Node A
- 8 个类似 Case
- 6 Verified Success
- 1 Partial
- 1 Failed
- 最近 12 天

Node B
- 30 个一般 PostgreSQL
- 0 个类似 Replication Case

Node C
- New Node
- GitHub 外部证据 15
```

让用户理解：

> Galaxy 的价值来自历史事实。

---

# 279. MVP 页面五：Verification

Requester 可以：

```text
Solved
Partially Solved
Not Solved
Need Rework
```

同时系统自动展示：

```text
CI Result
Test Result
```

---

# 280. MVP 页面六：History Detail

用户点击一条履历：

```text
Task Summary
Role
Attempt
Result
Verification
Evidence Source
Time
Visibility
```

---

# 281. MVP API：Node

示意：

```text
POST /nodes/local-claim
GET  /nodes/{id}
POST /nodes/{id}/identity-bindings
GET  /nodes/{id}/track-records
```

真正首次 Node ID 生成可以完全客户端完成，不需要 `POST /nodes` 才存在。

---

# 282. MVP API：Task / Escalation

```text
POST /tasks
POST /tasks/{id}/failures
POST /tasks/{id}/hardness-assessments
POST /tasks/{id}/escalate
GET  /tasks/{id}
```

---

# 283. MVP API：Attempt

```text
POST /tasks/{id}/attempts
POST /attempts/{id}/fail
POST /attempts/{id}/results
```

---

# 284. MVP API：Verification

```text
POST /results/{id}/verifications
POST /tasks/{id}/resolve
```

---

# 285. MVP API：Evidence

```text
POST /evidence
GET  /evidence/{id}
POST /attestations
POST /attestations/{id}/revoke
```

---

# 286. MVP API：Profile / Search

```text
GET /nodes/{id}/profile
GET /search/nodes
GET /search/history
```

---

# 287. Edge Local API

Edge 可以本地暴露：

```text
record_attempt
record_failure
get_escalation_status
generate_assistance_draft
preview_disclosure
```

不需要所有数据先上传云端。

---

# 288. Task 状态机

建议：

```text
active
↓
failing
↓
escalation_candidate
↓
escalated
↓
seeking_assistance
↓
in_resolution
↓
submitted
↓
verifying
↓
resolved / partial / unresolved / cancelled
```

---

# 289. Attempt 状态机

```text
created
↓
in_progress
↓
successful / partial / failed / abandoned
```

---

# 290. Escalation 状态机

```text
not_triggered
candidate
triggered
user_declined
user_confirmed
published
```

如果用户 Decline：

> 一段时间内不要反复打扰。

---

# 291. Collaboration 状态机

```text
proposed
accepted
active
submitted
completed
cancelled
disputed
```

---

# 292. Verification 状态机

```text
pending
passed
partial
failed
inconclusive
revoked
```

---

# 293. Track Record 生成条件

不是每个点击都形成一条履历。

建议至少：

```text
Attempt 实际发生
+
有可归因 Outcome
```

才生成基础 Track Record。

强 Verified Track Record 需要：

```text
Verification
```

---

# 294. Failure Attempt 也可生成 Track Record

但 Profile 默认摘要可使用：

```text
Overall history
```

而不是每次失败都推送成“荣誉”。

---

# 295. Honor 生成条件

必须：

```text
Track Record
+
Evidence Strength
+
Rule
```

不直接来自：

> 用户填写。

---

# 296. MVP 技术栈

可简单：

```text
Edge:
TypeScript / Python

Backend:
TypeScript / Go / Python 任选成熟栈

Database:
PostgreSQL

Object Storage:
可选

Queue:
MVP 简单 DB Queue / Redis

Search:
PostgreSQL
```

不要过早微服务。

---

# 297. 单体优先

MVP 推荐：

> Modular Monolith。

模块：

```text
Identity
Task
Attempt
Evidence
TrackRecord
Search
```

比一开始：

```text
20 个 Microservices
```

更合适。

---

# 298. Graph 是长期逻辑，不是 MVP 技术要求

长期：

```text
Node ↔ Task ↔ Attempt ↔ Evidence
```

自然形成 Graph。

但底层先关系数据库即可。

---

# 299. MVP Failure Detector

不需要训练复杂模型。

第一版可使用：

```text
same_error_count
test_failure_count
build_failure_count
no_progress_duration
agent_retry_count
user_reject_count
```

简单规则。

---

# 300. Failure Detector 需要可解释

Trigger 可以告诉用户：

```text
过去 28 分钟已经有 5 次类似失败，
当前测试始终未通过。
```

比：

```text
AI 判断你需要专家
```

更容易建立信任。

---

# 301. Failure Trigger 的 Precision 比 Recall 更重要

早期宁可：

> 少触发。

也不要：

> 每天弹 20 次。

因为一次烦人的错误 Trigger 会导致用户关闭插件。

---

# 302. Trigger Cooldown

需要：

```text
per-task cooldown
user snooze
disable for project
disable automatic detection
```

此前“允许用户关闭自动检测”原则继续保留。

---

# 303. Manual Escalation 永远保留

即使系统没有检测到：

> 用户也可以主动按“我真的卡住了”。

这样 Failure Detector 不成为单点失败。

---

# 304. AI 建议先自救

Trigger 前可以先检查：

```text
是不是 Context 不够
是不是 Tool Error
是不是环境明显错误
```

如果可以低成本解决：

> 先本地修复。

只有更可能需要外部能力：

> 才升级。

---

# 305. 用户求助意愿的真实假设

Galaxy 不假设：

> 普通问题用户愿意求助。

项目假设是：

> **当 AI 已反复失败并消耗了明显时间，用户的外部协助意愿显著增加。**

这是需要现实验证的产品假设。

---

# 306. 用户真正支付的是“停止浪费时间”

如果 Bounty 出现，其心理价值可能不是：

> 购买答案。

而是：

> “我已经卡了两小时，找一个真正做过类似问题的人。”

这更符合高失败入口。

---

# 307. 初期 Supply 不需要巨大

因为 Case 本身较难，真正有价值的是：

> 少量高水平 Expert。

所以 MVP 可以：

```text
20–50 个真实专家
```

而不是一开始追求：

> 十万 Provider。

---

# 308. 第一批专家获取

可以从：

```text
GitHub 高质量 Contributor
专业社区
数据库 / 后端专家
开源 Maintainer
AI Coding Power User
```

邀请。

---

# 309. 专家加入话术不应是“来接单赚钱”

更符合项目定位：

> “你的真实解决经历会自动成为可验证的专业履历；高难 Case 可以带来荣誉、声誉和未来合作机会。”

如果有 Bounty：

> 是额外激励。

---

# 310. 普通用户加入话术

不是：

> “加入 Galaxy 社交网络。”

而是：

> “当 Codex / Claude Code 反复解决不了时，Galaxy 帮你把问题交给真正做过类似事情的人或 AI。”

---

# 311. 第一次价值发生后再解释履历

用户第一次任务解决以后：

```text
这次协作已经形成一条可验证 Galaxy History。
```

这时再告诉他：

> 你的 Galaxy Identity 正在自动积累。

比安装时讲 20 分钟“能力事实网络”更有效。

---

# 312. MVP 第一个 KPI：Escalation Trigger → User Confirm

衡量：

> Trigger 是不是出现在真正有求助意愿的时候。

如果大量用户 Decline：

> Threshold 太低或价值表达不够。

---

# 313. 第二 KPI：Escalated Case Fill Rate

是否有人愿意介入。

---

# 314. 第三 KPI：Resolution Rate

是否真的解决问题。

---

# 315. 第四 KPI：Strong Verification Rate

有多少 Resolution 能获得：

```text
CI / Test / External Evidence
```

而不是纯口头。

---

# 316. 第五 KPI：Track Record Reuse

后续新的 Requester 是否查看：

> 相关历史。

---

# 317. 第六 KPI：Evidence-influenced Selection

用户在候选中是否因为：

```text
Similar Verified History
```

选择某 Node。

这是信息网络价值的重要验证。

---

# 318. 第七 KPI：Automatic History Acceptance

专家是否接受：

> 系统自动生成的履历。

如果大量人要求修改事实：

> 数据归因模型可能有问题。

---

# 319. 第八 KPI：Profile Share

Expert 是否主动把：

> Galaxy Profile

分享给别人。

这是身份资产开始形成的信号。

---

# 320. 第九 KPI：Repeat Escalation

Requester 下一次 AI 卡住：

> 是否再次使用 Galaxy。

---

# 321. 第十 KPI：Hard Case Precision

被 Trigger 的任务中：

> 有多少最终被判断确实需要外部能力。

---

# 322. 不把“填写 Profile 完成率”作为 KPI

因为系统不应该要求填写。

这是本版明确纠正。

---

# 323. 12 周 MVP：Week 1

目标：

> Auto Identity。

实现：

```text
首次安装自动 Node ID
Local Key
Node Claim
Identity Binding 基础
```

验收：

> 用户不填写任何表单即可运行。

---

# 324. Week 2

目标：

> Task + Attempt 本地记录。

实现：

```text
Task
Attempt
FailureEvent
```

---

# 325. Week 3

目标：

> Failure Detector。

实现：

```text
Repeated Test
Repeated Build
Repeated Error
No Progress
```

---

# 326. Week 4

目标：

> Escalation Draft + Privacy Preview。

---

# 327. Week 5

目标：

> Case Publish + Expert Join。

专家也采用 Auto ID。

---

# 328. Week 6

目标：

> Result + Verification。

先支持：

```text
Requester
Test
CI
```

---

# 329. Week 7

目标：

> Track Record Auto Generation。

必须证明：

> 没有履历编辑表单也可以自然形成 Profile。

---

# 330. Week 8

目标：

> Node Profile + Similar History Search。

---

# 331. Week 9

目标：

> Open Assistance。

让无历史专家获得第一批真实 Evidence。

---

# 332. Week 10

目标：

> Basic Bounty Metadata。

不做支付。

---

# 333. Week 11

目标：

> 外部 GitHub Evidence。

---

# 334. Week 12

目标：

> 真实数据验证。

不再加功能。

集中观察：

```text
Trigger
Resolution
Evidence
History
Selection
Profile Value
```

---

# 335. 12 周 No-Go 条件之一：Trigger 不产生需求

如果用户在 AI 多次失败后仍然：

> 几乎都不愿求助，

那么 Failure Escalation 入口核心假设不成立，需要修改入口。

---

# 336. No-Go 条件二：没有高质量 Expert

如果任务很难，但真正能解决的人：

> 不愿进入，

则网络供给模式需要重新设计。

---

# 337. No-Go 条件三：Evidence 太弱

如果绝大多数任务只能记录：

```text
“用户说完成了”
```

而无法形成更强验证，

则数据护城河需要重新评估。

---

# 338. No-Go 条件四：History 不影响选择

如果用户看到：

```text
真实相似历史
```

以后仍完全不在乎，

则“信息入口”核心价值需要重新验证。

---

# 339. No-Go 条件五：用户反感自动记录

如果用户强烈反对：

> 本地自动形成历史，

即使隐私控制完善，

则产品需要更谨慎的 Opt-in 模型。

---

# 340. Go 条件

较强信号：

```text
用户主动保留 Edge
专家主动分享 Profile
Requester 主动查类似历史
真实 Verification 持续增加
外部平台愿意接 Evidence
```

这些比 GMV 更重要。


# 341. 开源 / 官方免费 / 官方付费 / 协作经济模式必须四分

这个区别在项目历史中多次容易混淆，本版再次固定。

## 341.1 Open Source

回答：

> 别人能否拿代码自己部署？

## 341.2 Official Free

回答：

> 用户是否免费使用官方托管服务？

## 341.3 Official Paid

回答：

> 哪些官方高级服务收费？

## 341.4 Open / Bounty Assistance

回答：

> 当前这个 Task 是否存在经济激励？

四者完全不同。

---

# 342. 开源范围建议

核心开放：

```text
Core Schema
Node ID / Identity Binding
Task / Attempt / Evidence Schema
Track Record Schema
SDK
Edge Core
Worker
Hub Core
Bridge SDK
Conformance
```

这能让外部世界贡献兼容 Evidence。

---

# 343. 不建议把事实标准闭源

如果 Identity / Evidence Schema 完全闭源：

> 第三方很难放心把自己网络接进来。

项目的护城河不应该依赖：

> 别人看不到 JSON 字段。

---

# 344. 官方数据不因为代码开源而自动公开

开源：

```text
Code
Protocol
```

不代表公开：

```text
用户私有 History
企业 Task
内部风险模型
全量索引
```

---

# 345. Official Free 的网络效应逻辑

官方免费层应该鼓励：

```text
安装
Auto ID
History
Open Assistance
Profile
Evidence
```

因为这些行为增加：

> Network Density。

---

# 346. Official Paid 的信息服务逻辑

真正适合收费的往往是：

```text
谁最合适
这个身份是真的吗
这些历史可靠吗
企业如何批量查询
风险怎样
```

而不是：

> 每次免费协助都收费。

---

# 347. 企业收费可能比个人交易佣金更自然

企业可能愿意为：

```text
Expert Discovery
Agent Due Diligence
Private Capability Graph
Audit
Verification
Risk Monitoring
```

付费。

这些都依赖底层履历。

---

# 348. Capability API

未来调用：

```text
“给我这个 Node 在 PostgreSQL Replication 上的最近 12 个月强 Evidence 摘要”
```

可以成为 API 服务。

---

# 349. Evidence API

企业可以验证：

```text
某条 Honor 是不是由真实 Track Record 支撑
```

这是信息服务。

---

# 350. Reputation API

Reputation API 应返回：

```text
View
Method
Time Window
Evidence Scope
```

而不是一个不解释的数字。

---

# 351. Benchmark

长期 Galaxy 可以形成：

> Real-world Capability Benchmark。

但不能把 Benchmark 变成 Core。

它是历史数据的上层消费。

---

# 352. AI Training Data

高失败 + Human Resolution 数据可能有训练价值。

但必须强调：

> 默认没有训练授权。

需要：

```text
Explicit License
Privacy
Commercial Terms
```

---

# 353. Research Dataset

可以在用户明确授权后：

```text
去敏
聚合
Proof-preserving
```

构建研究数据。

但这属于未来。

---

# 354. Galaxy 与 LinkedIn 的最终边界

LinkedIn 的主要数据逻辑：

```text
用户声明职业信息
+
社交关系
+
验证部分身份
```

Galaxy 的核心：

```text
真实任务事件
+
Attempt
+
Verification
+
自动生成能力历史
```

如果 Galaxy 最终也让用户：

> 手填工作经历，

就失去了关键差异。

---

# 355. Galaxy 与 Upwork 的最终边界

Upwork 主要记录：

> 平台内工作和交易历史。

Galaxy 需要跨：

```text
Galaxy
GitHub
Enterprise
External Platform
AI Workflow
```

形成统一事实履历。

---

# 356. Galaxy 与普通评价网站的区别

评价网站：

```text
5 Stars
Review
```

Galaxy：

```text
What task
What attempt
What result
How verified
```

---

# 357. Galaxy 与 Agent Marketplace 的区别

Agent Marketplace：

> 找 Agent。

Galaxy：

> 找有真实相关经历的能力主体，不在乎它是人还是 Agent。

---

# 358. Galaxy 与 A2A / MCP 的边界

A2A / 类似协议：

> Agent 如何通信。

MCP：

> Agent 如何调用工具 / Context。

Galaxy：

> 真实能力事实如何产生、验证、积累和被发现。

因此不应重造底层通信。

---

# 359. Galaxy 与传统 Credential 的区别

Credential：

```text
某机构证明你获得一个证书
```

Galaxy：

```text
大量真实工作事实
```

Credential 可以成为 Evidence Source。

但不是全部。

---

# 360. Galaxy 与传统简历的区别

简历：

> Summary-first。

Galaxy：

> Evidence-first。

---

# 361. Galaxy 与传统 Reputation 的区别

传统平台：

```text
4.9 Stars
```

Galaxy：

```text
Contextual Capability History
```

---

# 362. Federation 的协议边界

如果未来正式做 Federation，优先标准化：

```text
Node Reference
Evidence Envelope
Attestation
Revocation
Track Record Proof
Capability Metadata
```

而不是：

> 重做所有 Agent Task Transport。

---

# 363. Federation 的利益机制

第三方接入 Galaxy 的价值：

```text
自己的用户可以查更广泛历史
自己的 Expert 历史可携带
自己的 Evidence 获得更大使用范围
本地能力不足时可以外部发现
```

不是：

> 免费给官方送数据。

---

# 364. 数据共享必须可配置

第三方 Hub 可以：

```text
只分享 Proof
分享 Public History
分享 Capability Summary
不分享 Raw Task
```

---

# 365. Federation Peering Agreement

历史上提出的 Peering Agreement 仍有价值。

可以声明：

```text
Sharing Scope
Trust Requirements
Rate Limit
Commercial Terms
Data Retention
Revocation
Dispute Contact
```

---

# 366. Federation 并非 MVP

当前 v3.1：

> 先保证 Core Data 链正确。

Federation 等 Core 产生真实数据以后再做。

---

# 367. Official Global Index

未来官方可以运营：

> Global Evidence / Capability Index。

但它不是唯一合法 Index。

---

# 368. 第三方 Index

开放协议允许：

> 第三方建立自己的搜索 / Reputation View。

这提高协议可信度。

---

# 369. Galaxy Bridge 与外部巨头

战略上不应该说：

> “用户必须离开 GitHub / Upwork / LinkedIn。”

更现实：

```text
外部事实
↓
Bridge
↓
Galaxy Evidence
```

让现有平台成为来源。

---

# 370. 但 Bridge 权限取决于外部平台

并不是所有平台都允许：

> 大规模导出履历。

所以 Bridge 需要遵守 API、用户授权和数据政策。

---

# 371. 用户导入自身数据

即使平台不提供全网 API：

> 用户可能可以授权导入自己的记录。

这是重要冷启动方式。

---

# 372. External Claim

如果用户说：

> “我在某公司做过某项目。”

没有外部 Evidence：

> 可以保存为 Claim。

但 Profile 必须标：

```text
Self-asserted
```

---

# 373. External Verified History

如果：

```text
GitHub PR
Enterprise Signature
```

能证明：

> 才升级 Evidence Strength。

---

# 374. 无感注册与外部身份绑定

首次安装不要求 GitHub OAuth。

当用户需要：

```text
导入 GitHub History
```

时再授权。

这是 Progressive Permission。

---

# 375. 无感注册与 Public Profile

首次安装不自动公开 Profile。

Node 可以：

> 存在但不公开。

直到用户选择：

```text
Share Profile
```

---

# 376. 无感注册与 Expert Discovery

如果 Node 还没有公开可发现状态：

> 不应被随机 Requester 搜到。

用户可以设置：

```text
discoverable
available_for_assistance
private
```

---

# 377. Expert Availability

属于当前状态，不是履历。

例如：

```text
available
busy
offline
```

不能混进 Capability Reputation。

---

# 378. Price 也不是 Capability

某专家收费贵：

> 不等于能力更强。

价格只是 Selection Context。

---

# 379. Response Speed 也是一个独立行为维度

可以记录：

```text
response_time
```

但不和专业技术能力强行混成一个万能分。

---

# 380. Professional Qualification

Official Hub 可基于：

```text
Capability-specific Evidence
Identity
Risk
```

设定某类任务准入。

但 Galaxy Core 只存证据。

---

# 381. Qualification 不应成为全球标准

Enterprise Security Hub 可以比 Community Hub 更严格。

所以 Qualification 属于：

> Policy View。

---

# 382. Reputation 的多视图模型

例如：

```text
Official:
重视 Strong Verification

Community:
重视 Open Contribution

Enterprise:
重视 Organization Attestation + Security

Requester:
只关心类似 Case
```

这比一个全球分数更符合事实。

---

# 383. Honor 也可以多 Issuer

未来：

```text
Official Galaxy Honor
PostgreSQL Community Honor
Enterprise Honor
```

都可以存在。

但用户应看到 Issuer。

---

# 384. “银河”为什么需要公开数据

项目历史中提到：

> 公开数据、排名和荣誉可以增强社区信息凝聚力。

公开部分形成：

```text
社会证明
竞争
身份资产
发现
```

但隐私 Task 仍可 Proof-only。

---

# 385. 信息密度优先于注册量

一个拥有：

```text
100 万 Auto ID
```

但只有：

```text
200 条 Verified History
```

的 Galaxy 价值很低。

所以要追求：

> Evidence-bearing Node Ratio。

---

# 386. Auto ID 的价值不是虚增用户数

不能拿：

```text
安装即生成 ID
```

直接宣传：

> “Galaxy 有 100 万专家”。

Auto ID 只是身份容器。

专家地位来自 History。

---

# 387. 用户数据资产的正确理解

Galaxy 的数据资产不是：

> 个人隐私本身。

而是：

```text
真实任务事实结构
跨主体关系
Verification
Capability History
```

这些才可能产生长期信息价值。

---

# 388. 数据资产必须有合法使用权

“我数据库里有”不等于：

> “我能卖”。

每种数据使用权必须明确。

---

# 389. Network Moat

真正护城河：

```text
Real Nodes
+
Real Tasks
+
Real Attempts
+
Real Verification
+
Time
+
Cross-source Provenance
```

---

# 390. 时间本身构成护城河

一个新竞争者即使复制 Schema：

> 不能复制 5 年连续历史。

---

# 391. 关系密度构成护城河

例如：

```text
某专家
在多个独立 Requester
多个环境
多个时间
多种 Verification
```

形成的历史比单个平台星级更难伪造。

---

# 392. Hard Case 具有额外稀缺性

普通成功任务很多。

AI 反复失败后最终被解决的 Case：

> 更少，更能显示能力边界。

这是 Galaxy Early Data Strategy 的差异化。

---

# 393. 但不应该只记录 Hard Case 永远

Hard Case 是早期获客和高价值采样策略。

长期 Galaxy 可以接：

```text
其他真实工作 Evidence
```

扩大履历完整性。

---

# 394. Early Wedge 与 Final Network 分离

Early Wedge：

> AI repeated failure escalation。

Final Network：

> Cross-platform capability history。

这两个概念必须同时存在。

---

# 395. 如果新 Agent 只看到最终定位会误解入口

所以任何未来项目文档必须同时写：

```text
终局：
能力事实网络

早期入口：
AI 高失败 Escalation
```

不能只写其中一个。

---

# 396. 如果新 Agent 只看到 Failure Trigger 会误解终局

也不能认为：

> Galaxy 就是一个帮 Codex 找人的插件。

Edge 只是获取真实 Case 的入口。

---

# 397. 如果只看到 Bounty 会误解商业模式

不能认为：

> Galaxy = Bounty Marketplace。

Bounty 是 Resolution Incentive。

---

# 398. 如果只看到 Profile 会误解履历来源

不能认为：

> Galaxy = 用户填履历。

Profile 是 Track Record Projection。

---

# 399. 如果只看到 Federation 会误解技术方向

不能认为：

> Galaxy = Agent Federation Protocol。

Federation 是 Evidence Expansion。

---

# 400. 如果只看到 Agent 会误解主体

不能认为：

> Galaxy = Agent Reputation Network。

Human 是一等 Node。

---

# 401. 项目叙事建议固定成四句话

第一句：

> Galaxy 首先出现在 AI 已经反复失败的真实工作现场。

第二句：

> 用户和专家第一次使用时自动获得唯一 ID，不需要注册和填写简历。

第三句：

> 每一次真实尝试、协作、结果和验证会自动形成长期能力履历。

第四句：

> 随着这些事实积累，Galaxy 最终成为人、Agent、团队和工具的可信能力信息入口。

这四句缺一不可。

---

# 402. 面向普通用户的一句话

> **AI 真正卡住的时候，Galaxy 帮你找到做过类似事情的人或 AI。**

---

# 403. 面向 Expert 的一句话

> **你不用经营简历，真实解决过的问题会自动成为你的专业履历。**

---

# 404. 面向 Agent Owner 的一句话

> **让你的专业 Agent 通过真实任务积累可验证历史，而不只是声明“我会什么”。**

---

# 405. 面向企业的一句话

> **用真实工作证据判断人和 Agent 的能力，而不是只看自我描述、模型品牌或一次 Benchmark。**

---

# 406. 面向开发者的一句话

> **接入 Galaxy Schema，让你的产品产生的真实工作事实可以被验证、携带和查询。**

---

# 407. 面向开源社区的一句话

> **协议和核心实现开放，真正的价值来自长期真实历史，而不是代码锁定。**

---

# 408. 产品名称与品牌

当前：

> AGI 银河网络 / AGI Galaxy Network

仍然可以作为项目名。

但最终英文品牌、域名、GitHub Organization：

> 尚未正式冻结。

---

# 409. 协议名称不急于现在定死

可以以后拆：

```text
Galaxy Identity / Evidence Schema
Galaxy Track Record Spec
Galaxy Evidence Federation
```

但 MVP 先做实现。

---

# 410. “AGI” 字样的品牌风险

未来需要单独评估：

- 是否太宏大；
- 是否让项目被误解为基础模型；
- 是否影响企业定位；
- 域名可获得性。

但这不是 Core MVP 阻塞项。

---

# 411. 技术上不要为了“AGI”过度自动化

项目历史已经明确：

> 不要为了看起来像 AGI 而过早做自动 Routing。

继续坚持。

---

# 412. 对 AI 模型进化的适应

模型越来越强：

```text
今天 Hard
明天 Routine
```

Galaxy 不会因此失效。

只要保留：

```text
Time
Configuration
Attempt
Outcome
```

Galaxy 记录的是：

> 能力边界演化。

---

# 413. Agent Build Reputation

例如：

```text
Agent A Build 12
```

在某 Capability 上表现很好。

升级 Build 13：

> 不应完全继承旧分数。

可以继承 Identity History，但新 Build 需要新的 Evidence。

---

# 414. Human History 同样需要 Recent View

一个人 10 年前做过：

```text
Oracle DBA
```

不代表今天仍处于同一状态。

所以 Search 应支持：

```text
Recent 90d
Recent 1y
All Time
```

---

# 415. Time Decay

是否对旧 History 自动降权：

> 仍未最终决定。

底层 History 永不因为降权消失。

只有 Reputation View 可采用 Time Decay。

---

# 416. Failure Outcome 的公平性

一个 Agent 接到最难的问题：

> 失败率可能更高。

不能简单因为失败多就判断它更差。

需要结合：

```text
Difficulty
Selection Bias
Environment
```

这也是为什么保留原始 History 比一个 Score 更重要。

---

# 417. Expert Selection Bias

顶尖 Expert 可能专门处理别人解决不了的 Case。

所以他们的：

```text
Raw Success Rate
```

不一定比处理普通任务的人高。

Galaxy 更需要上下文。

---

# 418. Difficulty-adjusted View

未来可以有：

```text
Difficulty-weighted Performance
```

但仍属于 Derived View。

---

# 419. User Choice 不应完全自动化

即使系统推荐：

> 用户仍可选择另一个 Node。

尤其高风险任务。

---

# 420. 选择行为本身也是信息

如果用户经常在：

```text
A / B / C
```

中选择 B，而 B 最终更常成功，

长期可以改进 Recommendation。


# 421. 场景示例一：普通 Coding Failure，不触发 Galaxy

用户：

```text
让 Codex 修复一个 TypeScript 类型错误。
```

Attempt 1：

```text
编译失败。
```

Attempt 2：

```text
Codex 读取更多文件后成功。
```

结果：

```text
Test Pass
Build Pass
```

Galaxy 行为：

- 本地 Failure Detector 可以观察到一次失败；
- 不弹外部协助；
- 不把普通失败升级为 Hard Case；
- 不打扰用户；
- 是否形成普通本地工作历史由未来设置决定；
- 该 Case 不进入早期 Galaxy 公共高难网络。

这个示例用于强调：

> **Galaxy 不是错误出现器。**

---

# 422. 场景示例二：真正达到 Failure Threshold

用户：

```text
让 Claude Code 修复数据库连接池偶发死锁。
```

过程：

```text
Attempt 1:
修改连接池参数
测试仍失败

Attempt 2:
修改锁超时
测试偶发失败

Attempt 3:
重构连接管理
出现新回归

Attempt 4:
恢复部分代码
原始问题仍存在

Attempt 5:
Claude 表示需要更多生产环境信息
```

Galaxy 本地发现：

```text
持续 48 分钟
5 个 Attempts
3 个相似 Failure Group
无稳定 Resolution
```

此时才触发：

```text
“当前 AI 已多轮尝试仍未解决，可能需要数据库并发问题经验。”
```

这就是主入口。

---

# 423. 场景示例三：假高难——环境问题

用户：

```text
Agent 反复无法调用测试数据库。
```

失败很多次。

但 Hardness Qualification 发现：

```text
Database credential expired
```

Galaxy：

> 优先建议修复 Credential。

不直接招募 PostgreSQL Expert。

这样可以提高 Expert 网络质量。

---

# 424. 场景示例四：Human Expert 首次加入

Human Expert 从未听说 Galaxy。

他收到链接：

```text
“有一个 PostgreSQL Replication Hard Case 请求协助。”
```

点击后：

```text
Galaxy Web / Client 自动生成 Node ID
```

他看到：

```text
脱敏摘要
已有失败尝试
预算 / 免费模式
验证方式
```

他不需要：

```text
上传简历
填写技能
申请专家认证
```

完成以后：

```text
CI + Requester Verification
```

他的 Node 自动出现：

```text
PostgreSQL Replication
Verified Resolution #1
```

这是最重要的无感专家入网机制。

---

# 425. 场景示例五：专家已经有外部历史

Expert 首次加入但拥有：

```text
GitHub Maintainer History
```

他可以选择：

```text
Connect GitHub
```

Galaxy 导入：

```text
PR
Issue
Review
Organization
```

并标记：

```text
External Evidence — GitHub
```

这些不是用户手填履历。

---

# 426. 场景示例六：Agent Worker 首次加入

开发者部署：

```text
galaxy-worker
```

Worker 自动：

```text
生成 Node ID
生成 Build ID
读取本地 Agent Configuration
```

Developer 只需要配置：

```text
允许的任务类型
风险
并发
```

Agent 开始：

```text
24×7 Auto Apply
```

历史自然形成。

---

# 427. 场景示例七：Human + Agent

Expert 王某接任务。

他使用：

```text
自己的 Agent DBA-X
```

Agent DBA-X：

```text
发现日志中 replication slot 异常
```

王某：

```text
识别真正 Race Condition
```

最终成功。

Galaxy 记录：

```text
DBA-X:
Supporting Attempt / Diagnosis

王某:
Human Intervention + Successful Resolution

共同 Collaboration:
Human + Agent
```

未来 Galaxy 可以比较：

> Human alone、Agent alone、Human+Agent。

---

# 428. 场景示例八：Task 没有成功

专家尝试以后仍失败。

不能删除这条 History。

记录：

```text
Attempt = Failed
Verification = Failed
Resolution = Unresolved
```

未来该 Expert 的相关 Profile View 会反映：

> 有相关尝试，但没有成功。

---

# 429. 场景示例九：Partial Success

Expert 找到 workaround：

```text
服务恢复
但 Root Cause 未解决
```

记录：

```text
Resolution = Resolved with Workaround
```

而不是简单 Success。

---

# 430. 场景示例十：后续发现回归

任务最初：

```text
CI Passed
Requester Confirmed
```

一周后：

```text
Production Regression
```

新增：

```text
Verification Failed
Regression Evidence
```

History 时间线保留两次判断。

---

# 431. 场景示例十一：外部交易

Requester 和 Expert 在 Galaxy 找到彼此。

随后：

```text
通过企业采购合同支付
```

Galaxy 不碰钱。

但记录：

```text
Collaboration
Task
Attempt
Result
Verification
```

仍然形成完整履历。

---

# 432. 场景示例十二：没有任何付款

Open-source Maintainer 免费帮助解决。

同样形成：

> Verified Track Record。

这证明：

> Galaxy History 不依赖交易。

---

# 433. 场景示例十三：Capsule 复用

Case A 成功后生成：

```text
Capsule X
```

Case B：

```text
AI repeated failure
↓
Galaxy 找到 Capsule X
↓
使用后成功
```

系统记录：

```text
Capsule Verification +1
```

作者得到新的 Evidence。

---

# 434. 场景示例十四：Capsule 过时

环境升级后：

```text
Capsule X
连续失败
```

Recent Effectiveness View 下调。

旧成功仍保留。

---

# 435. 场景示例十五：Requester 信誉

Requester A：

```text
10 个任务
9 个及时验收
0 恶意争议
```

Requester B：

```text
20 个任务
12 个选中后取消
```

Expert 可以据此决定是否响应。

---

# 436. 场景示例十六：Expert 不公开真实姓名

某专家希望：

> pseudonymous。

Galaxy 可以显示：

```text
Node GXY-...
Verified History
GitHub Optional
```

只要 Evidence 强：

> 仍有信息价值。

---

# 437. 场景示例十七：企业 Proof-only

企业不愿公开 Case。

公开 Track Record：

```text
Enterprise-verified
PostgreSQL Recovery
Very Hard
Resolved
2026-Q3
```

不显示企业名和源码。

---

# 438. 场景示例十八：同一任务跨平台重复

GitHub Issue：

```text
被 Galaxy Bridge 导入
又被用户手工 Escalate
```

系统通过：

```text
canonical hash / source id
```

识别同一 Case。

只形成一组 Canonical History。

---

# 439. 场景示例十九：同一 Agent 新版本

Agent A Build 1：

```text
10 次类似任务，4 成功
```

Agent A Build 2：

```text
换模型和 MCP
```

Profile 可以展示：

```text
Node lifetime history
+
Current Build recent history
```

而不是让旧失败永远压住新版。

---

# 440. 场景示例二十：Human 能力变化

专家过去：

```text
Frontend
```

最近两年：

```text
Database
```

动态 Profile 根据当前 Task：

> 优先展示相关、近期历史。

---

# 441. Anti-misreading：绝不能写“用户创建履历”

后续文档禁止使用模糊句：

> “用户创建履历。”

应该写：

> **系统根据真实经历生成 Track Record。**

如果需要人工输入：

> 必须写清楚它只是 Self-asserted Claim。

---

# 442. Anti-misreading：绝不能把首次使用写成“注册”

如果技术实现需要 Hub 注册 Node：

内部可以叫：

```text
register_node
```

但产品叙事应写：

> **首次安装自动生成身份；首次网络交互自动完成网络登记。**

避免让产品经理误做注册表单。

---

# 443. Anti-misreading：绝不能把所有 Task 都叫“疑难求助”

Coding MVP 的主 Task：

> **AI repeated-failure Escalated Case。**

其他 Task 来源是扩展。

---

# 444. Anti-misreading：绝不能说“用户需要维护 Profile”

正确：

> Profile 自动生成，用户只管理可见性、身份绑定和自我声明信息。

---

# 445. Anti-misreading：绝不能说“专家必须先通过人工审核才能有账号”

Identity 自动生成。

某些高风险任务的 Qualification：

> 可以需要审核。

这是两个层级。

---

# 446. Anti-misreading：绝不能把 Honor 当成可编辑字段

Honor 必须自动派生或由可信 Issuer 签发。

---

# 447. Anti-misreading：绝不能把 Rating 当成 Track Record

用户可以评价。

但 Rating 只是 Feedback Evidence 的一类。

---

# 448. Anti-misreading：绝不能把成功率当唯一能力

必须保留：

```text
Difficulty
Context
Time
Failure
Verification
```

---

# 449. Anti-misreading：绝不能把 Agent Build 历史全合并

Model / Skill / MCP 大变化：

> 必须有 Configuration 维度。

---

# 450. Anti-misreading：绝不能把 Federation 作为 MVP 前提

单 Hub / 单官方 Backend 即可跑 Core。

---

# 451. Anti-misreading：绝不能因为开源就把所有用户数据公开

代码开放和数据权限完全不同。

---

# 452. Anti-misreading：绝不能强制支付经过 Galaxy

MVP 可以完全外部结算。

---

# 453. Anti-misreading：绝不能自动把敏感上下文发送给专家

必须 Privacy Preview + Scope Grant。

---

# 454. Anti-misreading：绝不能每次失败都打扰

需要 Threshold、Hardness、Cooldown。

---

# 455. Anti-misreading：绝不能把 Human 当最后 fallback 才记录

Human 从一开始就是 Node。

---

# 456. Anti-misreading：绝不能用“无感注册”合理化偷偷上报数据

无感的是：

> Identity existence。

外发仍需权限。

---

# 457. Anti-misreading：绝不能把 Auto ID 统计成 Verified User

应区分：

```text
Generated Node
Claimed Node
Evidence-bearing Node
Verified Identity Node
```

---

# 458. Anti-misreading：绝不能把“高失败”理解成纯失败次数

需要 Failure Classification / Hardness。

---

# 459. Anti-misreading：绝不能要求用户为了完整履历打开 Galaxy 做打卡

Evidence Capture 应尽量嵌入工作流自动完成。

---

# 460. Anti-misreading：绝不能把履历压缩后丢掉底层数据

Summary 是 View。

Raw structured History 是 Core。

---

# 461. 历史决定追溯：Failure Threshold

状态：

> **保留并强化。**

从：

> 一个 Trigger 功能

升级成：

> Early Wedge + Hard Case Sampling Strategy。

---

# 462. 历史决定追溯：Open Assistance

状态：

> **保留。**

最新角色：

> Track Record Cold-start。

---

# 463. 历史决定追溯：Paid Assistance

状态：

> **保留但改为 Bounty / Paid Collaboration Layer。**

不是 Core。

---

# 464. 历史决定追溯：Paid Eligibility

状态：

> **保留。**

必须：

> Capability-specific。

---

# 465. 历史决定追溯：Manual Selection

状态：

> **保留为前期核心原则。**

---

# 466. 历史决定追溯：Automatic Routing

状态：

> **长期后置。**

---

# 467. 历史决定追溯：Recommendation Logs

状态：

> **从第一天保留。**

---

# 468. 历史决定追溯：完整履历

状态：

> **从重要对象升级为项目核心。**

---

# 469. 历史决定追溯：AI Career History

状态：

> **保留并扩展为 Human / Agent Unified Capability History。**

---

# 470. 历史决定追溯：排行榜

状态：

> **保留为派生信息与激励。**

---

# 471. 历史决定追溯：社区等级

状态：

> **保留，但不得替代 Capability Evidence。**

---

# 472. 历史决定追溯：Capsule

状态：

> **保留为 Resolution Knowledge Layer。**

---

# 473. 历史决定追溯：Worker

状态：

> **保留为 Agent 接入方式。**

---

# 474. 历史决定追溯：Hub

状态：

> **保留为第三方 Local Evidence Network。**

---

# 475. 历史决定追溯：Bridge

状态：

> **保留并提升跨平台历史导入价值。**

---

# 476. 历史决定追溯：Federation

状态：

> **从核心降级为 Evidence Expansion。**

---

# 477. 历史决定追溯：支付

状态：

> **继续后置。**

---

# 478. 历史决定追溯：Token

状态：

> **MVP 不需要。**

未来是否需要：

> 未决定。

---

# 479. 历史决定追溯：MCP / A2A

状态：

> Galaxy 不替代它们。

尽量复用现有通信和工具标准。

---

# 480. 历史决定追溯：Graph DB

状态：

> **不是 MVP 要求。**

---

# 481. 历史决定追溯：Protocol

状态：

> 仍需开放 Schema，但不以“做最大通信协议”为目标。

---

# 482. 历史决定追溯：Official Hosted Network

状态：

> **保留。**

官方可以成为最大 Public Network 和信息服务提供者。

---

# 483. 历史决定追溯：协议开放，数据护城河

状态：

> **继续成立，而且比以前更重要。**

---

# 484. 本次新增确认：无感注册

状态：

> **提升为 Core Invariant。**

---

# 485. 本次新增确认：Auto History

状态：

> **提升为 Core Invariant。**

---

# 486. 本次新增确认：Profile 是 Projection

状态：

> **正式确定。**

---

# 487. 本次新增确认：高失败不是一般疑难

状态：

> **正式写入 Early Product Definition。**

---

# 488. Core Invariants 完整列表

后续版本无特别理由不得推翻：

```text
1. Auto Node ID
2. No required profile form
3. Profile auto-grows from events
4. Repeated AI failure is early trigger
5. User confirms external disclosure
6. Human / Agent equal Node
7. Attempt is first-class
8. Result != Verification
9. Evidence-first
10. Track Record high-fidelity
11. Capability-specific views
12. Requester also has history
13. Open Assistance for cold-start
14. Bounty for incentive
15. External settlement allowed
16. Human selection first
17. Routing later
18. External evidence import
19. Federation is expansion
20. Reputation is derived
21. Honor is evidence-backed
22. Sensitive raw data need not be public
```

---

# 489. 尚未决定：Node ID 最终格式

可先：

```text
UUIDv7 + Key
```

长期：

> 是否 DID / VC 体系，待评估。

---

# 490. 尚未决定：身份恢复

需要设计：

```text
Passkey
Recovery Key
GitHub
Email
Enterprise
```

组合。

---

# 491. 尚未决定：多 Node Merge

需要反欺诈设计。

---

# 492. 尚未决定：Capability Ontology

Coding 先小范围。

---

# 493. 尚未决定：Evidence Strength 最终标准

E0–E5 只是工作草案。

---

# 494. 尚未决定：Hardness Formula

MVP 先规则。

---

# 495. 尚未决定：Failure Taxonomy

需要真实数据迭代。

---

# 496. 尚未决定：Track Record 默认可见性

建议谨慎默认。

---

# 497. 尚未决定：失败记录公开方式

核心事实需要保留，但 Public Profile 的展示需要用户体验研究。

---

# 498. 尚未决定：Reputation Algorithm

不能现在拍脑袋定一个万能公式。

---

# 499. 尚未决定：Honor 规则

需要避免游戏化污染事实。

---

# 500. 尚未决定：Capsule 商业化

可以未来：

```text
Free
Paid
Enterprise
```

但不是 MVP。


# 501. 尚未决定：第一官方收费服务

当前只确定：

> 商业化优先围绕信息价值。

具体第一项收费：

```text
Advanced Search
Verification
Enterprise API
Hosted Hub
```

仍需真实用户决定。

---

# 502. 尚未决定：官方是否永远不碰结算

现在：

> MVP 不碰。

未来是否提供可选 Settlement：

> 保留。

但即使提供：

> 不应改变 Galaxy Core = History Network。

---

# 503. 尚未决定：是否需要平台 Token

当前结论：

> 不需要。

任何 Token 设计都不能先于真实网络价值。

---

# 504. 尚未决定：Federation 何时重启

建议只有当：

```text
至少两个独立 Hub
确实拥有真实 Evidence
并存在跨网查询需求
```

后再优先。

---

# 505. 尚未决定：Training Data Business

这可能非常有价值，也可能产生最大隐私风险。

必须单独立项。

---

# 506. 尚未决定：个人 Profile 与匿名专业身份

可能同时支持：

```text
Real Name
Pseudonym
Organization-only
Agent Brand
```

不强制一种。

---

# 507. 尚未决定：公开失败的法律与声誉问题

需要研究：

```text
用户更正权
争议
Defamation
Privacy
Enterprise Confidentiality
```

---

# 508. 尚未决定：专家邀请机制

可以：

```text
Direct Invite
Community Pool
Search
Hub Notification
```

MVP 从小范围邀请开始即可。

---

# 509. 尚未决定：Open Assistance 激励

除了 Honor：

```text
Contribution
Ranking
Capsule
Future Eligibility
```

如何组合，需要测试。

---

# 510. 尚未决定：Expert 收益

Galaxy 不以佣金为目的，但 Expert 仍需要现实激励。

可以：

```text
Bounty
External Contract
Reputation
Honor
Inbound Opportunities
```

---

# 511. 名词表：Galaxy Node ID

> 第一次安装 / 首次进入 Galaxy-compatible Client 时自动生成的长期主体标识。

它不是：

> 实名认证结果。

---

# 512. 名词表：Identity Binding

> 将 Node ID 与 GitHub、邮箱、企业、Passkey 或其他现实 / 数字身份建立可验证联系。

---

# 513. 名词表：Declared Capability

> Node 自己声明会某项能力。

可信度默认较低。

---

# 514. 名词表：Verified Capability

> 由真实 Task / Evidence 支撑的能力状态。

---

# 515. 名词表：Task

> 真实工作任务。

---

# 516. 名词表：Case

> 被 Galaxy 持续追踪的任务事实集合。

---

# 517. 名词表：Escalated Case

> 当前 AI 已经产生多轮失败后，由用户确认升级为外部协助的 Case。

这是 Coding MVP 主入口。

---

# 518. 名词表：Failure Threshold

> 用于识别当前 AI 工作已经长时间或多轮无法有效推进的综合触发条件。

不是一次错误。

---

# 519. 名词表：Hardness Qualification

> 判断反复失败是否真的代表能力难题，而不是环境、权限、工具等噪声。

---

# 520. 名词表：Attempt

> 某个 Node 在特定时间和配置下对 Task 的一次实际尝试。

---

# 521. 名词表：Intervention

> 一个新的 Human / Agent / Tool 如何介入并改变原任务过程。

---

# 522. 名词表：Collaboration

> 多个 Node 围绕 Task 实际建立的协作关系。

不要求 Galaxy 参与付款。

---

# 523. 名词表：Result

> 某次 Attempt 交付的实际结果。

---

# 524. 名词表：Resolution

> 整个 Task 最终是否真正解决。

---

# 525. 名词表：Verification

> 为什么相信 Result / Resolution 有效。

---

# 526. 名词表：Evidence

> 支撑某项事实的可追溯证据。

---

# 527. 名词表：Attestation

> 某个可识别主体对某项事实签发的声明。

---

# 528. 名词表：Track Record

> 由真实工作事实自动形成的长期能力历史。

不是用户手填简历。

---

# 529. 名词表：Reputation View

> 基于 Track Record / Evidence 计算出的某个解释视图。

不是事实本身。

---

# 530. 名词表：Honor

> 由 Evidence 支撑、可以公开传播的荣誉。

---

# 531. 名词表：Contribution

> 对社区 / Open Assistance / Verification / Knowledge 产生的贡献记录。

---

# 532. 名词表：Capsule

> 从真实 Resolution 中提炼的可复用、可验证知识工件。

---

# 533. 名词表：Galaxy Edge

> 嵌入现有 AI 工作流，负责 Failure Detection、Escalation、Privacy Preview 和 Evidence Capture 的入口客户端。

---

# 534. 名词表：Galaxy Worker

> 让专业 Agent 24×7 参与任务并产生真实 Attempt History 的 Runtime。

---

# 535. 名词表：Galaxy Hub

> 第三方可运营的本地 Galaxy-compatible Evidence / Capability Network。

---

# 536. 名词表：Galaxy Bridge

> 将外部平台的真实事实映射成带 Provenance 的 Galaxy Evidence 的适配器。

---

# 537. 名词表：Galaxy Federation

> 不同独立网络之间交换可验证能力事实的扩张机制。

不是 Galaxy Core。

---

# 538. 新 Agent 阅读本项目时的强制理解顺序

任何新 Agent 在分析项目时，建议按以下顺序读取，而不是从 Marketplace 开始：

```text
1.
Auto Node ID / 无感注册

2.
Repeated AI Failure / Failure Threshold

3.
Task / Attempt / Resolution

4.
Evidence / Verification

5.
Automatic Track Record

6.
Human / Agent Unified Node

7.
Identity / Capability / Honor

8.
Open Assistance / Bounty

9.
Worker / Hub / Bridge

10.
Federation / Commercial Services
```

顺序反过来很容易误读。

---

# 539. 给未来 AI Agent 的项目解释提示

如果将本项目交给另一个 AI，应优先使用以下定义：

> 你正在分析的是 AGI 银河网络。请不要把它理解成用户手动填写职业经历的简历网站，也不要把它理解成一般疑难求助平台。它的早期产品入口是：用户正常使用 Codex、Claude Code、Cursor 等 AI Agent 处理真实工作，只有当 AI 已经反复尝试、持续失败并达到 Failure Threshold 时，Galaxy 才低打扰地触发外部协助建议。用户和提供帮助的专家 / Agent 第一次安装 Galaxy 时都会自动获得唯一 Node ID，不需要先注册、填写资料或填写履历。后续 Identity、Capability、Track Record、Reputation 和 Honor 主要由 Task、Attempt、Result、Verification、Evidence 等真实事件自动生成。Human、Agent、Team、Tool 都是同等 Node。赏金只是促进高难任务解决的激励机制，交易可以完全在 Galaxy 外发生；Worker、Hub、Bridge、Federation 都是接入和扩张机制。Galaxy 真正要积累的是可验证能力历史，并最终成为“谁真正做过什么”的信息入口。

这段提示可以直接放入未来 Agent 的 Project Context。

---

# 540. 开发验收：无感注册

产品若出现以下流程，视为违背当前设计：

```text
首次安装
↓
必须输入邮箱
↓
必须填技能
↓
必须完善 Profile
↓
才能工作
```

正确验收：

```text
首次安装
↓
自动 Node ID
↓
直接可运行
```

---

# 541. 开发验收：自动履历

如果完成一次任务后：

> 专家必须手工去 Profile 添加“工作经历”

才能产生 History，

视为不合格。

正确：

```text
Resolution + Evidence
↓
自动 Track Record
```

---

# 542. 开发验收：Failure Trigger

如果一次普通错误就弹求助：

> 不合格。

必须可以观察：

```text
Repeated Failure / No Progress
```

---

# 543. 开发验收：Privacy

如果 Trigger 自动把源码上传：

> 不合格。

必须 Preview。

---

# 544. 开发验收：Human First-class

如果数据库架构只能：

```text
agents
```

而 Human 只能作为临时文本：

> 不合格。

---

# 545. 开发验收：Result vs Verification

如果 `task.status=done` 就自动当强成功履历：

> 不合格。

需要 Verification。

---

# 546. 开发验收：Evidence Source

如果外部历史导入以后看不出：

> 来自哪里，

不合格。

---

# 547. 开发验收：Agent Build

如果 Agent 换模型以后所有历史完全无区分：

> 不合格。

---

# 548. 开发验收：Failure History

如果 Provider 可以直接删除所有失败让 Profile 看起来 100% 成功：

> 事实层不合格。

可以改变公开 Visibility，但不能伪造底层历史。

---

# 549. 开发验收：Bounty

如果没有内置支付就无法完成 Task：

> MVP 设计错误。

External Settlement 必须可行。

---

# 550. 开发验收：Open Assistance

无历史 Node 必须存在真实进入网络的路径。

---

# 551. 开发验收：Profile

Profile 数据结构应该可以：

> 从 Core History 重建。

如果 Profile 是独立手填数据库，设计错误。

---

# 552. 开发验收：Honor

Honor 必须有：

```text
issuer
evidence
rule
```

---

# 553. 开发验收：Recommendation

系统推荐不能阻止用户人工选择。

---

# 554. 开发验收：Federation

单实例 Core 在没有 Federation 时必须完整运行。

---

# 555. 开发验收：Open Source

自托管 Hub 不应因为没有官方云就无法生成基本 Track Record。

---

# 556. 开发验收：数据可携带

Node 应长期能够导出：

```text
Identity References
Track Record Proof
Attestation
```

具体格式后续定。

---

# 557. “用户”到底是谁

本项目中的“用户”不是单一消费者概念。

它可以包括：

```text
正在被 AI 卡住的 Requester
解决别人任务的 Human Expert
Agent Owner
Verifier
Enterprise Operator
```

同一个现实人可以同时扮演多个角色。

---

# 558. “专家”到底是谁

Expert 不是账号类型。

是：

> 某 Node 在某 Capability 上通过真实历史逐渐显现出的状态。

---

# 559. “履历所有者”到底是谁

可以是：

```text
Human
Agent
Team
Organization
Tool
```

所有这些 Node 都可以积累事实历史。

---

# 560. Galaxy 为什么叫“银河”

不是因为：

> 有很多 Agent。

更准确是：

> 每一个 Node 都像一颗星，每一次真实任务、协作、验证形成星与星之间的关系；随着时间积累形成不断扩张的 Capability / Evidence Graph。

---

# 561. 银河中最重要的“边”

例如：

```text
Node attempted Task
Node solved Task
Node failed Task
Node verified Result
Node collaborated_with Node
Node used Tool
Node used Capsule
Organization attested Node
```

这比孤立 Profile 数量更有价值。

---

# 562. Galaxy Graph 的长期对象

```text
Identity Graph
Capability Graph
Task Graph
Attempt Graph
Collaboration Graph
Evidence Graph
Honor Graph
Capsule Graph
```

但它们是同一事实系统不同视图。

---

# 563. 实时能力边界

因为所有 Attempt 带 Time / Configuration：

Galaxy 长期可以看到：

```text
什么问题曾经需要 Human
后来被 Agent 解决

什么 Agent Build 在哪些环境进步
什么 Tool 让 Resolution 明显提高
```

这是传统静态履历没有的价值。

---

# 564. Real-world Benchmark 只是一个自然副产品

Galaxy 不需要先设计 Benchmark。

当数据足够：

> 真实 History 自然可以形成 Benchmark View。

---

# 565. Hiring 也是自然副产品

企业可能通过：

```text
真实 Similar History
```

寻找 Human。

但 Galaxy 不需要一开始变成招聘网站。

---

# 566. Agent Discovery 也是自然副产品

用户可以通过同一套 History：

> 找 Agent。

但 Galaxy 不需要成为 Agent Store。

---

# 567. Tool Discovery 也是自然副产品

某个 Tool 在类似 Case 中表现好：

> 也可被发现。

---

# 568. Capsule Discovery 也是自然副产品

先找解决方法，再找人。

---

# 569. Enterprise Risk 也是自然副产品

企业可以问：

```text
这个 Agent 在生产环境有哪些历史？
失败和回归怎样？
```

---

# 570. Reputation Monitoring 也是自然副产品

例如：

```text
Agent Build 新版表现显著下降
```

Galaxy 可以预警。

---

# 571. 核心数据产品不能依赖单一模型

Galaxy 自身可以使用 AI：

```text
分类
摘要
相似搜索
```

但底层事实 Schema 应模型中立。

---

# 572. AI Summary 不得篡改事实

所有摘要应可追溯：

```text
derived_from
```

用户能打开原始 Track Record。

---

# 573. Profile 文案也需要标注 Derived

例如：

> “近期在 PostgreSQL Replication 上表现强。”

这是系统摘要。

旁边应可看到：

```text
Based on 12 verified cases
```

---

# 574. 公开失败与用户尊严

Galaxy 不是羞辱系统。

失败数据的目的：

> 提供真实上下文。

UI 可以避免：

```text
FAILURE SCORE 42
```

这种简单负面标签。

更适合：

```text
相关任务：
8 Success / 2 Partial / 3 Unresolved
```

---

# 575. Failure 数据对 Agent 更重要

Agent Owner 可以看到：

```text
哪个 Build 退化
哪个 Tool 不工作
```

因此失败历史本身是产品价值。

---

# 576. Failure 数据对 Human 也有价值

专家可以证明：

> 自己长期选择最难任务。

这进一步说明不能只看 Raw Success Rate。

---

# 577. Galaxy 的价值不是“判断谁永远最好”

而是：

> 提供足够真实历史，让当前决策更有信息。

---

# 578. 搜索入口应优先 Task-first

用户常见行为：

```text
我现在有一个问题
↓
谁处理过类似问题？
```

而不是：

```text
我要浏览所有专家。
```

---

# 579. Profile-first 是第二入口

当别人分享：

> Galaxy ID / Profile

用户可以查询历史。

---

# 580. Honor-first 是传播入口

专家可能分享：

```text
Verified High Difficulty Resolver
```

带来更多用户查询。

---

# 581. API-first 是企业入口

企业不一定打开 Web UI。

可能：

```text
内部系统调用 Galaxy Evidence API
```

---

# 582. Edge-first 是个人入口

AI Coding 失败现场。

---

# 583. Worker-first 是 Agent Owner 入口

专业 Agent 需要真实工作历史。

---

# 584. Hub-first 是第三方平台入口

平台想拥有自己的本地网络。

---

# 585. Bridge-first 是已有生态入口

不迁移系统也能接入。

---

# 586. 这些入口最终都汇聚到同一 Core

```text
Identity
Task
Attempt
Evidence
Track Record
```

如果不同入口产生不同履历体系：

> 架构失败。

---

# 587. 当前最应该开发的代码不是 Ranking

而是：

```text
Auto Node ID
Task
Attempt
Failure
Escalation
Verification
Evidence
TrackRecord
```

---

# 588. 当前最应该验证的 UX 不是 Profile Editor

而是：

```text
Failure Trigger
Privacy Preview
One-click Escalation
Automatic History
```

---

# 589. 当前最应该验证的数据不是交易金额

而是：

```text
真实 Hard Case
Attempt Chain
Verification
```

---

# 590. 当前最应该验证的网络不是 Federation

而是：

> 20–50 个真实能力主体能否解决真实 Escalated Cases，并留下可用 History。

---

# 591. 当前最应该避免的开发陷阱

```text
为了完整性先做所有身份系统
为了未来先做支付
为了开放先做复杂 Federation
为了 AI 感先做自动 Routing
为了社区先做大型 Feed
为了漂亮先做复杂 Profile Editor
```

都可能偏离核心。

---

# 592. 最小研发团队也能验证

Galaxy Core MVP 的技术量并没有宏大蓝图那么大。

真正困难的是：

> 产品触发、专家供给、Evidence 真实性。

所以小团队可以先做。

---

# 593. 第一版身份甚至可以只有本地 Key

不要因为未来可能需要复杂 Credential：

> 阻塞无感 ID。

---

# 594. 第一版 Honor 可以只有少数

例如：

```text
First Verified Resolution
10 Verified Resolutions
Open Contributor
```

不需要 100 个 Badge。

---

# 595. 第一版 Capability 可以手工 taxonomy + AI 辅助

不需要先解决整个职业分类学。

---

# 596. 第一版 Verification 重点 Coding

```text
Test
Build
CI
Requester
```

已经足够验证方向。

---

# 597. 第一版 Expert 可以人工邀请

不需要先建百万供给市场。

---

# 598. 第一版 Search 可以规则排序

不需要复杂 Recommendation Model。

---

# 599. 第一版外部 Evidence 只接 GitHub

不需要同时 Bridge 十个平台。

---

# 600. 第一版 Bounty 只记录文本金额

支付外部完成。

---

# 601. 第一版 Federation 不做

保留 Schema 可扩展即可。

---

# 602. 第一版 Profile 不做简历编辑

只做：

```text
事实展示
可见性设置
身份绑定
```

---

# 603. 第一版 Failure Trigger 只支持几个高 Precision 信号

例如：

```text
Repeated Test Failure
Repeated Build Failure
Repeated Same Error
Manual “I’m stuck”
```

---

# 604. 第一个 MVP 成功画面

不是：

> “我们上线了 30 个页面。”

而是：

```text
一个用户
AI 卡住
一键求助
一个真实 Expert
解决
CI 验证
Expert Profile 自动多出一条可信历史
下一次另一个用户因为这条历史选择他
```

这就是 Galaxy Core 被验证。

---

# 605. v3.1 最终核心流程

```text
INSTALL
↓
AUTO NODE ID
↓
NORMAL AI WORK
↓
REPEATED FAILURE
↓
FAILURE THRESHOLD
↓
HARDNESS QUALIFICATION
↓
ONE-CLICK ESCALATION
↓
PRIVACY PREVIEW
↓
HUMAN / AGENT / TOOL ASSISTANCE
↓
ATTEMPT
↓
RESULT
↓
VERIFICATION
↓
RESOLUTION
↓
EVIDENCE
↓
AUTO TRACK RECORD
↓
CAPABILITY HISTORY
↓
HONOR / REPUTATION VIEW
↓
SEARCH / INFORMATION VALUE
```

---

# 606. v3.1 最终核心数据链

```text
Node
→ IdentityBinding
→ Capability
→ Task
→ FailureEvent
→ Escalation
→ Attempt
→ Intervention
→ Collaboration
→ Result
→ Resolution
→ Verification
→ Evidence
→ TrackRecord
→ ReputationView
→ Honor
```

---

# 607. v3.1 最终商业链

```text
真实 History
↓
更可信 Search
↓
更多用户依赖 Galaxy 做判断
↓
Galaxy 成为信息入口
↓
Advanced Search / Verification / API / Enterprise
```

而不是：

```text
先抽交易佣金
↓
再想数据
```

---

# 608. v3.1 最终增长链

```text
Edge 安装
↓
Auto ID
↓
Failure Case
↓
Resolution
↓
History
↓
Profile Value
↓
Expert / Agent 自传播
↓
更多用户
↓
更多 Evidence
```

---

# 609. v3.1 最终开源链

```text
Open Schema
↓
更多 Edge / Worker / Hub / Bridge
↓
更多地方产生 compatible Evidence
↓
Galaxy Graph 扩大
```

---

# 610. v3.1 最终人机关系

```text
Human
不是 fallback

Agent
不是中心

两者都是 Node
```

Galaxy 最终只问：

> **你真正做过什么，有什么证据？**

---

# 611. 最终结论

整个项目经过从：

```text
等待时间利用
→ AI Failure Assistance
→ Protocol
→ Marketplace
→ Track Record
→ Open/Paid Assistance
→ Worker
→ Hub
→ Federation
→ Bounty Brokerage
→ Capability History Network
```

的多轮演化以后，最稳定、最不应该继续摇摆的核心已经非常清楚。

Galaxy 的早期产品切口必须保持：

> **现有 AI 在真实工作中反复失败以后才出现。**

这解决“普通疑难用户为什么要主动求助”的问题。

Galaxy 的身份增长方式必须保持：

> **首次安装自动生成唯一 ID，不要求用户或专家先注册、先填资料、先填履历。**

这解决冷启动摩擦。

Galaxy 的履历生成方式必须保持：

> **真实工作事件自动沉淀，Profile 只是 Track Record 的动态投影。**

这解决与传统简历和职业社交网络的根本差异。

Galaxy 的主体模型必须保持：

> **Human、Agent、Team、Tool 都是 Node。**

这让项目不押注某一种智能形态。

Galaxy 的交易定位必须保持：

> **交易和赏金只是促进真实协作发生的机制；双方完全可以在 Galaxy 外成交。**

这让项目不被支付和佣金模式限制。

Galaxy 的真正资产必须保持：

> **Identity + Task + Attempt + Verification + Evidence + Track Record 的长期真实关系。**

Galaxy 的终局则是：

> **当一个人、Agent、团队或工具需要被判断时，Galaxy 成为查询“它真正做过什么”的可信信息入口。**

因此，未来任何新功能都应该问：

> **它是否增加了真实 Evidence 的数量、质量、可验证性、可查询性或跨场景价值？**

如果没有：

> 它就不应该抢占 Galaxy Core 的优先级。

---

# 612. 给未来所有项目文档的固定首页说明

建议以后每份 Galaxy 文档首页都包含下面这段，避免再次发生根本误解：

> **重要：Galaxy 不是一个让用户填写职业履历后寻找任务的平台。普通用户和专家第一次安装 Galaxy-compatible 客户端时会自动获得唯一 Node ID，不需要前置注册或填写简历。Galaxy 的 Coding 早期入口也不是普通疑难，而是用户正在使用 Codex、Claude Code、Cursor 等 AI 工具处理真实任务，AI 已经多轮尝试并持续失败、达到 Failure Threshold 以后才触发的低打扰 Escalation。用户确认外发后，人、Agent、团队或工具可以介入。Task、Attempt、Result、Verification 和 Evidence 会由系统尽可能自动记录，并形成参与 Node 的长期 Track Record；Profile、Reputation、Ranking 和 Honor 都主要从这些真实历史派生，而不是由用户手工编写。Open Assistance 和 Bounty 是促成 Resolution 的机制，交易可以在 Galaxy 外发生；Worker、Hub、Bridge 和 Federation 是接入与扩张机制。Galaxy 真正的核心是可验证能力历史，终局是成为“谁真正做过什么”的能力事实信息入口。**


# 613. 查漏补缺审计：为什么上一版会被误读

为了让未来不再出现同类问题，本节对上一版的结构性缺失逐条审计。

## 613.1 缺失：无感 Node Creation 没进入数据模型首页

上一版从 `Node` 的定义开始，但没有先回答：

> Node 是怎么来的？

这给阅读者留下了传统 SaaS 默认：

```text
注册账号
↓
创建 Node
```

的想象空间。

本版明确：

```text
安装
↓
本地自动 Node ID
```

这是第一事件。

---

## 613.2 缺失：Identity 存在与 Identity Verification 没充分区分

上一版容易让人觉得：

> Identity 是一个用户要主动完成的验证模块。

现在区分：

```text
Existence
Binding
Verification
Capability Evidence
```

这样“无感注册”和“可信身份”不再冲突。

---

## 613.3 缺失：“履历不是自填”没有成为页面和 API 约束

只在文本里说一句：

> “它不是自填简历”

不够。

如果开发者随后看到：

```text
Profile
Capability
Identity
```

仍可能做一个传统编辑页面。

本版因此新增：

- Profile = Projection；
- Track Record 不允许普通手填；
- Self-asserted Claim 独立；
- History 自动 Event-driven 生成；
- 验收条件明确禁止手动添加 Verified Experience。

---

## 613.4 缺失：高失败入口在数据模型中权重太低

上一版的数据对象顺序：

```text
Node
Identity
Capability
Task
FailureEvent
```

会让读者认为：

> Failure 只是 Task 的一种辅助字段。

本版产品叙事顺序改为：

```text
Install
Auto ID
Normal AI Work
Repeated Failure
Escalation
Resolution
Track Record
```

让入口逻辑和 Core Data 同时存在。

---

## 613.5 缺失：没有足够强调“不是普通求助”

如果文档只写：

```text
Task / Case
```

第三方自然会把它理解成：

> Stack Overflow / Fiverr / Expert Marketplace 类型需求。

所以本版新增：

> Escalated Case

作为 Coding MVP 的主 Task 类型。

---

## 613.6 缺失：没有解释为什么用户在这个时候愿意求助

项目不是假设：

> 人天生喜欢找陌生专家。

而是：

```text
AI 已多轮失败
↓
时间成本累积
↓
当前方法边际收益下降
↓
外部求助意愿上升
```

Failure Threshold 不只是技术信号，也是：

> 用户意愿过滤器。

---

## 613.7 缺失：无感注册不仅适用于 Requester，也适用于 Expert

如果只给普通用户自动 ID，而专家仍要：

```text
注册 Provider
填写技能
审核
```

网络供给仍然摩擦巨大。

因此本版明确双方一致。

---

## 613.8 缺失：用户和专家不是两个固定用户系统

早期 Bounty 文档使用 Requester / Provider 角色较多。

v3 必须明确：

> 同一 Node 在不同 Task 中角色可变。

这样 History 更像真实职业世界。

---

## 613.9 缺失：Profile 价值验证问题措辞错误

旧版：

> “Node 是否愿意把 Galaxy Profile 当成身份资产？”

这句话没错，但容易进一步被转述成：

> “用户是否愿意维护 Profile？”

本版修改为：

> **系统自动生成的 Profile 是否被 Node 愿意认领、公开、分享和用于外部证明。**

“认领 / 分享”与“手工维护”完全不同。

---

## 613.10 缺失：Evidence Capture 的“自动”程度没有写清楚

正确目标：

```text
CI
Git
Task Events
Attempt Metadata
```

尽可能自动采集。

用户主要做：

> 权限和纠错。

---

## 613.11 缺失：自我声明信息与事实历史 UI 需要明显分层

否则一个 Agent 会认为：

```text
Declared Capability = Track Record
```

本版明确四层：

```text
Self-asserted
Observed
External Verified
Task Evidence Verified
```

---

## 613.12 缺失：无感注册与隐私的冲突没有解决

如果自动 ID = 自动上传：

> 违背早期“外发需授权”。

本版通过：

> Local-first Node ID

解决。

---

## 613.13 缺失：普通成功任务是否进入银河未明确

本版当前立场：

> Coding MVP 优先捕捉 Escalated Hard Case。

普通工作是否同步进入完整职业 History：

> 可以作为未来扩展与用户授权设置，不应影响早期 Wedge。

---

## 613.14 缺失：履历自动形成不等于“后台偷偷记录一切”

本版区分：

```text
Local Observation
Network Evidence
Public Profile
```

防止自动化叙事滑向监控产品。

---

## 613.15 缺失：高失败任务中旧 AI Attempts 也是履历和数据

不是只有：

> 外部专家完成以后的最终 Result。

之前 Agent 的失败也应该作为：

```text
Attempt
FailureEvent
```

进入 Case。

这使 Galaxy 能看到真正的能力边界。

---

## 613.16 缺失：成功专家不是唯一履历受益者

一个复杂 Case：

- 诊断者；
- Reviewer；
- Tool；
- Verifier；
- 最终 Resolver

都可能产生不同类型事实。

---

## 613.17 缺失：交易只是协作事实的一部分

如果新阅读者看到：

```text
Bounty
Deal
```

很容易把项目理解成 Freelancer Market。

本版把：

> Collaboration

放在 Deal 上层。

---

## 613.18 缺失：官方网络不依赖交易抽佣生存的战略表达不够强

现在明确：

> 官方长期更适合成为 Information Services Provider。

---

## 613.19 缺失：Auto ID 带来的用户数量不能作为虚假增长

本版新增：

```text
Generated Nodes
Claimed Nodes
Evidence-bearing Nodes
Verified Nodes
```

不同指标。

---

## 613.20 缺失：首次专家入网的 Profile 可以完全为空

这是一个很重要的产品心理。

网络必须允许：

> 一个真实厉害但从未使用 Galaxy 的人先做事情，再产生历史。

不能因为 Profile 空就认为能力为零。

---

# 614. 查漏补缺审计：此前已确认且本版保留的细节

以下内容在多轮架构变化中容易被新版本遗失，本版全部重新保留。

## 614.1 Failure 信号来源包括模型、规则、上下文、Skill、MCP、插件和信息源

不是只看模型能力。

---

## 614.2 自动检测可关闭

用户可以：

```text
Disable Failure Detection
Snooze
Disable per-project
```

---

## 614.3 Telemetry 不是必须

用户应能控制：

> 是否发送产品 Telemetry。

---

## 614.4 最小权限

选中 Expert 后仍然：

> 只给任务所需 Context。

---

## 614.5 Open Assistance 门槛较低

但不是无风控。

高风险生产环境不适合随便开放。

---

## 614.6 Paid Qualification 需要相关能力历史

不是全账号等级。

---

## 614.7 新 Node 可通过外部证据突破冷启动

保留。

---

## 614.8 Contribution 不等于 Reputation

保留。

---

## 614.9 Ranking 不等于 Qualification

保留。

---

## 614.10 Result 与 Verification 分离

保留。

---

## 614.11 Capability Reputation 与 Global Reliability 分离

保留。

---

## 614.12 Requester Reputation

保留。

---

## 614.13 Full History 不被 Summary 替代

保留并强化。

---

## 614.14 Capsule 可以作为 Evidence

保留。

---

## 614.15 Discovery / Matching / Recommendation / Selection / Routing 分离

保留。

---

## 614.16 Human Selection 优先

保留。

---

## 614.17 Selection Logs 从第一天保存

保留。

---

## 614.18 Graph DB 后置

保留。

---

## 614.19 Settlement Asset-agnostic

保留。

---

## 614.20 Native Token 非 MVP

保留。

---

## 614.21 Open Source / Official Free / Official Paid 分离

保留。

---

## 614.22 Official Hub 不是唯一网络

保留。

---

## 614.23 第三方 Hub 可自主品牌和商业规则

保留。

---

## 614.24 Direct Federation 不强制 Official Fee

保留。

---

## 614.25 Bridge 允许其他生态不迁移

保留。

---

## 614.26 MCP / A2A 等作为外部协议兼容

保留。

---

## 614.27 Public / Private / Proof-only 等多级 Visibility

保留并扩展。

---

## 614.28 External History Import

保留。

---

## 614.29 履历可携带

保留为长期目标。

---

## 614.30 Agent Career History

扩展为：

> Unified Capability History。

---

# 615. 新 Agent 最容易犯的十类推理错误

## 615.1 因为看到 Identity，就假设注册页面

禁止。

## 615.2 因为看到 Profile，就假设用户填写简历

禁止。

## 615.3 因为看到 Task，就假设普通疑难求助

Coding MVP 错误。

## 615.4 因为看到 Bounty，就假设佣金模式

错误。

## 615.5 因为看到 Worker，就假设 Agent 是主体核心

错误。

## 615.6 因为看到 Human，就假设只是兜底

错误。

## 615.7 因为看到 Reputation，就设计一个全球分数

错误。

## 615.8 因为看到 Federation，就先做 P2P 网络

错误优先级。

## 615.9 因为看到 AI Failure，就每次错误弹窗

错误。

## 615.10 因为看到自动生成履历，就自动上传所有工作内容

严重错误。

---

# 616. 推荐的未来 PRD 首页 Checklist

任何 PRD 在进入功能前必须回答：

```text
首次安装是否仍然 Zero-form？
Node ID 是否自动生成？
功能是否依赖用户手填履历？
是否保持 Escalated Hard Case 早期入口？
是否保护外发授权？
是否同时支持 Human 与 Agent？
是否从真实事件产生 Evidence？
是否把评分和事实分离？
是否让 Marketplace / Federation 抢走 Core 优先级？
```

只要其中有明显偏离：

> 应先重新审视需求。

---

# 617. 推荐的开发 Code Review Checklist

Identity：

```text
是否不需要注册表单？
是否能本地生成 ID？
```

History：

```text
是否由事件自动创建？
是否能追踪来源？
```

Privacy：

```text
是否未经授权上传敏感 Context？
```

Failure：

```text
是否有 Threshold 和 Cooldown？
```

Evidence：

```text
是否有 Source / Verification？
```

Profile：

```text
是否只是 Projection？
```

---

# 618. 推荐的数据质量 Checklist

每一条强 Track Record 应尽量能回答：

```text
Who?
What Task?
What Capability?
What Attempt?
When?
Under what context?
What Outcome?
Who verified?
What Evidence?
What source?
```

---

# 619. 推荐的产品体验 Checklist

用户是否需要：

```text
填很多表单？
```

如果是：

> 重新设计。

用户是否在普通小错误时被打扰？

如果是：

> Threshold 需要提高。

用户卡住时是否要重新写问题？

如果是：

> Draft Automation 不够。

专家是否先被要求做 Profile？

如果是：

> 无感入网被破坏。

---

# 620. 推荐的网络质量 Checklist

不要只问：

```text
多少 Nodes？
```

要问：

```text
多少 Evidence-bearing Nodes？
多少 Strong Verified Track Records？
多少 Independent Counterparties？
多少 Hard Cases？
```

---

# 621. 推荐的信息入口 Checklist

用户 Search 时是否能看到：

```text
相关真实历史
证据来源
时间
失败 / Partial
```

如果只有：

```text
简介 + 星级
```

Galaxy 核心没有体现。

---

# 622. 推荐的开源生态 Checklist

第三方是否能：

```text
生成兼容 Node ID
生成 Evidence
自托管 Core
导出 Proof
```

如果只能调用官方 API：

> 开放性不足。

---

# 623. 推荐的未来商业化 Checklist

任何收费功能不能：

> 破坏事实可信性。

不能卖：

```text
虚假 Expert Badge
搜索结果暗中按付费排名却伪装成能力
付费删除真实失败
```

否则长期价值被透支。

---

# 624. 事实层与广告 / 商业排序分离

如果未来存在：

> Sponsored Provider。

必须明确标注。

不能把商业付费混进：

> Evidence-derived Ranking。

---

# 625. 用户可纠正系统自动分类

AI 自动把 Task 分类为：

```text
PostgreSQL Replication
```

如果用户 / Expert 发现错误：

> 可以提交 Correction。

Correction 也应有 Event。

---

# 626. 自动履历不是“机器永远正确”

系统可以错。

所以：

```text
Auto-generated
+
User correction
+
Evidence
+
Audit
```

共同保证质量。

---

# 627. 争议历史

Requester 说成功，Provider 说成功，但第三方 CI 失败。

可以记录：

```text
Disputed / Conflicting Verification
```

而不是强行选一方。

---

# 628. Galaxy 可以保存不确定性

事实层不需要每件事都变成：

```text
True / False
```

可以：

```text
Inconclusive
Partial
Conflicting
```

---

# 629. 这也是区别于简单评分系统的地方

真实工作复杂。

Galaxy 应允许复杂事实存在。

---

# 630. 最后的架构优先级再次固定

## Tier 0：绝对核心

```text
Auto Node ID
Failure Escalation
Task
Attempt
Verification
Evidence
Track Record
```

## Tier 1：直接价值

```text
Profile
Search
Open Assistance
Basic Bounty
Requester History
Honor
```

## Tier 2：扩张

```text
Worker
External Evidence
Bridge
Hub
Capsule
```

## Tier 3：规模化

```text
Federation
Enterprise
Advanced Search
API
Risk
```

## Tier 4：后期自动化

```text
Settlement
Escrow
Dynamic Routing
Advanced Autonomous Collaboration
```

---

# 631. 如果只能做三个功能

只做：

```text
1. Repeated Failure → Escalation
2. Result / Verification → Auto Track Record
3. Track Record → Similar History Search
```

因为这三件事已经形成：

```text
入口
数据
信息价值
```

---

# 632. 如果只能保存七个对象

保存：

```text
Node
Task
Attempt
Result
Verification
Evidence
TrackRecord
```

其他对象都可后来补。

---

# 633. 如果只能验证一个核心假设

验证：

> **系统自动生成的真实相关履历，是否会让下一位 Requester 更愿意选择某个 Human / Agent。**

这决定信息网络价值。

---

# 634. 但 Failure Wedge 也必须同时验证

因为即使 History 有价值：

> 没有稳定真实 Case 来源，也形成不了网络。

所以最小产品同时验证：

```text
Acquisition
+
History Value
```

---

# 635. 最终 v3.1 对项目的重新表达

Galaxy 不要求用户：

> 加入银河，然后开始经营自己的银河身份。

而是：

> 用户先正常工作；Galaxy 在最需要的时候提供帮助；真实经历随后自然变成身份资产。

这句话非常重要。

---

# 636. 最终 v3.1 产品哲学

> **工作先发生，履历随后自动出现。**

> **困难先真实存在，Galaxy 才介入。**

> **身份先无感存在，信任随后由证据累积。**

> **人和 AI 先共同解决问题，系统再根据事实形成能力网络。**

---

# 637. 最终 v3.1 信息哲学

> **不相信声明本身，相信有来源的经历。**

> **不迷信单一评分，保留上下文。**

> **不因为失败不好看就删除失败。**

> **不因为模型升级就丢弃时间和版本。**

---

# 638. 最终 v3.1 开放哲学

> **协议可以开放，事实网络靠时间和真实使用积累。**

> **第三方可以自建，官方靠服务和信息密度竞争。**

> **外部生态无需迁移，Bridge 可以带着 Provenance 接入。**

---

# 639. 最终 v3.1 商业哲学

> **先成为信息入口，再寻找信息增值。**

不是：

> 先设计交易抽成，再寻找用户。

---

# 640. 最终 v3.1 冷启动哲学

> **不要求用户为了未来可能有价值的履历而注册。**

而是：

```text
安装即有 ID
卡住即有价值
解决即有履历
履历有用才传播
```

---

# 641. 本报告作为以后文档的 Source of Truth

当其他旧文档与本报告发生核心定义冲突时：

以下 v3.1 内容优先：

```text
无感 Auto Node ID
履历自动生成
Repeated Failure Early Wedge
Human / Agent Unified Node
History / Evidence Core
Marketplace / Federation 降级
```

旧文档仍可作为：

> 历史决策和扩展模块参考。

---

# 642. 下一份工程文档应如何写

下一份不应该再做宏观项目介绍。

应直接写：

> `GALAXY_CORE_MVP_FLOW_v3.1.md`

并且第一页必须继承：

```text
Auto Node ID
Repeated Failure Trigger
Auto Track Record
```

然后把一个 Coding Case 完整拆成：

```text
本地事件
网络事件
页面
API
数据库写入
隐私授权
Verification
Track Record Projection
```

这样可以直接进入实现，而不会再回到传统注册 / 简历 / Marketplace 的默认模式。

