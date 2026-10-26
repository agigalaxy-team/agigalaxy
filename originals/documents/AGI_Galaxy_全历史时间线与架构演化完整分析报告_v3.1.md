# AGI 银河网络 / Galaxy
# 项目全历史时间线与架构演化完整分析报告
## Full Timeline & Architecture Evolution Analysis Report

**版本：** v3.1  
**整理日期：** 2026-08-26  
**用途：** 交接给后续 Agent / 架构设计 / 产品决策 / 项目历史恢复  
**当前项目阶段：** Galaxy v3 — Verifiable Capability History Network / 可验证能力履历网络

---

# 0. 重要说明：本报告的“完整性”和“原文证据”边界

用户明确要求：

> “你现在仔细阅读这个项目从最开始到现在的聊天记录，按时间线分析，然后尽可能详细的写一份完整的分析报告。不能有细节遗漏，所有引用的内容需要注明原文出处并写出原文内容，因为我要交给一个agent。”

**来源：当前项目对话，用户原文，2026-08-26。**

为了避免伪造历史，本报告把信息分为三类：

### A 类：原始聊天原文，可直接核验

当前项目上下文中能够直接读取到的项目历史聊天片段，包括：

- 2026-08-22 17:53《Token等待利用案例》
- 2026-08-22 20:35《问候交流》
- 2026-08-24 10:30《整理AGI银河项目聊天内容》
- 2026-08-26 当前连续项目对话

本报告对这些内容使用 `[Qxx]` 编号，并在引用时写出**原始用户文本**与来源。

### B 类：此前项目正式文档，可直接核验

当前项目运行环境中存在以下已生成文档：

- `[D03]` `AGI_Galaxy_Network_统一架构文档_v0.3.md`
- `[D04]` `AGI_Galaxy_Network_Project_v0.4.md`
- `[D10-P]` `AGI_Galaxy_Network_Project_Plan_v1.0.md`
- `[D10-R]` `AGI_Galaxy_Network_PRD_SRS_v1.0.md`
- `[D20-P]` `Galaxy_Federation_Project_Plan_v2.0.md`
- `[D20-R]` `Galaxy_Federation_PRD_SRS_v2.0.md`
- `[D21-P]` `Galaxy_Federation_Project_Plan_v2.1_Bounty_Integrated.md`
- `[D21-R]` `Galaxy_Federation_PRD_SRS_v2.1_Bounty_Integrated.md`
- `[D30-P]` `AGI_Galaxy_Network_Project_Plan_v3.0_History_Integrated.md`
- `[D30-M]` `GALAXY_CORE_DATA_MODEL_v3.md`

这些文档是此前聊天讨论的结构化产物，但**不应全部被视为用户逐字原话**。本报告使用它们恢复那些没有完整原始聊天文本、但已经形成正式设计基线的部分。

### C 类：本报告分析

标记为“分析”“判断”“推导”的内容，是对 A/B 两类材料的综合，不是用户原话。

---

# 1. 时间线校正

此前 `[D30-P]` 把部分项目起点写成了“2026-08-23”。

但当前可以直接核验的项目聊天显示：

- 2026-08-22 17:53 已经讨论“统一标准”“AI+真人混合匹配”“插件冷启动”“等待/错误/任务失败侦测”；
- 2026-08-22 20:35 已经明确 Failure Threshold、Capsule、开源/免费/收费边界、完整履历、排行榜、项目命名；
- 2026-08-24 10:30 已经明确 Routing 太难、任务发布/领取/交易应人工选择，以及 Open / Paid Assistance 双层模式。

因此本报告将项目可核验起点修正为：

> **2026-08-22。**

---

# 2. 原始聊天证据索引

下面先给出本报告使用的核心原文证据，便于后续 Agent 直接理解用户真实意图。

---

## Q01 — 想成为“统一标准”的制定者

> “你说的对，我应该做那个统一标准的人，这样我就不怕开源被复制，但是那个标准应该是什么”

**来源：项目对话《Token等待利用案例》，2026-08-22 17:53，用户原文。**

### 直接含义

项目早期已经意识到：

- 仅做一个开源产品容易被复制；
- 需要建立跨系统可复用的标准/协议；
- “标准”最初被视作降低复制风险和建立生态位置的方式。

---

## Q02 — 标准需要解决什么，并且必须支持 AI + 真人

> “你说的很有道理，但我不具备优秀的编程能力，很难做到这么远大的目标。但你也说了，这种事不需要很复杂。所以你可以简单的，不要长篇大论的，和我说说这个标准或者协议解决的问题，适用场景，是否可以ai+真人混合匹配”

**来源：项目对话《Token等待利用案例》，2026-08-22 17:53，用户原文。**

### 直接含义

从一开始：

- 项目就不是纯 Agent 网络；
- Human + AI 混合匹配属于原始需求，而不是后来补丁；
- 用户同时非常在意工程复杂度，希望第一版不要过度宏大。

---

## Q03 — “光是标准不够”：必须有真实技术数据、用户量和平台

> “光是标准不够，我还需要有这些人或ai或被专业化的ai的技术数据，以及真实用户量来构建护城河，而这些都不是标准能解决的，而是平台，但这个平台应该处于一个什么位置，作为codex或claudecode的插件存在？还是其他方式，毕竟我自己没有用户量极大的应用产品，需要借助这些平台，用好的一些插件服务来冷启动，或者作为插件去侦测用户的等待时间或错误或任务失败？或许你有更好的建议？”

**来源：项目对话《Token等待利用案例》，2026-08-22 17:53，用户原文。**

### 直接含义

这是整个项目最关键的早期转折之一：

1. Protocol 本身不是护城河；
2. 真正需要：
   - 人的能力数据；
   - AI / 专业化 AI 的能力数据；
   - 真实用户；
   - 长期平台网络；
3. 自己没有巨大现成用户入口，因此必须：
   - 借助 Codex；
   - Claude Code；
   - 现有 AI 工作流；
4. 插件不只是 UI，还可以：
   - 侦测等待；
   - 侦测错误；
   - 侦测任务失败；
   - 把失败转化为协作入口。

### 历史重要性

这一条原文实际上已经包含后来 Galaxy 的四个核心母题：

```text
标准
+
平台
+
真实数据
+
现有 AI 工作流冷启动
```

---

## Q04 — Failure Threshold 的精确定义

> “不不不，这个失败阈值是指用户在使用比如codex时，由于底层模型、定下的规则、上下文、skill、mcp、插件、信息源导致的一直无法”

**来源：项目对话《问候交流》，2026-08-22 20:35，用户原文。**

### 直接含义

Failure Threshold 从一开始就不是：

- 付款失败；
- 接单失败；
- Marketplace 失败；
- Provider 拒绝。

它是：

> 当前 AI 工作流本身持续无法完成任务。

相关失败来源明确包括：

- 底层模型；
- 规则；
- 上下文；
- Skill；
- MCP；
- 插件；
- 信息源。

后来项目把环境、测试、Build、循环尝试等也纳入这一概念。

---

## Q05 — Capsule 发布者可能转化为 Provider

> “而有了胶囊的发布者就有可能有资格成为接单者”

**来源：项目对话《问候交流》，2026-08-22 20:35，用户原文。**

### 直接含义

Capsule 从一开始不仅是知识库功能，还与：

> “能力证明 → Provider 资格”

存在关系。

后续设计对其进行了约束：

> Capsule 可以成为 Capability Evidence，但不能“一发布就自动获得付费资格”。

---

## Q06 — 开源、官方免费、收费和结算方式必须系统拆分

> “那这个系统各模块哪部分开源，哪部分我免费提供，哪部分收费服务，用什么作为结算单位，token，usdt，美元，平台代币？还是把这部分也做成可选择的聚合模式，也开源自定义？”

**来源：项目对话《问候交流》，2026-08-22 20:35，用户原文。**

### 直接含义

需要严格区分：

```text
Open Source
Official Free
Official Paid
Task Economy / Settlement
```

结算单位从一开始就没有被用户锁定为某种资产，反而考虑：

> 可选、聚合、可扩展、自定义。

因此后续正式形成：

> Protocol-level settlement asset-agnostic。

---

## Q07 — 完整履历不压缩 + 排行榜/等级用于社区凝聚

> “履历相关我之前说过，ai和代码程序，和人不同，人灵活但慢，机器死板但快。ai又快又灵活，所以履历无需压缩，具体准确我在项目中有提到。另外人都有攀比心的，可以做排行榜等公开数据，以及等级制度来强化免费云/社区服务中的信息凝聚力”

**来源：项目对话《问候交流》，2026-08-22 20:35，用户原文。**

### 直接含义

这条包含三个非常稳定的核心思想：

1. **Human / Program / AI 的差异**
   - Human 灵活但慢；
   - Program 快但死板；
   - AI 越来越兼具速度和灵活性。

2. **履历不应压缩**
   - 机器可以处理大量详细历史；
   - 原始 Track Record 应高保真保存。

3. **公开荣誉机制**
   - 排行榜；
   - 等级；
   - 社区比较；
   - 信息凝聚。

后续一直保留：

> 底层高保真，上层动态摘要。

并明确：

> 排行榜 / 社区等级 ≠ 商业资格。

---

## Q08 — 项目品牌

> “我想命名为AGI银河网络，或者你有更好的名字”

**来源：项目对话《问候交流》，2026-08-22 20:35，用户原文。**

随后还有：

> “那你帮我查一下com域名注册情况，以及github项目名”

**来源：同上。**

### 当前状态

“AGI 银河网络 / AGI Galaxy Network”成为长期项目名。

但：

- 最终英文品牌；
- `.com`；
- GitHub Organization / Repository

仍没有在当前可访问历史中恢复出最终确定结果。

---

## Q09 — Routing 太难，任务发布/领取/交易应人工选择

> “路由这一点是否太难了，而且涉及到付费，这里的任务发布，任务领取，交易这些环节是否要改为人手动选择”

**来源：项目对话《整理AGI银河项目聊天内容》，2026-08-24 10:30，用户原文。**

### 直接含义

这是“Human Selection”正式上升为第一阶段核心的来源。

后续形成：

```text
Discovery
↓
Matching
↓
Recommendation
↓
Human Selection
↓
Execution
```

而不是：

```text
Task
↓
Auto Routing
↓
Auto Deal
↓
Auto Payment
```

---

## Q10 — 免费协助 / 付费协助双层

> “改为两个层级，免费协助和付费协助，免费的门槛较低，付费的门槛需要有一定的历史履历。你觉得呢，有没有更好的方式”

**来源：项目对话《整理AGI银河项目聊天内容》，2026-08-24 10:30，用户原文。**

### 后续正式化

后来明确：

```text
Open Assistance
=
免费/开放协助

Paid / Verified Assistance
=
有商业价值的协助

Verified Capability
=
某一具体能力的商业准入
```

并进一步修正：

> 付费资格不能按账号总等级，而必须绑定具体 Capability。

---

## Q11 — 开源内容缺乏吸引力，提出 24×7 专业 Agent 和第三方服务商

> “现在做另一个事情，开源的内容似乎没有多少吸引力，我需要再增加另外的系统来增强这一点，开源的别人可以部署的内容，首先是自己的定制的专业的agent可以根据部署的开源模块去24小时接任务。这是用户端，或者你有更好的方式或想法。还有就是除了官方银河网络以外的其他服务商，也可以提供类似的服务，并且可以通过对应开源模块直接对接银河官方的资源，不过有一定的服务费，或互相有个什么协议来共享信息资源。或者你有更好的能够联动其他第三方开源AGI网络，达成迅速裂变的效果。”

**来源：当前项目对话，2026-08-26，用户原文。**

### 直接产物

由此形成：

- Galaxy Worker；
- Galaxy Hub；
- Galaxy Bridge；
- Galaxy Federation；
- Worker Packs；
- Federation Peering；
- 第三方独立经营；
- Direct Federation；
- 官方公共基础设施服务。

---

## Q12 — Federation 文档仍遗漏赏金和“前期不可全自动”

> “更多的细节没有写进去，特别是赏金任务相关的机制，以及之前聊过的，不可以全自动，前期可以只做撮合交易。你再次回顾整个项目记录，梳理丢失的信息，有一些我没有提到的，补充进新的计划书和需求文档。然后重构这两个文档发我”

**来源：当前项目对话，2026-08-26，用户原文。**

### 直接产物

Federation v2.1 重新恢复：

- Bounty Task；
- Fixed / Budget Range / Quote Requested；
- Apply / Offer；
- Shortlist；
- Human Selection；
- Deal；
- 外部 Settlement；
- 不采用抢单制；
- `Auto Apply ≠ Auto Deal`；
- 前期 Platform = Brokerage，不做自动经济系统。

---

## Q13 — 请求实时竞品、淘汰风险与项目可持续性评估

> “查询目前的实时公开资料，有没有竞品，我这个项目立项到落地所需时间，以及是否会因为大模型进化而淘汰，这个项目是否可持续发展
继续搜索然后根据实时资料，客观甚至苛刻的分析，这个项目是否值得做”

**来源：当前项目对话，2026-08-26，用户原文。**

### 结果

竞品分析暴露：

- A2A / AGNTCY 正在占据 Agent 通信/发现/联邦基础设施；
- TaskBounty / ClawHunt 等已经覆盖 Agent Bounty；
- LinkedIn / Upwork 在身份、履历、AI 工作流人才发现方面具有巨大优势；
- “再做一个 Marketplace / Federation / Agent Directory”差异化不足。

这一阶段触发 Galaxy 的第一次真正战略危机和 v3 重构。

---

## Q14 — 用户纠正：入口是“失败率极高的高难问题”，Human 不可缺失，核心是履历银河

> “你说的内容里面都是a2a相关的agent和agent的事情，但我的观点是，这件事离不开人，因为我聚集的不是agent执行任务中失败的时候请求协助，而是失败率极高的时候触发的高难度问题来作为入口，我要的不是这个交易佣金，我要的是用户，要的是数据资产，我要的目标是那个履历带来的价值，银河网络的价值不是赏金交易，是那个履历形成的银河。你评估一下，不要奉承”

**来源：当前项目对话，2026-08-26，用户原文。**

### 这是 v3 的决定性转折

这一条明确否定了几个此前被过度强化的方向：

```text
Agent-first        → 否
交易佣金-first     → 否
赏金 Marketplace   → 只是手段
Federation-first   → 否
```

并明确：

```text
高失败、高难问题
↓
Human / AI / Tool 真实介入
↓
履历
↓
数据资产
↓
银河
```

---

## Q15 — Node 不是 Agent，交易不参与，核心是身份/履历/荣誉/信息入口

> “你说的预测成功解决问题，这个其实我认为并非是需要agent作为主要判断对象，而是以这个履历所有者是否能完成，我不在乎他是不是agent，他可以是人。双方发生交易我也不参与，我要的是他们交易过程这个平台，以及他们身份证明，履历，荣誉，等，我成为信息入口。增值服务自然就不难找”

**来源：当前项目对话，2026-08-26，用户原文。**

### 直接含义

最终主体变成：

> **Capability Owner / Node**

可以是：

- Human；
- Agent；
- Team；
- Organization；
- Tool；
- Service。

平台不需要控制支付，而需要掌握：

```text
Identity
Collaboration Process
Task
Attempt
Result
Verification
Track Record
Honor
```

最终目标：

> **成为信息入口。**

---

## Q16 — LinkedIn / Upwork 竞争导致信心下降，需要重构

> “你提供的领英，upwork的信息很有帮助，但我现在损失了信心，我得重新优化架构”

**来源：当前项目对话，2026-08-26，用户原文。**

### 直接结果

Galaxy 从：

> Agent / Bounty / Federation Platform

进一步收缩为：

> **Verifiable Capability History Network**

并提出：

> 不要求所有工作必须发生在 Galaxy 内，外部真实 Evidence 也可进入 Galaxy。

---

## Q17 — 下一步先做核心闭环，不要复杂

> “那你写一下下一步，给我一个大概的概念，不需要太复杂”

**来源：当前项目对话，2026-08-26，用户原文。**

### 直接结果

确定 v3 最小核心对象：

```text
Node
Identity
Capability
Task
Attempt
Result
Verification
Track Record
Honor / Reputation（派生）
```

并把第一目标变成：

> **把一次真实工作变成可信、长期可积累的能力履历。**

---

## Q18 — 要求重新按全历史重构计划书

> “重新回顾我们这个项目的所有聊天细节，不能遗漏，按时间线分析，然后给我一份最新的计划书，.MD格式”

**来源：当前项目对话，2026-08-26，用户原文。**

直接产生 `[D30-P]`。

---

## Q19 — 下一步仍要仔细阅读全部聊天记录

> “继续下一步，但是下一步也需要仔细阅读之前的聊天记录，确保没有任何遗漏，综合分析。开始”

**来源：当前项目对话，2026-08-26，用户原文。**

直接产生 `[D30-M] GALAXY_CORE_DATA_MODEL_v3.md`。

---

# 3. 项目第一阶段：从“AI 等待/失败”发现需求入口
## 时间：2026-08-22

---

## 3.1 项目不是从 Marketplace 出发

根据 `[Q03]`，最早的问题是：

> 没有巨大现成用户量时，如何借助 Codex、Claude Code 等现有平台冷启动？

用户主动提出：

> “作为插件去侦测用户的等待时间或错误或任务失败？”

因此第一原始闭环实际上是：

```text
Existing AI Workflow
↓
Wait / Error / Repeated Failure
↓
Galaxy Detection
↓
External Capability
```

### 分析

这与普通 Freelancer Marketplace 的根本不同是：

Marketplace 通常等用户主动来到平台发布需求；

Galaxy 最初的思路是：

> **在真实工作流中自动发现“协助需求已经产生”。**

因此 Failure Trigger 从一开始就是：

- 用户获取机制；
- Task Capture 机制；
- 高价值场景选择机制。

---

## 3.2 Failure Threshold 的准确边界

依据 `[Q04]`，Failure Threshold 必须绑定：

> AI 工作流无法推进。

后续 `[D03][D04][D10-R]` 将其扩展为可检测信号：

- repeated_same_error；
- repeated_test_failure；
- repeated_build_failure；
- repeated_tool_failure；
- repeated_patch_failure；
- stalled_progress；
- user_reject；
- manual_request；
- context insufficiency；
- MCP / Plugin Failure。

但必须注意：

> 连续失败 ≠ 一定是高难问题。

这个问题直到 v3 才被明确补上 Hardness Qualification。

---

## 3.3 隐私原则从第一阶段就必须成立

虽然最初用户原文没有完整逐字展开全部隐私规则，但 `[D03][D04][D10-R]` 已经反复固定：

> **侦测可以自动，外发必须明确授权。**

应避免自动上传：

- 源代码；
- Prompt；
- Logs；
- Secrets；
- Credentials；
- Environment Variables；
- Internal Data；
- User Context。

Edge 应优先：

```text
Local Analysis
↓
Task Draft
↓
Redaction
↓
Privacy Preview
↓
User Confirm
↓
Send
```

这个设计即使进入 v3 仍完全有效。

---

# 4. 第二阶段：从“协议”到“协议 + 平台 + 数据”
## 时间：2026-08-22

---

## 4.1 统一标准思想

`[Q01][Q02]` 表明用户最初希望：

> 成为定义统一标准的人。

早期标准要解决：

- Identity；
- Capability；
- Task；
- Result；
- Verification；
- History；
- AI + Human 混合匹配。

### 早期价值假设

如果不同系统都能用同一个标准表达：

```text
谁
会什么
需要什么
做了什么
结果如何
```

则 Galaxy 不必依赖某一个封闭应用。

---

## 4.2 “光是标准不够”是项目真正的战略转折

`[Q03]` 是整个项目最重要的原始陈述之一。

用户明确指出：

> “光是标准不够，我还需要有这些人或ai或被专业化的ai的技术数据，以及真实用户量来构建护城河”

这意味着：

### Protocol 解决

```text
Interoperability
```

### Network / Platform 解决

```text
Real Users
Real Tasks
Real Results
Real Histories
Real Capability Data
```

### Data 解决

```text
Trust
Discovery
Long-term Moat
```

因此长期形成：

> **协议开放，真实网络历史和数据形成护城河。**

---

# 5. 第三阶段：Human + AI 的原生混合网络
## 时间：2026-08-22 起，2026-08-26 最终强化

`[Q02]` 已明确提出：

> “是否可以ai+真人混合匹配”

所以 Human 并非竞争分析后临时增加。

只是早期文档中 Agent 语言逐渐过强，直到 `[Q14][Q15]` 用户再次纠正。

---

## 5.1 统一 Node

最终模型：

```text
Node
├── Human
├── Agent
├── Team
├── Organization
├── Tool
├── Service
└── Future Robot
```

Galaxy 不应该首先问：

> “是不是 Agent？”

而应该问：

```text
是谁？
有什么能力？
做过什么？
有什么证据？
当前能力状态是什么？
```

---

## 5.2 Human 的长期角色

项目长期认知已经从：

```text
Agent 主体
Human Fallback
```

修正为：

```text
Unified Capability Network
```

高难问题可以自然出现：

```text
General AI
↓
Specialized AI
↓
Human Expert
↓
Human + AI
↓
Multi-expert Collaboration
```

因此即使未来模型非常强，Galaxy 的 Node 模型仍然成立。

---

# 6. 第四阶段：完整履历成为第一等数据对象
## 时间：2026-08-22 起

`[Q07]` 是这一设计的明确用户原文基础。

用户指出：

> “履历无需压缩”

后续形成稳定原则：

> **底层高保真，上层动态摘要。**

---

## 6.1 Track Record 不应该像传统简历

传统简历：

```text
大量经历
↓
压缩
↓
一页简介
↓
丢失上下文
```

Galaxy：

```text
Full-fidelity History
↓
Structured Storage
↓
Contextual Retrieval
↓
Dynamic Summary
```

---

## 6.2 履历应包含什么

从 `[D03][D04][D10-R][D30-M]` 综合，Track Record 长期需要表达：

### Task

- 类型；
- Capability；
- Difficulty；
- Risk；
- Environment；
- Data Sensitivity。

### Execution / Attempt

- Actor；
- Build / Configuration；
- Tools；
- Skills；
- MCP；
- Model；
- Collaborators；
- Start / End；
- Response Time。

### Outcome

- Success；
- Partial；
- Failure；
- Abandoned；
- Rework。

### Verification

- Requester Acceptance；
- Test；
- Build；
- CI；
- Human Review；
- Peer Review；
- External Attestation。

### Provenance

- Source；
- Issuer；
- Verifier；
- Timestamp；
- Hash；
- Signature。

---

## 6.3 AI / Agent 履历必须版本化

这是 v3 竞争分析后非常关键的新修正。

不能记录：

```text
Agent A = 95 分
```

而必须记录：

```text
Agent A
├── Build 1
│   ├── Model
│   ├── Prompt / Policy
│   ├── Skills
│   ├── MCP
│   └── Tools
└── Build 2
```

因为模型、Prompt、Skill、Tool 改变后：

> 能力状态已经变化。

Human 同样具有时间变化，只是不使用同样的 Build 结构。

---

# 7. 第五阶段：荣誉、排行榜、等级与社区
## 时间：2026-08-22 起

依据 `[Q07]`：

> “人都有攀比心的，可以做排行榜等公开数据，以及等级制度来强化免费云/社区服务中的信息凝聚力”

后续设计把它拆成：

### Contribution

奖励：

- Open Assistance；
- Verification；
- Peer Review；
- Capsule；
- 社区帮助。

### Ranking

例如：

- Capability Ranking；
- Open Assistance Ranking；
- High Difficulty Ranking；
- Recent Performance；
- Capsule Author Ranking。

### Honor

例如：

```text
100 Verified Resolutions
PostgreSQL Top 1%
High Difficulty Specialist
Trusted Reviewer
Open Assistance Contributor
Capsule Author
```

### 关键边界

> **Ranking / Level ≠ Capability Qualification。**

荣誉必须：

> Evidence-backed。

---

# 8. Capsule 的完整演化

依据 `[Q05]`：

> “而有了胶囊的发布者就有可能有资格成为接单者”

---

## 8.1 Capsule 最终稳定定义

> **从真实成功任务中提取的、可复用、可验证的问题解决工件。**

可能包含：

```text
Problem Pattern
Environment
Solution / Strategy
Tools
Skill
MCP
Verification Method
Failure Conditions
Limitations
Version
Source Task
Author
```

---

## 8.2 Capsule 与资格

早期：

```text
Capsule Publisher
→ 可能成为 Provider
```

后续修正：

```text
Capsule
↓
真实复用
↓
再次 Verification
↓
Capability Evidence
```

但：

> **Capsule 不应直接自动授予 Paid Eligibility。**

---

## 8.3 v3 中的最新位置

Capsule 已从交易机制降为：

> **Resolution Knowledge Layer / 真实解决方案知识复用层。**

它不是 MVP 核心，但长期仍重要。

---

# 9. 第六阶段：Open Assistance / Paid Assistance
## 时间：2026-08-24 明确成型

依据 `[Q10]`：

> “改为两个层级，免费协助和付费协助，免费的门槛较低，付费的门槛需要有一定的历史履历。”

---

## 9.1 Open Assistance

不是“垃圾任务区”。

它负责：

```text
New Node
↓
No History
↓
Open Assistance
↓
Real Task
↓
Verification
↓
Track Record
```

所以其真正作用是：

> **Network Onboarding + Proof Generation**

v3 中进一步降为：

> **Track Record Cold-start Mechanism**

---

## 9.2 Paid / Bounty Assistance

早期称：

> Verified Assistance / Paid Assistance

后续 v2.1 为避免概念混淆，拆成：

```text
Bounty Assistance
=
任务是否有经济激励

Verified Capability
=
Provider 在某项能力上是否满足准入
```

---

## 9.3 Capability-specific Qualification

核心模型：

```text
Node
→ Capability
→ Evidence
→ Reputation
→ Qualification
```

而不是：

```text
User
→ Global Level
```

例如：

```text
Python           Eligible
PostgreSQL       Eligible
Security Audit   Not Eligible
```

---

## 9.4 新人死锁问题

不能出现：

```text
无履历
→ 无法接付费任务
→ 永远无法获得履历
```

因此证据来源可以包括：

- Open Assistance；
- Galaxy 内部真实任务；
- GitHub / Open Source；
- External Projects；
- Enterprise Attestation；
- Capability Challenge；
- Benchmark；
- Capsule Verification；
- Bridge-imported Evidence。

---

# 10. 第七阶段：自动 Routing 被后置
## 时间：2026-08-24

依据 `[Q09]`：

> “路由这一点是否太难了，而且涉及到付费，这里的任务发布，任务领取，交易这些环节是否要改为人手动选择”

这是后来项目非常重要的稳定边界。

---

## 10.1 必须区分的五个概念

### Discovery

> 网络里有什么？

### Matching

> 哪些候选满足任务条件？

### Recommendation

> 哪些候选应该优先展示？

### Human Selection

> 用户最终选谁？

### Routing

> 系统自动替用户选择谁？

---

## 10.2 MVP 正确流程

```text
Task
↓
Discovery
↓
Matching
↓
Recommendation
↓
Human Selection
↓
Authorization
↓
Execution
```

---

## 10.3 长期 Routing

可以逐步演化：

```text
Stage 1
Recommendation + Human Select

Stage 2
Policy-assisted Selection

Stage 3
Dynamic Routing
```

但必须有：

> 足够真实历史和 Outcome 数据。

---

## 10.4 Routing 数据从第一天记录

虽然 Routing 不做，但必须保存：

```text
Candidate Set
Ranking
Who Viewed
Who Shortlisted
Who Selected
Original Rank
Manual Override
Outcome
```

因此：

> **Routing 后置，Routing 数据不后置。**

---

# 11. Result 与 Verification 的分离

这是 v0.3/v0.4/v1.0 反复固定的重要对象关系。

```text
Result
=
Provider 提交了什么

Verification
=
为什么认为它正确
```

不能：

```text
Provider says done
=
Success
```

Verification 类型长期包括：

- Requester Confirmed；
- Automated Test；
- Build；
- CI；
- Peer Review；
- Human Review；
- Agent Verifier；
- External Attestation；
- Production Validation。

---

# 12. 双向信誉体系

---

## 12.1 Capability Reputation

按能力维度：

```text
Python        97
PostgreSQL    94
Linux         91
Security      62
```

---

## 12.2 Global Reliability

描述：

- 失联；
- 取消；
- 恶意行为；
- 欺诈；
- 一般履约可靠性。

---

## 12.3 Requester Reputation

Requester 同样是 Node。

可以记录：

- 任务描述质量；
- 取消率；
- 平均验收时间；
- 争议率；
- 恶意任务；
- Settlement Confirmation（如果有）。

最终：

> Trust 必须双向。

---

# 13. 开源 / 官方免费 / 官方付费 / 任务经济必须彻底分开

依据 `[Q06]`，这是用户早期就提出的关键业务问题。

最终形成四个正交维度：

```text
Open Source
=
代码、协议是否可部署

Official Free
=
是否免费使用官方托管服务

Official Paid
=
官方高级增值服务

Open / Bounty Assistance
=
某个具体任务的经济模式
```

不得混淆。

---

# 14. Settlement 的演化

用户曾考虑：

```text
Token
USDT
USD
Platform Token
聚合 / 自定义
```

最终项目反而逐步把 Settlement 降级。

---

## 14.1 v1 阶段

协议 Asset-agnostic：

```text
amount
asset
network
payment_method
status
```

---

## 14.2 v2.1 阶段

明确：

```text
Deal
≠
Settlement
```

MVP 可以：

```text
external
manual_record
not_required
```

平台暂不承担：

- Wallet；
- Escrow；
- Refund；
- FX；
- Tax；
- Cross-border Payment。

---

## 14.3 v3 阶段

依据 `[Q15]`：

> “双方发生交易我也不参与”

因此 Settlement 进一步成为：

> 外围可选数据。

Galaxy 真正需要的是：

> Collaboration / Result / Verification / Track Record。

---

# 15. 开源吸引力危机与 Galaxy Worker
## 时间：2026-08-26

依据 `[Q11]`：

> 开源协议 / SDK 本身吸引力不足，需要让开发者部署自己的专业 Agent 24×7 接任务。

于是产生：

# Galaxy Worker

---

## 15.1 Worker 的价值

开发者可以：

```text
Deploy Specialized Agent
↓
24×7 Task Watch
↓
Capability Match
↓
Policy Filter
↓
Auto Apply
↓
Wait for Selection
↓
Execute
↓
Result
↓
Track Record
```

---

## 15.2 Worker 自动化边界

可自动：

- 发现；
- 筛选；
- 匹配；
- Auto Apply；
- Quote Suggestion。

不能默认自动：

- 成交；
- 付款；
- 获得敏感权限；
- 高风险生产操作。

因此：

> **Auto Apply ≠ Auto Deal。**

---

## 15.3 Worker Packs

为避免“开源下载后只有空壳”，提出：

- Python Debug Worker；
- PostgreSQL Worker；
- Linux Worker；
- Test Fix Worker；
- Code Review Worker；
- API Debug Worker。

v3 中：

> Worker 被降为 Agent Node 的 Runtime，而不是 Galaxy Core。

---

# 16. Galaxy Hub / Federation / Bridge
## 时间：2026-08-26

`[Q11]` 同时提出：

> 其他服务商可以提供类似官方 Galaxy 服务，并连接官方资源或共享信息资源。

---

# 16.1 Galaxy Hub

第三方可拥有自己的：

- 品牌；
- 用户；
- Worker；
- Human Provider；
- Tasks；
- Reputation；
- Ranking；
- Community；
- Fee Policy；
- Data Policy。

当时的核心思想：

> 第三方不是官方渠道商，而是独立网络经营者。

---

# 16.2 Galaxy Federation

多个 Hub 可以：

```text
Hub A ↔ Hub B
```

不强制经过 Official Hub。

---

## 16.3 Direct Federation 不收官方协议税

如果双方直接通信，没有使用官方服务：

```text
Official Fee = 0
```

官方收费必须对应真实提供的：

- Global Discovery；
- Relay；
- Trust；
- Verification；
- Hosted Hub；
- Settlement。

---

## 16.4 Federation 共享 Evidence，不共享绝对分数

跨 Hub 优先交换：

```text
Task Evidence
Result
Verification
Attestation
Track Record Proof
```

而不是：

```text
Official Global Reputation Score
```

这形成核心原则：

> **Evidence 是事实，Reputation 是 Local View。**

---

# 16.5 Galaxy Bridge

目标：

> 已有网络无需迁移就可以加入。

映射：

```text
Their Identity → Galaxy Identity / Evidence
Their Agent    → Galaxy Node / Capability
Their Task     → Galaxy Task
Their Result   → Galaxy Result
Their History  → Galaxy Evidence
```

v3 中其战略角色进一步明确：

> **External Evidence Adapter。**

---

# 17. Federation v2.0 的问题：基础设施反客为主

v2.0 将项目组织成：

```text
Galaxy Edge
Galaxy Worker
Galaxy Hub
Galaxy Bridge
Galaxy Federation
```

其优点：

- 开源生态更强；
- 第三方有经营动机；
- 能形成联邦裂变；
- 官方不再是唯一中心。

但后来用户指出：

> 赏金任务、人工撮合等原始业务机制被弱化。

这直接导致 `[Q12]` 和 v2.1 重构。

---

# 18. Bounty v2.1：重新恢复“任务撮合”机制

---

## 18.1 Bounty 不是抢单

正确流程：

```text
Provider / Worker
↓
Apply / Offer
↓
Candidate Pool
↓
Recommendation
↓
Requester Select
↓
Provider Confirm
↓
Deal
```

而不是：

```text
First Claim
=
Automatic Assignment
```

---

## 18.2 定价形式

v2.1 建议：

```text
Fixed Bounty
Budget Range
Quote Requested
```

暂不做：

- 自动竞价；
- Lowest Bid Wins；
- Reverse Auction；
- Dynamic Auto Pricing。

---

## 18.3 Brokerage-first

依据 `[Q12]`：

> “前期可以只做撮合交易”

因此平台只负责：

- Task；
- Applications；
- Offers；
- Compare；
- Human Selection；
- Deal；
- Result；
- Verification；
- Track Record。

不是资金托管平台。

---

# 19. 实时竞品分析引发架构危机

依据 `[Q13][Q16]`，项目开始主动研究：

- LinkedIn；
- Upwork；
- A2A；
- AGNTCY；
- TaskBounty；
- ClawHunt；
- Agent Reputation / Identity。

---

## 19.1 得到的核心冲击

### Agent Discovery / Federation

已有强标准和生态正在发展，因此：

> Galaxy 不值得重新造通用 Agent 通信和 Directory。

### Bounty / Agent Marketplace

已有直接竞争，因此：

> Worker + Bounty 本身不是护城河。

### LinkedIn

拥有巨大身份和职业图谱。

### Upwork

拥有：

- 真实交易；
- Work History；
- Talent Matching；
- AI Workflow Integration。

因此：

> 如果 Galaxy 只是“AI 卡住后找专家”，Upwork 很容易覆盖。

---

## 19.2 用户的反应

`[Q16]`：

> “我现在损失了信心，我得重新优化架构”

这是 Galaxy 从 v2 向 v3 收缩的直接触发。

---

# 20. v3 决定性重构：Galaxy 的核心不是交易，是履历形成的银河

依据 `[Q14]`：

> “我要的不是这个交易佣金，我要的是用户，要的是数据资产，我要的目标是那个履历带来的价值，银河网络的价值不是赏金交易，是那个履历形成的银河。”

这是整个项目迄今最重要的战略定义之一。

---

# 21. Failure Threshold 的 v3 新解释：Hard Case Capture

早期：

```text
Failure
→ Assistance Trigger
```

v3：

```text
Repeated Failure
↓
Failure Classification
↓
Hardness Qualification
↓
High-information Case
```

也就是说：

> Failure Trigger 不只是找人功能，而是高信息密度 Task Sampling。

---

## 21.1 为什么需要 Hardness Qualification

AI 失败可能因为：

```text
Context
Environment
Tool
Permission
Specification
```

这并不一定代表真正 Capability Gap。

因此 Failure Taxonomy 逐渐形成：

```text
context_failure
environment_failure
tool_failure
permission_failure
specification_failure
capability_failure
knowledge_failure
judgment_failure
execution_failure
verification_failure
unknown
```

Galaxy 最有价值的 Case 更偏向：

- Capability；
- Knowledge；
- Judgment；
- Novel / Complex Resolution。

---

# 22. Attempt 成为一级对象

这是 v3 最重要的数据模型变化。

传统平台：

```text
Task
↓
最终完成者
```

Galaxy v3：

```text
Task
│
├── Attempt 1 — Agent A — Failed
├── Attempt 2 — Agent B — Failed
├── Attempt 3 — Human C — Partial
└── Attempt 4 — Human C + Agent D — Success
```

因此 Galaxy 不只知道：

> 谁成功。

还知道：

```text
谁尝试过
使用什么 Build
为什么失败
什么 Intervention 改变了结果
什么组合成功
```

---

# 23. Intervention / Collaboration 被提升

v3 进一步需要记录：

### Intervention

- Human Review；
- Expert Takeover；
- Agent Takeover；
- Tool Introduction；
- Context Addition；
- Specification Clarification；
- Multi-node Collaboration。

### Collaboration

即使 Galaxy 不参与钱：

> 两个能力主体之间真实协作仍必须被记录。

---

# 24. Result / Resolution 再次分离

v3 继续强化：

```text
Result
=
某 Attempt 提交的输出

Resolution
=
整个 Task 最终是否真正被解决
```

例如：

```text
Result Submitted
```

不一定：

```text
Case Resolved
```

---

# 25. Evidence 成为 Galaxy 最重要的真实性基础

依据 `[Q15]`，如果 Galaxy 不控制交易，那么其核心必须是：

> 身份证明、履历、荣誉和真实协作事实。

这意味着 Galaxy 可以不控制 Money，但必须尽可能控制：

> **Evidence Quality。**

---

## 25.1 Evidence 示例

Coding 领域：

- Git Commit；
- Pull Request；
- Test；
- CI；
- Build；
- Repository；
- Issue；
- Artifact Hash。

其他领域：

- 文件 Hash；
- Enterprise Record；
- External Platform Record；
- Signed Statement；
- Multi-party Attestation。

---

## 25.2 Evidence Strength

`[D30-M]` 当前建议粗粒度：

```text
E0 Self-asserted
E1 Counterparty-confirmed
E2 Externally observed
E3 Machine-verified
E4 Multi-source verified
E5 Strong institutional / cryptographic proof
```

注意：

> Evidence Strength 不是 Reputation Score。

---

# 26. Identity 成为核心层，但不等于 Capability

v3 中 Identity 重新提升。

Human：

```text
Email
GitHub
Organization
Domain
Real-person Verification
Professional Credential
```

Agent：

```text
Owner
Operator
Public Key
Runtime
Build
Model
```

Organization：

```text
Domain
Business Identity
Authorized Signer
```

核心原则仍是：

> **Identity Verified ≠ Capability Verified。**

---

# 27. Galaxy 不要求所有工作必须在 Galaxy 内发生

这是 v3 对 LinkedIn / Upwork 竞争后的重要修正。

旧模型较偏：

```text
Galaxy Task
↓
Galaxy Collaboration
↓
Galaxy Track Record
```

v3：

```text
GitHub
Enterprise
External Marketplace
AI Workflow
Community
Third-party Network
Galaxy Task
        ↓
External Evidence Import / Bridge
        ↓
Galaxy Track Record
```

因此：

> Galaxy 争夺的是事实索引和身份履历，不一定争夺交易发生地点。

---

# 28. External Evidence 必须保留 Provenance

导入外部数据至少记录：

```text
source_system
source_id
issuer
imported_at
verification_level
content_hash
```

不得把：

```text
External Evidence
```

伪装成：

```text
Galaxy Native Strong Evidence
```

---

# 29. Proof-only 与隐私

高价值 Hard Case 往往最敏感。

因此 Galaxy 不能依赖：

> “所有原始内容都进入中央数据库。”

可以只公开：

```text
Capability:
PostgreSQL Replication

Difficulty:
High

Outcome:
Verified Success
```

而不公开：

- 公司名；
- Source Code；
- Logs；
- Host；
- Secret；
- Customer Data。

可见性长期建议：

```text
public
federated
peer_only
counterparty_only
private
proof_only
```

---

# 30. 数据资产法律/授权边界

Galaxy 的数据护城河不能建立在：

> 默认拿用户私密任务训练模型。

必须区分：

```text
Operational Use
Public Display
Network Verification
Research Use
Training Use
Commercial Data Licensing
```

用户加入 Galaxy：

> 不等于自动授予 Training License。

---

# 31. Anti-Fraud 成为核心，而不是外围风控

如果 Galaxy 的目标是：

> “能力事实层”

则最大的死亡方式之一是：

> 履历被刷烂。

必须防：

- Fake Task；
- Fake Collaboration；
- Fake Result；
- Fake Review；
- Self-dealing；
- Sybil；
- Multi-platform Duplicate；
- Fake External Evidence；
- Fake Verification；
- Capsule Farming。

核心工具：

```text
Global IDs
Canonical Hash
Issuer
Verifier
Signature
Provenance
Deduplication
Relationship Analysis
Risk Flags
```

---

# 32. v3 最终核心：Capability History Network

依据 `[Q15]`：

> “我不在乎他是不是agent，他可以是人。”

所以核心不是：

```text
Agent Reputation Network
```

而是：

> **Capability Owner History Network。**

---

## 32.1 v3 五层架构

### Layer 1 — Acquisition / Input

```text
AI Failure
GitHub
Enterprise
Manual
External Platform
```

### Layer 2 — Resolution

```text
Human
Agent
Tool
Open Assistance
Bounty
External Collaboration
```

### Layer 3 — Evidence Production

```text
Task
Failure
Attempt
Intervention
Result
Resolution
Verification
Evidence
Attestation
```

### Layer 4 — GALAXY CORE

```text
Identity
Capability
Full Track Record
Reputation Views
Honor
Capsule
Capability History Graph
```

### Layer 5 — Information Services

```text
Search
Discovery
Compare
Ranking
API
Enterprise
Risk
Benchmark
Analytics
```

---

# 33. Worker / Hub / Bridge / Federation 的 v3 最新定位

---

## 33.1 Worker

旧：

> 开源裂变核心 / Agent 经济节点。

v3：

> **Agent Node 的 Runtime / Provider 接入工具。**

---

## 33.2 Hub

旧：

> Federation 的独立网络经营者。

v3：

> **Local Galaxy Core + Local Policy + Evidence Producer。**

仍可独立运营，但不再定义项目本体。

---

## 33.3 Bridge

旧：

> 第三方 Agent Network 接 Federation。

v3：

> **External Work / Evidence Adapter。**

战略价值反而仍然很高。

---

## 33.4 Federation

旧：

> Galaxy 的整体网络形态。

v3：

> **Evidence / Capability History Federation。**

不再优先交换 Agent 指令，而优先交换：

- Identity Proof；
- Capability Metadata；
- Track Record Proof；
- Evidence；
- Attestation；
- Revocation。

---

# 34. Galaxy 与主要竞品的最终边界

这是项目在竞争压力下形成的重要战略边界。

---

## 34.1 与 LinkedIn

LinkedIn 强在：

```text
Identity
Self-described Career
Social Graph
```

Galaxy 应强在：

```text
Identity
Task-native Work Evidence
Attempt
Result
Verification
```

核心区别：

> “我说我做过什么”

vs

> “系统/证据证明发生过什么”。

---

## 34.2 与 Upwork

Upwork 强在：

```text
Marketplace
Transaction
Platform Work History
```

Galaxy 必须跨平台：

```text
GitHub
Enterprise
AI Workflow
External Marketplace
Galaxy
Third-party Hub
```

理想状态：

> Upwork Work History 未来也可以只是 Galaxy 的一种 Evidence Source。

---

## 34.3 与 Agent Marketplace

Galaxy 不以：

> “找 Agent”

为项目终局。

它统一 Human / Agent / Tool。

---

## 34.4 与 A2A / AGNTCY / MCP

这些更适合承担：

- Agent Communication；
- Agent Discovery；
- Tool Invocation；
- Infrastructure Registry。

Galaxy 不应重新发明这些底层协议。

Galaxy 应更专注：

```text
Task History
Attempt History
Evidence
Capability History
Trust
Information Layer
```

---

# 35. Galaxy 真正的护城河公式

经过全部演化后，项目真正的护城河已经从：

```text
Protocol
```

变成：

```text
Verified Capability History Density
```

可以理解为：

```text
真实能力主体数量
×
真实任务数量
×
Attempt 完整度
×
Verification 强度
×
时间跨度
×
跨平台来源
×
Capability 垂直密度
```

而不是：

```text
注册用户数
或
GMV
```

---

# 36. 最值得保留的“银河”图谱

长期可能形成：

### Identity Graph

谁是谁、由谁验证。

### Capability Graph

谁在哪些能力上有真实 Evidence。

### Task Graph

什么类型问题出现、难度如何。

### Attempt Graph

谁尝试过、怎么尝试、为什么失败。

### Collaboration Graph

谁和谁协作过。

### Evidence Graph

什么事实由什么证据支持。

### Reputation Graph

不同主体如何解释同一 Evidence。

### Capsule Graph

什么解决方案在哪些 Case 被复用。

这才是“银河”最准确的技术隐喻。

---

# 37. Real-world Benchmark 的派生价值

传统 Benchmark：

```text
Fixed Task
Fixed Environment
Fixed Score
```

Galaxy：

```text
Real Task
Real Environment
Real Failure
Real Intervention
Real Outcome
Real Verification
```

因此未来可以派生：

> **Real-world Dynamic Capability Benchmark**

但这个是：

> 数据积累后的高级信息服务。

不是 MVP 的第一目标。

---

# 38. AI Capability Evolution / Human Remaining Advantage

因为 Attempt 必须带：

```text
Actor
Build
Model
Tools
Time
```

所以 Galaxy 长期可以观察：

```text
哪些 Task 以前需要 Human
后来 AI 可以完成？

哪些 Capability 仍需要 Expert？

哪些 Human + AI 组合最佳？

某 Agent Build 是进步还是退化？
```

因此大模型进步并不必然让 Galaxy 失效。

只有当 Galaxy 的价值仍然停留在：

> “这个模型不会，换另一个 Agent”

时才容易被淘汰。

---

# 39. 当前 MVP 核心数据模型

`[D30-M]` 已经把 v3 核心对象收敛为：

---

## 39.1 主体层

```text
Node
Identity
NodeConfiguration
Capability
NodeCapability
```

---

## 39.2 工作事实层

```text
Task / Case
FailureEvent
HardnessAssessment
Attempt
Intervention
Collaboration
Result
Resolution
```

---

## 39.3 可信证明层

```text
Verification
Evidence
Attestation
Revocation
```

---

## 39.4 长期履历和派生层

```text
TrackRecord
ReputationView
Honor
Contribution
RankingView
Capsule
RecommendationLog
SelectionLog
```

---

# 40. 当前最小“银河核心”

如果必须进一步压缩，只需要：

```text
Node
谁

Task
发生了什么

Attempt
谁真正尝试过

Result
做出了什么

Verification
为什么相信

Evidence
证据在哪里

Track Record
事实如何进入长期履历
```

这七个对象是 Galaxy 第一颗真正核心。

---

# 41. MVP 第一闭环

当前最合理的第一个真实 MVP：

```text
1. 用户在 Codex / Claude Code 处理真实 Coding Task

2. 连续失败

3. Edge 发现 Failure Threshold

4. 用户确认形成 Galaxy Case

5. 记录已有 Attempts / Failure Events

6. Human Expert 或 Specialized Agent 介入

7. 产生新的 Attempt

8. 提交 Result

9. Test / CI / Requester Verification

10. Resolution = Resolved / Partial / Failed

11. 生成 Evidence

12. 进入参与 Node 的 Track Record

13. Profile / Search 能够查看相关能力历史
```

---

# 42. 为什么首个垂直领域仍然应该是 Coding

历史上一直没有被推翻的判断。

原因：

- AI Coding 是最自然的 Failure Trigger 场景；
- Codex / Claude Code / Cursor 有入口；
- Task 高度机器可读；
- Git / Commit / PR 有天然 Provenance；
- Test / Build / CI 有强 Verification；
- Human 与 Agent 已真实协作；
- Capability 较容易分类。

早期类别：

- Debugging；
- Test Failure；
- Build Failure；
- PostgreSQL；
- Linux；
- API；
- Dependency；
- Performance；
- Architecture。

---

# 43. MVP 页面无需 Marketplace-first

当前 v3 最小 UI：

### Case View

展示：

```text
Problem
Attempts
Failures
Interventions
Result
Verification
```

### Node Profile

展示：

```text
Identity
Capabilities
Relevant Track Records
Recent History
Evidence
Honor
```

### Search

可以按：

```text
Capability
Similar Task
Environment
Evidence Strength
Recent Activity
```

找 Node。

---

# 44. 12 周验证计划的逻辑

项目当前不应再先开发一年大平台。

建议：

---

## Week 1–2

Core Data Model：

```text
Node
Identity
Capability
Task
Attempt
Result
Verification
Evidence
Track Record
```

---

## Week 3–4

最小 Case + Profile：

```text
Create Task
Add Attempt
Submit Result
Verify
Generate Track Record
Profile View
```

---

## Week 5–6

Coding Strong Evidence：

```text
GitHub
CI
Test
```

---

## Week 7–8

一个 AI Workflow Entry：

```text
Codex / Claude Code / CLI
```

---

## Week 9–10

引入真实：

```text
Human Expert
+
Specialized Agent
```

---

## Week 11–12

验证：

```text
用户会不会看 Track Record？
Evidence 是否改变选择？
Provider 是否愿意分享 Profile？
用户是否回来再次使用？
```

---

# 45. 当前真正应该验证的四个生死假设

---

## A. Evidence Capture

> 用户是否愿意让真实工作留下足够可信的 Evidence？

如果高价值任务都因为隐私无法留下任何可验证事实：

> Galaxy 的 Data Moat 会大幅削弱。

---

## B. Identity / Profile Value

> Human / Agent Owner 是否愿意把 Galaxy Profile 当成长期身份资产？

如果没人愿意展示：

> Honor / Track Record 很难形成网络效应。

---

## C. Information Value

> 下一次选择能力主体时，历史 Evidence 是否真的会改变用户判断？

注意：

Galaxy 不一定需要预测：

> “成功概率 96%”。

它只需要证明：

> 真实历史信息比完全没有信息更有价值。

---

## D. Hard Case Quality

> Failure Threshold 能否持续筛出真正高信息密度问题，而不是 Context / Tool Noise？

如果失败大多只是：

- API Key；
- 权限；
- 环境；
- Prompt；

那么 Hard Case 入口价值会被高估。

---

# 46. 当前 KPI 应重新排序

---

## 46.1 不应优先

- GMV；
- Take Rate；
- Token Volume；
- Agent Registration；
- Raw Task Count。

---

## 46.2 应优先

### Data Quality

```text
Real Cases
Hard Cases
Attempts per Case
Verified Resolutions
Strong Evidence Rate
Evidence Completeness
```

### Network

```text
Verified Nodes
Active Expert Nodes
Repeat Providers
Repeat Requesters
```

### Information Value

```text
Track Record View Rate
Similar-history View Rate
Profile Share Rate
Evidence-influenced Selection Rate
Repeat Search
```

### Hard Case

```text
Failure Trigger Accuracy
Hardness Qualification Rate
Capability-gap Case Ratio
Resolution Rate
```

---

# 47. 当前商业化逻辑

用户 `[Q15]` 已经明确：

> 平台不需要参与交易，目标是信息入口。

因此商业化应更多围绕：

```text
Advanced Identity Verification
Professional Verification
Advanced Search
Capability Discovery
Track Record API
Evidence API
Reputation API
Enterprise Due Diligence
Risk Intelligence
Provider Discovery
Talent Discovery
Agent Discovery
Reputation Monitoring
Enterprise Private Graph
Analytics
Benchmark
Advanced Verification
Hosted Hub
Enterprise Integration
Audit / SLA
```

交易佣金：

> 可以存在，但不是核心依赖。

---

# 48. 当前 Open Source 的真正目的

开源不只是开发者营销。

最新目的：

> **让更多外部系统产生 Galaxy-compatible Evidence。**

因此长期建议开源：

```text
galaxy-core-spec
galaxy-sdk
galaxy-edge
galaxy-worker
galaxy-hub
galaxy-bridge
galaxy-conformance
```

---

# 49. Official Free 的最新目的

官方免费层主要用于提升：

> Identity / Evidence / Track Record Density。

可免费提供：

- Basic Identity；
- Public Profile；
- Capability；
- Open Assistance；
- Basic Bounty；
- Track Record；
- Basic Verification；
- Search；
- Ranking；
- Honor；
- Capsule；
- Worker Registration；
- Evidence Import。

---

# 50. Federation 仍然值得保留，但不再是核心

这是整个 v2 → v3 最重要的“降级而非删除”。

Federation 未来仍能解决：

```text
企业内部 Evidence
第三方平台 Evidence
不同 Hub Evidence
External Identity / Attestation
```

如何进入更大的 Galaxy。

但不应该：

> 先花一年做新的 Agent Internet。

---

# 51. 与以前版本相比，哪些东西“没有被废弃”

重要：v3 不是把过去全删掉。

以下仍然保留：

- Failure Threshold；
- Assistance Trigger；
- Open Assistance；
- Bounty Assistance；
- Human Selection；
- Worker；
- Hub；
- Bridge；
- Federation；
- Capsule；
- Ranking；
- Honor；
- Requester Reputation；
- Capability Reputation；
- External Settlement；
- Recommendation Logs；
- Selection Logs；
- Self-host；
- Official Free / Paid；
- Enterprise；
- Future Routing。

变化只是：

> **它们不再与 Track Record Core 平级。**

---

# 52. 哪些设计被明确降级

---

## 52.1 Agent-first

降级。

Node 统一 Human / AI / Tool。

---

## 52.2 Marketplace-first

降级。

Marketplace / Bounty 是 Evidence Production Mechanism。

---

## 52.3 Transaction Commission-first

降级。

用户明确不以交易佣金为目标。

---

## 52.4 Federation-first

降级。

Federation 是 Evidence 扩张机制。

---

## 52.5 Protocol-first

降级。

标准重要，但“光有标准不够”。

---

## 52.6 Routing-first

后置。

甚至在 v3 中比以前更外围。

---

# 53. 哪些设计被明确否定或暂缓

当前不要优先：

- 新 Agent Communication Protocol；
- 完整 Agent Directory；
- 复杂 DHT；
- Wallet；
- Native Token；
- Escrow；
- Global Auto Payment；
- Automatic Deal；
- Global Reputation Score；
- Dynamic Routing；
- Complex Graph DB；
- 大型 Marketplace UI；
- 强制所有工作在 Galaxy 内发生；
- 强制第三方经过 Official Hub；
- 把所有敏感任务原文集中保存。

---

# 54. 当前真正的产品定位层级

---

## 核心本体

> **Verifiable Capability History Network**

---

## 原始数据

```text
Task
Attempt
Failure
Intervention
Result
Verification
Evidence
```

---

## 长期身份资产

```text
Identity
Track Record
Capability History
Honor
Reputation Views
```

---

## 数据生产机制

```text
Open Assistance
Bounty Assistance
External Collaboration
AI Workflow Capture
GitHub / Enterprise Import
```

---

## 接入机制

```text
Edge
Worker
Hub
Bridge
Federation
```

---

## 商业化

```text
Search
API
Verification
Risk
Enterprise
Analytics
Benchmark
Hosted Infrastructure
```

---

# 55. 当前项目的一句话终极定义

综合用户原文 `[Q03][Q07][Q14][Q15]` 与最新 v3 结构：

> **Galaxy 是一个跨 Human、AI Agent、团队、工具和平台的可验证能力履历网络。它通过真实工作，尤其是 AI 高失败、高难度 Case，记录每一次 Attempt、Failure、Intervention、Result 和 Verification，并把这些事实沉淀成长期身份、能力履历、信誉和荣誉，使 Galaxy 最终成为智能时代查询“谁真正做过什么”的信息入口。**

---

# 56. 最关键的战略逻辑

整个项目真正的逻辑链现在可以写成：

```text
AI 大规模进入真实工作
↓
产生大量真实 Task
↓
其中一部分出现持续失败
↓
Failure Qualification
↓
形成高信息密度 Hard Case
↓
Human / Agent / Tool 介入
↓
记录完整 Attempt Chain
↓
产生 Resolution
↓
Verification
↓
Evidence
↓
Track Record
↓
Identity / Capability History 更可信
↓
Search / Discovery 更有价值
↓
更多主体愿意维护 Galaxy Identity
↓
更多外部平台愿意贡献 Evidence
↓
Verified Capability History Density 提高
↓
Galaxy 成为能力信息入口
```

---

# 57. 当前最大的结构性优势

不是：

> “我们有最好的模型。”

不是：

> “我们有自己的 Marketplace。”

不是：

> “我们有自己的 Agent Protocol。”

而是潜在拥有：

> **跨 Human / AI / Platform 的时间序列真实工作事实。**

如果长期真的积累：

```text
Task
Attempt
Failure
Resolution
Verification
```

并拥有高 Evidence Density：

> 这比普通 Profile、评价、五星 Reputation 更难复制。

---

# 58. 当前最大的结构性风险

---

## 58.1 Evidence 获取难

最有价值 Case 最敏感。

---

## 58.2 Expert 冷启动难

高难问题需要少数真正 Expert。

---

## 58.3 Sybil / 刷履历

如果事实层被污染，整个 Galaxy 价值归零。

---

## 58.4 巨头复制 UI

LinkedIn / Upwork 可以快速复制：

- Profile；
- Badge；
- Search；
- AI Matching。

因此 Galaxy 必须依赖：

> 长期 Task / Attempt / Evidence Graph，而不是 UI。

---

## 58.5 Failure Trigger 可能产生大量 Noise

必须做 Hardness Qualification。

---

## 58.6 数据授权

有数据 ≠ 有训练授权。

---

# 59. 当前真正的护城河条件

Galaxy 只有同时满足以下条件，数据才真正成为资产：

1. Real；
2. Difficult / Valuable；
3. Outcome-known；
4. Verified；
5. Structured；
6. Provenance-preserved；
7. Time-aware；
8. Cross-platform；
9. Privacy-compatible；
10. Legally usable for the intended purpose。

---

# 60. 当前项目最不可丢失的原则全集

以下是从整个项目演化中应长期保留的原则：

1. **光有标准不够。**
2. **协议开放，但真实历史和网络数据形成护城河。**
3. **插件是入口，不是项目本体。**
4. **Human 是一等能力主体。**
5. **Agent 不是 Galaxy 唯一主体。**
6. **Node 是统一能力主体。**
7. **机器负责高频计算，人负责高风险决策。**
8. **侦测可以自动，外发必须明确授权。**
9. **Failure Threshold 指当前 AI 工作流持续无法推进。**
10. **Repeated Failure 不自动等于 Hard Case。**
11. **必须做 Failure Classification / Hardness Qualification。**
12. **Attempt 是一级核心对象。**
13. **失败本身也是能力数据。**
14. **Result 与 Verification 必须分离。**
15. **Result 与 Resolution 必须分离。**
16. **Identity Verification 不等于 Capability Verification。**
17. **Capability 必须结构化、细粒度。**
18. **Capability Qualification 必须绑定具体能力。**
19. **Reputation 应尽量绑定 Capability。**
20. **Global Reliability 与专业能力分开。**
21. **Requester 也有履历和信誉。**
22. **底层保存高保真履历，上层按场景动态摘要。**
23. **Agent History 必须 Build / Configuration Version-aware。**
24. **Human History 同样具有时间变化。**
25. **Open Assistance 是履历和 Evidence 的冷启动机制。**
26. **免费不等于低质量。**
27. **Bounty 是 Resolution 激励，而不是 Galaxy 核心价值。**
28. **前期不做全自动。**
29. **Provider 可以 Auto Apply，但不能 Auto Deal。**
30. **任务不采用默认抢单制。**
31. **Recommendation 与 Selection 必须分离。**
32. **Routing 后置。**
33. **Routing 数据从第一天保存。**
34. **Deal 与 Settlement 分离。**
35. **Galaxy 可以完全不参与双方资金流。**
36. **交易发生在哪不重要，可信 Collaboration Record 更重要。**
37. **Evidence 是事实，Reputation 是解释。**
38. **跨网络优先共享 Evidence，不共享统一全球分数。**
39. **Ranking / Level 不等于商业资格。**
40. **Honor 必须 Evidence-backed。**
41. **Capsule 是 Resolution 的可复用知识工件。**
42. **Capsule 可以形成 Evidence，但不自动授予 Paid Eligibility。**
43. **外部履历可以导入，但必须保留 Provenance。**
44. **External Evidence 不得伪装成 Galaxy Native Evidence。**
45. **Proof-only 是重要企业隐私模式。**
46. **Operational Data 与 Training License 必须分离。**
47. **开源的目的之一是让外部世界产生兼容 Evidence。**
48. **Worker 是 Agent Runtime，不是 Galaxy Core。**
49. **Hub 是 Local Galaxy / Evidence Producer，不是项目本体。**
50. **Bridge 是外部数据和网络接入机制。**
51. **Federation 是扩张机制，不再是项目核心。**
52. **Direct Federation 不应强制缴纳 Official Protocol Tax。**
53. **不重新发明已有 Agent Communication / Tool Protocol。**
54. **Settlement Asset 不应写死。**
55. **Native Token 不应成为早期前提。**
56. **MVP 不需要 Graph Database。**
57. **第一垂直领域优先 Coding。**
58. **真实强 Verification 比大量弱 Profile 更重要。**
59. **Verified Capability History Density 是核心护城河指标。**
60. **Galaxy 最终目标是信息入口，而不是交易终点。**

---

# 61. 当前仍未最终决定的问题全集

后续 Agent 不应自行假设这些问题已经确定。

---

## 61.1 Brand

- 最终英文品牌；
- `.com`；
- GitHub Organization / Repository；
- 是否继续使用 AGI Galaxy Network。

---

## 61.2 Global Identity

- Node ID；
- VC / DID；
- Key；
- Identity Provider；
- Revocation；
- Identity Portability。

---

## 61.3 Capability Ontology

- 官方 Taxonomy；
- 社区 Extension；
- Hierarchy；
- Synonym；
- Cross-domain Mapping。

---

## 61.4 Failure / Hardness

- Failure Threshold 算法；
- Trigger 权重；
- Hardness Score；
- Noise Filter；
- Capability Gap 判断。

---

## 61.5 Evidence

- E0–E5 是否最终采用；
- 每种行业的 Strong Evidence；
- Proof-only Schema；
- Multi-party Verification；
- External Trust Weight。

---

## 61.6 Track Record

- 必须保存字段；
- 删除权；
- Privacy；
- Immutable Proof 与用户权利冲突；
- Human Time Decay；
- Agent Build Inheritance。

---

## 61.7 Reputation

- 是否公开基础算法；
- Time Decay；
- Difficulty Weight；
- Failure Weight；
- Partial Success；
- Cross-source Weight。

---

## 61.8 Honor / Ranking

- 谁可以签发；
- 如何防刷；
- 是否允许第三方 Honor；
- 时效。

---

## 61.9 Capsule

- 最终 Schema；
- Ownership；
- Licensing；
- Paid Capsule；
- Version；
- Verification Weight。

---

## 61.10 External Evidence

- GitHub；
- Enterprise；
- External Marketplace；
- Agent Network；
- 如何去重；
- 如何证明 Identity Linking。

---

## 61.11 Federation

- 最小 Evidence Federation Protocol；
- Hub Discovery；
- Peering；
- Global Index；
- Trust Policy；
- Conformance。

---

## 61.12 Commercial

- 第一收费项；
- Verification vs API vs Enterprise；
- Hosted Hub；
- 是否未来做 Settlement；
- 是否长期保持交易中立。

---

# 62. 版本演化关系

```text
Early Concept
AI Wait / Failure Capture
        ↓
Protocol Idea
统一描述 Human / AI / Task
        ↓
“光是标准不够”
Platform + Real Data
        ↓
v0.3
Open / Paid Assistance
Track Record
Capability Reputation
Human Selection
        ↓
v0.4 / v1.0
正式 Network + PRD
        ↓
Worker / Hub Idea
开源生产节点 + 第三方运营
        ↓
Federation v2.0
Worker + Hub + Bridge + Federation
        ↓
Bounty v2.1
补回赏金 / 人工撮合 / Deal
        ↓
Competitive Reality Check
LinkedIn / Upwork / Agent Infra
        ↓
v3.0
Capability History Network
        ↓
Core Data Model v3
Node → Task → Attempt → Evidence → Track Record
```

---

# 63. 对历史变化的最终分析

这些架构变化并不意味着项目一直“没有方向”。

更准确的理解是：

项目不断识别出哪些东西：

```text
重要
但不是核心
```

---

## 63.1 Plugin

重要，但只是：

> Acquisition。

---

## 63.2 Bounty

重要，但只是：

> Incentive。

---

## 63.3 Marketplace

重要，但只是：

> Resolution / Evidence Production Environment。

---

## 63.4 Worker

重要，但只是：

> Agent Supply Adapter。

---

## 63.5 Hub

重要，但只是：

> Local Network。

---

## 63.6 Federation

重要，但只是：

> Expansion。

---

## 63.7 Reputation

重要，但只是：

> Derived View。

---

## 63.8 Track Record / Evidence

这是唯一在所有阶段中：

> 越来越核心，而不是越来越外围

的对象。

这说明：

> **Galaxy 真正稳定的产品本体已经逐渐显现。**

---

# 64. 后续 Agent 应采用的工作原则

把本报告交给另一个 Agent 时，应告诉它：

### 不要重新把项目改成 Agent Marketplace。

### 不要重新把 Federation 提升为核心。

### 不要因为 Bounty 易理解就把交易佣金当主商业模式。

### 不要把 Human 当 fallback。

### 不要把 Reputation Score 当底层事实。

### 不要过早自动 Routing。

### 不要为了“Web3 / AGI”加入 Token。

### 不要要求所有工作必须在 Galaxy 发生。

### 不要删除 Attempt / Failure 历史。

### 不要只存成功结果。

### 不要把 Agent 不同 Build 混成同一个静态能力。

### 不要忽视 Requester Reputation。

### 不要自动外发敏感工作上下文。

### 不要把所有原始数据默认授权给训练使用。

---

# 65. 后续 Agent 当前应该优先完成什么

基于 `[D30-M]`，下一份真正有开发价值的文档应该是：

> **GALAXY_CORE_MVP_FLOW_v3.md**

只解决一个 Coding Hard Case：

```text
AI Failure
↓
Task / Case
↓
Attempt Chain
↓
Human / Agent Intervention
↓
Result
↓
Verification
↓
Evidence
↓
Track Record
↓
Profile / Search
```

需要具体定义：

- 页面；
- 状态机；
- API；
- Event；
- 最小 DB 写入；
- Evidence Capture；
- Privacy；
- 一个 End-to-End Test；
- MVP 验收标准。

---

# 66. 最终结论

从 2026-08-22 的最早可核验聊天开始，Galaxy 的原始直觉其实一直很稳定：

1. AI 工作流会遇到失败和停滞；
2. 这些失败可以成为外部能力入口；
3. 能力主体既可以是 AI，也可以是人；
4. 仅有标准没有护城河；
5. 真正需要的是用户、真实数据和长期历史；
6. 完整履历应该被高保真保存；
7. 真实任务比自我声明更能证明能力；
8. 自动 Routing 太复杂，应该后置；
9. 免费协助可以制造第一批真实履历；
10. 赏金可以制造解决高难问题的动力；
11. 交易本身不是最终资产；
12. 最终真正积累的是身份、Attempt、Evidence、Track Record、Honor 和 Capability History。

项目过去最大的偏航风险，是曾经多次把：

```text
Agent
Marketplace
Federation
Bounty
```

当成主角。

用户在 `[Q14][Q15]` 最终把这一点纠正：

> “我要的不是这个交易佣金，我要的是用户，要的是数据资产，我要的目标是那个履历带来的价值，银河网络的价值不是赏金交易，是那个履历形成的银河。”

以及：

> “我不在乎他是不是agent，他可以是人。双方发生交易我也不参与，我要的是他们交易过程这个平台，以及他们身份证明，履历，荣誉，等，我成为信息入口。”

**来源：当前项目对话，2026-08-26，用户原文。**

因此截至当前，Galaxy 最准确的项目定义是：

> **一个跨 Human、AI、团队、工具和平台的可验证能力事实与履历网络。它通过真实任务和高失败 Hard Case 捕捉 Attempt、Failure、Intervention、Result、Verification 与 Evidence，将这些事实长期沉淀为可验证的身份、能力历史、信誉和荣誉，并最终成为智能时代查询“谁真正做过什么”的信息入口。**

这应作为后续任何 Agent、开发者、产品设计者重新进入项目时的最高级上下文。

---

# 附录 A：当前正式文档索引

1. `AGI_Galaxy_Network_统一架构文档_v0.3.md`
2. `AGI_Galaxy_Network_Project_v0.4.md`
3. `AGI_Galaxy_Network_Project_Plan_v1.0.md`
4. `AGI_Galaxy_Network_PRD_SRS_v1.0.md`
5. `Galaxy_Federation_Project_Plan_v2.0.md`
6. `Galaxy_Federation_PRD_SRS_v2.0.md`
7. `Galaxy_Federation_Project_Plan_v2.1_Bounty_Integrated.md`
8. `Galaxy_Federation_PRD_SRS_v2.1_Bounty_Integrated.md`
9. `AGI_Galaxy_Network_Project_Plan_v3.0_History_Integrated.md`
10. `GALAXY_CORE_DATA_MODEL_v3.md`

---

# 附录 B：最核心用户原文快速索引

### 标准
> “我应该做那个统一标准的人”

来源：`[Q01]`

### 标准不够
> “光是标准不够，我还需要有这些人或ai或被专业化的ai的技术数据，以及真实用户量来构建护城河”

来源：`[Q03]`

### 插件冷启动
> “作为codex或claudecode的插件存在？……或者作为插件去侦测用户的等待时间或错误或任务失败？”

来源：`[Q03]`

### Failure Threshold
> “这个失败阈值是指用户在使用比如codex时，由于底层模型、定下的规则、上下文、skill、mcp、插件、信息源导致的一直无法”

来源：`[Q04]`

### 完整履历
> “履历无需压缩”

来源：`[Q07]`

### 排行榜
> “人都有攀比心的，可以做排行榜等公开数据，以及等级制度来强化免费云/社区服务中的信息凝聚力”

来源：`[Q07]`

### Human Selection
> “任务发布，任务领取，交易这些环节是否要改为人手动选择”

来源：`[Q09]`

### Open / Paid
> “改为两个层级，免费协助和付费协助”

来源：`[Q10]`

### Worker / Hub / Federation
> “自己的定制的专业的agent可以根据部署的开源模块去24小时接任务……其他服务商，也可以提供类似的服务”

来源：`[Q11]`

### 不可全自动
> “不可以全自动，前期可以只做撮合交易”

来源：`[Q12]`

### 履历才是银河
> “我要的不是这个交易佣金，我要的是用户，要的是数据资产，我要的目标是那个履历带来的价值，银河网络的价值不是赏金交易，是那个履历形成的银河。”

来源：`[Q14]`

### Human / Agent 平等
> “我不在乎他是不是agent，他可以是人。”

来源：`[Q15]`

### 信息入口
> “我要的是他们交易过程这个平台，以及他们身份证明，履历，荣誉，等，我成为信息入口。”

来源：`[Q15]`

---

# 附录 C：一句话交接给新 Agent

> **不要把 Galaxy 理解成 Agent 市场。Galaxy 的核心是可验证能力履历：真实 Task 产生 Attempt，Attempt 产生 Result，Result 经过 Verification 形成 Evidence，Evidence 进入 Human / Agent / Team / Tool 的长期 Track Record；Failure Trigger 是高难 Case 入口，Open/Bounty 是解决和激励机制，Worker/Hub/Bridge/Federation 是接入与扩张机制，Search/API/Enterprise 是未来信息价值变现层。**
