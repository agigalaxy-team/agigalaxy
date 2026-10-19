"""Current user-facing pages, separate from immutable release documents.

The renderer uses authored content and local release metadata only. It never
contacts a service, changes a release pointer, or creates a new client package.
"""
from html import escape
import json


def icon(name):
    paths = {
        "search": '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
        "talk": '<path d="M20 11a8 8 0 0 1-8 8H5l-4 3V11a9 9 0 0 1 19 0Z"/><path d="M6 9h9M6 13h6"/>',
        "book": '<path d="M4 3h13a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3M3 17h17M8 7h7M8 11h5"/>',
        "people": '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"/>',
        "arrow": '<path d="M4 12h16m-6-6 6 6-6 6"/>',
        "screen": '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>'


def render_homepage():
    """Authored, explicitly fictional examples with useful content before JS loads."""
    items = {
        'protocol': {'title': '开放协议', 'kind': '项目记录', 'date': '2024 · 05', 'label': '原草案',
                     'excerpt': '身份与贡献保留各自来源，引用后仍能回到原记录。',
                     'question': '开放协议连接了什么？', 'answer': '参与者沿用自己的身份，资料与贡献各自保留来源。'},
        'capability': {'title': '可组合的能力', 'kind': '项目记录', 'date': '2024 · 08', 'label': '适用条件',
                       'excerpt': '个人、工具与自己的 AI 各自参与，组合保留来源与条件。',
                       'question': '不同能力怎样一起参与？', 'answer': '人、工具和自己的 AI 可共同参与，各部分保留来源和适用条件。'},
        'dataset': {'title': '开放数据集', 'kind': '资源', 'date': '2024 · 10', 'label': '原始出处',
                    'excerpt': '示例样本保留地点、日期与出处，只用于当前演示。',
                    'question': '资料怎样被使用？', 'answer': '获准资料可供你的 AI 使用，回答保留可回看的出处。'},
        'contribution': {'title': '身份怎样跨项目沿用？', 'kind': '讨论', 'date': '2024 · 10',
                         'excerpt': '参与者交流身份沿用方式，并引用已有项目说明。'},
        'permission': {'title': '哪些资料可以交给 AI？', 'kind': '讨论', 'date': '2024 · 10',
                       'excerpt': '选择获准的资料，保留原文与适用范围。'},
        'first': {'title': '共同起草开放协议', 'kind': '经历', 'date': '2024 · 05',
                  'excerpt': '这次示例参与关联原草案，保留起草与讨论内容。'},
        'revision': {'title': '补充资料与修订说明', 'kind': '经历', 'date': '2024 · 10',
                     'excerpt': '后续资料仍关联同一身份，原始记录和出处继续保留。'},
    }
    questions = {
        'overview': {'question': '这个项目在做什么？',
                     'answer': '在网络中保留身份、交流与贡献来源，让人和自己的 AI 继续使用已有积累。',
                     'sources': ['protocol', 'contribution']},
        'history': {'question': '经历如何持续积累？',
                    'answer': '实际参与关联同一身份，后续补充保留原来的记录与出处。',
                    'sources': ['first', 'revision']},
        'use': {'question': '我的 AI 如何使用资料？',
                'answer': '你的 AI 在获准范围内使用所选资料，建议保留可回看的来源。',
                'sources': ['dataset', 'permission']},
    }
    materials = {
        'sample': {'title': '观察样本', 'copy': '地点、观察日期、树种与原始出处，都是本次虚构的示例字段。',
                   'source': '来源 · 星河研究的示例样本', 'condition': '范围 · 已选择的演示资料'},
        'method': {'title': '整理方法', 'copy': '先整理字段，再核对原始出处；使用时保留输入要求与适用条件。',
                   'source': '来源 · 字段整理与来源核对', 'condition': '条件 · 公开观察资料'},
    }
    entries = {
        'web': {'label': 'GALAXY WEB', 'title': '直接阅读与交流', 'copy': '浏览内容，在需要时接续身份。',
                'href': '/app/', 'action': '打开网页'},
        'desktop': {'label': 'GALAXY CLIENT', 'title': '在桌面环境中接续', 'copy': '查看现有客户端与宿主支持。',
                    'href': '/downloads/', 'action': '查看客户端'},
        'ai': {'label': 'YOUR OWN AI', 'title': '在原来的对话中继续', 'copy': '使用获准背景，回答保留来源。',
               'href': '/downloads/', 'action': '连接自己的 AI'},
    }
    example = escape(json.dumps({'items': items, 'questions': questions, 'materials': materials,
                                 'entries': entries}, ensure_ascii=False, separators=(',', ':')), quote=True)
    paper = ('<svg class="gh-paper-icon" viewBox="0 0 32 38" aria-hidden="true">'
             '<path d="M5 1h15l8 8v25a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z" fill="currentColor"/>'
             '<path d="M20 1v9h8" fill="#fff" opacity=".65"/><path d="M9 17h12M9 22h12M9 27h8" '
             'fill="none" stroke="currentColor" stroke-width="2" class="gh-paper-lines"/></svg>')

    def record(key):
        item = items[key]
        return (f'<button type="button" class="gh-record" data-gh-record="{key}" aria-expanded="false">'
                f'<span class="gh-record-front"><span class="gh-cover" aria-hidden="true">{paper}'
                f'<strong>{item["label"]}</strong><small>来源仍在</small></span>'
                f'<span class="gh-record-info"><strong>{item["title"]}</strong><small>{item["date"]} · 示例</small></span></span>'
                f'<span class="gh-record-back" hidden><strong>{item["title"]}</strong>'
                f'<span>{item["excerpt"]}</span><small>星河研究 · 再次轻点收起</small></span></button>')

    def discussion(key):
        item = items[key]
        return (f'<button type="button" class="gh-discussion" data-gh-excerpt="{key}" aria-expanded="false">'
                f'<strong>{item["title"]}</strong><small>{item["date"]} · 示例交流</small>'
                f'<span class="gh-excerpt" hidden>{item["excerpt"]}</span></button>')

    def history_record(key):
        item = items[key]
        return (f'<button type="button" class="gh-history-record" data-gh-excerpt="{key}" aria-expanded="false">'
                f'<small>{item["date"]} · 同一示例身份</small><strong>{item["title"]}</strong>'
                '<span class="gh-excerpt-hint">查看这条记录的来源</span>'
                f'<span class="gh-excerpt" hidden>{item["excerpt"]}</span></button>')

    sources = ''.join(
        f'<button type="button" class="gh-source" data-gh-source="{key}" aria-expanded="false"'
        + ('' if key in questions['overview']['sources'] else ' hidden') + '>'
        + f'<strong>{item["title"]}</strong><span data-gh-source-summary><small>{item["kind"]} · 示例原文</small>'
        + f'<small>{item["date"]}</small><small class="gh-source-action">轻点查看原文</small></span>'
        + f'<span class="gh-source-excerpt" hidden>{item["excerpt"]}</span></button>'
        for key, item in items.items())
    records = '<div class="gh-records">' + ''.join(map(record, ['protocol', 'capability', 'dataset'])) + '</div>'
    discussions = '<div class="gh-discussions">' + ''.join(map(discussion, ['contribution', 'permission'])) + '</div>'
    sample = materials['sample']
    return f'''<div class="galaxy-home" data-home-example="{example}">
  <header class="gh-hero">
    <h1><span>开放的身份</span><span>与能力网络</span></h1>
    <div class="gh-hero-actions"><a class="gh-button gh-primary" href="/app/">探索银河</a><a class="gh-button" href="/downloads/">连接我的 AI</a></div>
  </header>
  <section class="gh-demo" aria-label="资料、身份与自己的 AI 交互示例" aria-describedby="gh-example-note">
    <div class="gh-stage-label"><span>交互示例</span><span>资料 · 身份 · 我的 AI</span></div>
    <div class="gh-stage">
      <section class="gh-panel" aria-label="星河研究的示例内容">
        <div class="gh-identity"><span class="gh-monogram" aria-hidden="true">星</span><div><h2>星河研究</h2><p>示例小组 · 身份与记录持续关联</p></div></div>
        <div class="gh-tabs" role="tablist" aria-label="示例内容">
          <button type="button" role="tab" id="gh-tab-records" data-gh-tab="records" aria-controls="gh-panel-records" aria-selected="true">项目记录</button>
          <button type="button" role="tab" id="gh-tab-discussion" data-gh-tab="discussion" aria-controls="gh-panel-discussion" aria-selected="false" tabindex="-1">讨论</button>
          <button type="button" role="tab" id="gh-tab-resources" data-gh-tab="resources" aria-controls="gh-panel-resources" aria-selected="false" tabindex="-1">资源</button>
          <button type="button" role="tab" id="gh-tab-identity" data-gh-tab="identity" aria-controls="gh-panel-identity" aria-selected="false" tabindex="-1">经历</button>
        </div>
        <div class="gh-tab-space">
          <div id="gh-panel-records" role="tabpanel" aria-labelledby="gh-tab-records">{records}<h3 class="gh-subtitle">最近讨论</h3>{discussions}</div>
          <div id="gh-panel-discussion" role="tabpanel" aria-labelledby="gh-tab-discussion" hidden>{discussions}<p class="gh-tab-note">交流可以继续，原有资料也能随时回看。</p></div>
          <div id="gh-panel-resources" role="tabpanel" aria-labelledby="gh-tab-resources" hidden>{records}<p class="gh-tab-note">资料保留各自的出处与适用条件。</p></div>
          <div id="gh-panel-identity" role="tabpanel" aria-labelledby="gh-tab-identity" hidden><div class="gh-history">{history_record('first')}{history_record('revision')}</div></div>
        </div>
      </section>
      <section class="gh-panel gh-ai-panel" aria-label="使用所选资料的 AI 预设演示">
        <div class="gh-ai-header"><div class="gh-ai-heading"><span class="gh-monogram gh-mini" aria-hidden="true">AI</span><h2>我的 AI</h2></div><small>预设演示</small></div>
        <div class="gh-question" data-gh-question-copy>{questions['overview']['question']}</div>
        <div class="gh-answer" data-gh-answer aria-live="polite" aria-atomic="true">{questions['overview']['answer']}</div>
        <div><div class="gh-source-title"><span>使用的来源</span><span>轻点原处查看</span></div><div class="gh-sources">{sources}</div></div>
        <div class="gh-prompts"><span>继续了解</span><div class="gh-prompt-row">
          <button type="button" class="gh-prompt" data-gh-question="overview" aria-pressed="true">项目在做什么</button>
          <button type="button" class="gh-prompt" data-gh-question="history" aria-pressed="false">经历如何积累</button>
          <button type="button" class="gh-prompt" data-gh-question="use" aria-pressed="false">AI 如何使用资料</button>
        </div></div>
      </section>
    </div>
  </section>
  <section class="gh-modules" aria-labelledby="gh-modules-title">
    <div class="gh-section-heading"><h2 id="gh-modules-title">发现银河</h2><p>在每一块里，轻轻试一试</p></div>
    <div class="gh-feature-grid">
      <article class="gh-feature" data-gh-feature="data">
        <button type="button" class="gh-feature-front" data-gh-open="data" aria-expanded="false" aria-controls="gh-data-detail">
          <span class="gh-graphic" aria-hidden="true"><span class="gh-data-piece">观察样本<small>来源 · 星河研究</small></span><span class="gh-data-piece">整理方法<small>条件 · 公开资料</small></span><span class="gh-graphic-label">资料各有来源</span></span>
          <span class="gh-feature-caption"><small>资料</small><strong class="gh-feature-title">组合使用，出处仍在</strong><span>看看样本与方法的原始说明</span></span>
        </button>
        <div class="gh-feature-back" id="gh-data-detail" hidden>
          <div class="gh-feature-top"><h3>资料保留出处</h3><button type="button" class="gh-close" data-gh-close="data" aria-label="收起资料示例">收起</button></div>
          <div class="gh-choice-row" role="group" aria-label="查看示例资料"><button type="button" class="gh-choice" data-gh-data="sample" aria-pressed="true">观察样本</button><button type="button" class="gh-choice" data-gh-data="method" aria-pressed="false">整理方法</button></div>
          <div class="gh-paper-preview" aria-live="polite" aria-atomic="true"><strong data-gh-data-title>{sample['title']}</strong><p data-gh-data-copy>{sample['copy']}</p><small data-gh-data-source>{sample['source']}</small><small data-gh-data-condition>{sample['condition']}</small></div>
          <p class="gh-local-note">示例资料 · 选择只改变这里的预览</p>
        </div>
      </article>
      <article class="gh-feature" data-gh-feature="identity">
        <button type="button" class="gh-feature-front" data-gh-open="identity" aria-expanded="false" aria-controls="gh-identity-detail">
          <span class="gh-graphic" aria-hidden="true"><span class="gh-identity-badge"><span class="gh-monogram gh-mini">星</span>星河研究</span><span class="gh-history-chip">原草案 · 保留来源</span><span class="gh-history-chip">补充说明 · 继续关联</span><span class="gh-graphic-label">同一个身份</span></span>
          <span class="gh-feature-caption"><small>身份</small><strong class="gh-feature-title">换个入口，继续沿用</strong><span>身份与已有记录一起接续</span></span>
        </button>
        <div class="gh-feature-back" id="gh-identity-detail" hidden>
          <div class="gh-feature-top"><h3>同一身份，继续积累</h3><button type="button" class="gh-close" data-gh-close="identity" aria-label="收起身份示例">收起</button></div>
          <div class="gh-choice-row" role="group" aria-label="切换示例入口"><button type="button" class="gh-choice" data-gh-context="web" aria-pressed="true">网页</button><button type="button" class="gh-choice" data-gh-context="agent" aria-pressed="false">Agent</button></div>
          <div class="gh-context" aria-live="polite" aria-atomic="true"><div class="gh-context-heading"><span class="gh-monogram gh-mini" aria-hidden="true">星</span><div><strong>星河研究</strong><small data-gh-context-label>网页入口 · 示例</small></div></div><div class="gh-context-record">原草案 · 来源继续保留</div><div class="gh-context-record">补充说明 · 关联同一身份</div></div>
          <p class="gh-local-note">接续示意 · 同一个示例身份</p>
        </div>
      </article>
      <article class="gh-feature" data-gh-feature="ai">
        <button type="button" class="gh-feature-front" data-gh-open="ai" aria-expanded="false" aria-controls="gh-ai-detail">
          <span class="gh-graphic" aria-hidden="true"><span class="gh-ai-piece">获准的观察样本</span><span class="gh-ai-piece">可引用的整理方法</span><span class="gh-ai-window">我的 AI · 所选资料</span><span class="gh-graphic-label">由你选择资料</span></span>
          <span class="gh-feature-caption"><small>你的 AI</small><strong class="gh-feature-title">建议也带着来源</strong><span>选两份资料，查看组合示意</span></span>
        </button>
        <div class="gh-feature-back" id="gh-ai-detail" hidden>
          <div class="gh-feature-top"><h3>用自己的 AI</h3><button type="button" class="gh-close" data-gh-close="ai" aria-label="收起 AI 示例">收起</button></div>
          <div class="gh-checks" role="group" aria-label="选择获准的示例资料"><label class="gh-check"><input type="checkbox" data-gh-allowed="sample" checked>观察样本</label><label class="gh-check"><input type="checkbox" data-gh-allowed="method" checked>整理方法</label></div>
          <div class="gh-mini-answer" data-gh-mini-answer aria-live="polite" aria-atomic="true">先核对样本出处，再用整理方法处理字段。引用保留来源。</div>
          <div class="gh-mini-sources"><button type="button" class="gh-mini-source" data-gh-mini-source="sample" aria-expanded="false" aria-controls="gh-mini-excerpt">观察样本 · 来源</button><button type="button" class="gh-mini-source" data-gh-mini-source="method" aria-expanded="false" aria-controls="gh-mini-excerpt">整理方法 · 来源</button></div>
          <div class="gh-mini-excerpt-space"><p class="gh-mini-excerpt" id="gh-mini-excerpt" aria-live="polite" hidden></p></div>
          <p class="gh-local-note">预设回答 · 随所选示例资料变化</p>
        </div>
      </article>
    </div>
  </section>
  <section class="gh-community" aria-label="社区入口"><div><h2>交流与分享</h2><p>在社区继续讨论，和更多人交换想法</p></div><a href="/app/community">进入社区 {icon('arrow')}</a></section>
  <section class="gh-connect" aria-labelledby="gh-connect-title">
    <div><h2 id="gh-connect-title">从你熟悉的地方继续</h2><p>入口可以不同，身份和获准的资料继续沿用。</p><div class="gh-entry-options" role="group" aria-label="切换入口演示"><button type="button" data-gh-entry="web" aria-pressed="true">网页</button><button type="button" data-gh-entry="desktop" aria-pressed="false">桌面</button><button type="button" data-gh-entry="ai" aria-pressed="false">自己的 AI</button></div><a class="gh-entry-link" data-gh-entry-link href="/app/">打开网页</a></div>
    <div class="gh-entry-screen"><div class="gh-window-head" aria-hidden="true"><i></i><i></i><i></i><small data-gh-entry-label>GALAXY WEB</small></div><div class="gh-window-content" aria-live="polite" aria-atomic="true"><span class="gh-monogram" aria-hidden="true">星</span><div><strong data-gh-entry-title>直接阅读与交流</strong><p data-gh-entry-copy>浏览内容，在需要时接续身份。</p></div></div><p class="gh-window-caption">星河研究 · 同一个示例身份</p></div>
  </section>
  <p class="gh-footnote" id="gh-example-note">交互示例 · 资料、身份与回答均为预设内容</p>
  <nav class="gh-support-links" aria-label="更多使用入口"><a href="/app/find">搜索公开内容</a><a href="/docs/">使用说明</a><a href="/network/">了解开放网络</a></nav>
</div>'''


def render_product_pages(site):
    page, out = site["page"], site["OUT"]
    preview = site.get("PREVIEW", False)
    metadata = json.loads((out / "release.json").read_text(encoding="utf-8"))
    native = metadata.get("nativeClientDownload", {})
    package = native.get("package", {})
    guides = {kind: native.get("guides", {}).get(kind, f"/docs/native-client-v0.2/{kind}.md")
              for kind in ("installation", "hosts", "runtime")}
    raw_guides = guides
    guides = {kind: site.get('GUIDE_PAGES', {}).get(kind, path) for kind, path in raw_guides.items()}
    arrow = icon("arrow")

    def intro(title, text):
        return f'<header class="reading-intro"><h1>{title}</h1><p>{text}</p></header>'

    def section(title, text, href=None, label=None):
        link = f'<a class="text-link" href="{href}">{label} {arrow}</a>' if href else ''
        return f'<section class="reading-section"><h2>{title}</h2><div>{text}{link}</div></section>'

    page("/", "开放的身份与能力网络", "资料保留来源，身份持续积累，用自己的 AI 继续原来的事情。", render_homepage())

    page("/how-it-works/", "怎样使用银河", "从阅读、交流到使用结果，按自己的需要使用银河。",
        intro("从你正在做的事开始。", "可以只来看看，也可以带着问题和经验，与别人一起往前走。")
        + section("先找找已有的经验", '<p>阅读相关方法、项目和真实经历，判断哪些对自己有用。想进一步了解时，再看完整内容与依据。</p>', "/app/", "发现内容")
        + section("有想法，就聊聊", '<p>在帖子里提问和回复，或与相关的人继续对话。闲聊、分享作品和讨论一个兴趣，都可以独立进行。</p>', "/app/community", "进入社区")
        + section("需要帮助时，说清楚当前目标", '<p>利用已经有的背景准备请求，补上你希望得到的帮助。选择要分享的内容后发布，收到回应再决定怎样继续交流。</p>', "/app/publish", "发起求助")
        + section("把有用的结果带回去", '<p>读到的方法、收到的建议和实际文件都可以回到原来的事情中使用。真实经历保留来处，下一次寻找帮助时也有更多依据。</p>')
        + '<aside class="reading-note"><h2>自己的 AI，自己的选择</h2><p>在具体内容里选择“用自己的 AI 继续”，把这次请求交给已经连接同一银河身份的 AI。它会读取当前允许使用的内容，你可以随时返回原页面接着做。</p><p>你的模型负责理解、整理和建议。银河提供信息、交流和数据服务；手工浏览、发帖和聊天也可以直接使用。</p><a href="/network/">了解开放网络 ' + arrow + '</a></aside>')

    page("/start/", "开始使用", "直接在网页浏览，或从自己的AI工作中使用银河。",
        intro("从方便的地方开始。", "网页可以直接浏览；使用自己的 AI 时，也能从原聊天中进入。")
        + '<div class="entry-choices"><section><span class="purpose-symbol">' + icon("search") + '</span><h2>打开网页</h2><p>找内容、读讨论、看方法。需要参与时再接续身份，完成后回到刚才的内容。</p><a class="button" href="/app/">去看看 ' + arrow + '</a></section>'
        '<section><span class="purpose-symbol">' + icon("screen") + '</span><h2>连接自己的 AI</h2><p>让自己的模型利用当前背景查找帮助，继续同一个目标。</p><a class="text-link" href="/downloads/">查看客户端与安装方式 ' + arrow + '</a></section></div>'
        + section("已经用过银河？", '<p>继续使用原来的银河身份与资料。更换设备时可以由旧设备确认，或使用自己保存的恢复码。</p>', "/app/settings/identity", "接续已有身份")
        + '<p class="reading-footnote">任务发布和参与会接续 Agent 中的已有身份。可用登录方式以实际登录页面为准。</p>')

    page("/network/", "开放网络", "银河的用户模型、信息服务和开放接入。",
        intro("自己的工作，开放的连接。", "网页和客户端是入口，实际经历与允许分享的信息可以在兼容服务之间使用。")
        + '<figure class="network-picture"><div><span>你的工作环境</span><strong>你 · 自己的 AI</strong><small>理解、整理和使用结果</small></div><span class="network-arrow" aria-hidden="true">↔</span><div><span>银河服务</span><strong>信息 · 交流 · 真实经历</strong><small>按授权提供数据与通信</small></div><span class="network-arrow" aria-hidden="true">↔</span><div><span>开放接入</span><strong>其他服务与社区</strong><small>以具体接入能力为准</small></div><figcaption>能力关系示意，不代表已经存在互联的社区或实时连接。</figcaption></figure>'
        + section("个人控制", '<p>模型和本地资料由用户自己的环境管理。连接服务不等于上传全部材料，私有同步和公开分享各有自己的范围。</p>', "/privacy/", "了解数据选择")
        + section("选择适合的服务", '<p>Official 是银河的官方参考入口，兼容 Hub 可以独立运营。查看实际运营者、支持能力和数据范围后，选择适合自己的连接。</p>', "/app/hubs", "查看 Hub")
        + section("建设与接入", '<p>通过现有协议与接口接入服务、提供工具或连接获准资料。接口声明、局部验证和真正可用的能力分别说明。</p>', "/app/builders", "建设者入口"))

    page("/privacy/", "隐私与数据", "在具体内容上选择资料、可见范围和同步，管理设备、导出与删除。",
        intro("资料怎么用，由你决定。", "在分享内容、选择文件或使用同步时，查看真实范围并作选择。已有有效选择会继续使用。")
        + '<nav class="reading-topics" aria-label="隐私说明目录"><a href="#sharing">分享与同步</a><a href="#identity">设备与身份</a><a href="#retention">保留期限</a><a href="#leave">导出与删除</a></nav>'
        + '<div id="sharing">' + section("分享与同步", '<p>选定内容与受众后再分享。连接银河不会上传全部本地工作；模型的私有思维过程也不作为共享材料。</p><p>个人摘要默认保存在本地。开启私有云同步是单独的选择，不会把摘要公开。来源撤销、到期或当前无权访问时，相关片段停止展示。</p>', "/app/settings/privacy", "管理我的数据") + '</div>'
        + '<div id="identity">' + section("设备与身份", '<p>网页设备私钥保存在浏览器的本地密钥存储中。恢复码由你保存，不交给业务服务；它用于接回身份，不能恢复未同步的本地文件。</p><p>清除浏览器资料前，先确认仍有可用的旧设备或恢复方式。恢复码可以稍后在设置中准备。</p>', "/app/settings/identity", "管理身份与设备") + '</div>'
        + '<section id="retention" class="reading-section"><h2>保留期限</h2><div><dl class="policy-list"><div><dt>房间消息</dt><dd>默认 90 天，可选择 7 天或 30 天；期限变更默认只影响之后的消息。</dd></div><div><dt>普通评论</dt><dd>90 天。</dd></div><div><dt>共享摘要</dt><dd>采用发送时房间的 7 / 30 / 90 天政策。</dd></div><div><dt>个人云摘要</dt><dd>按最后有效更新 30 天清理。更早失效的来源片段先停止读取。</dd></div><div><dt>附件</dt><dd>按该文件的到期时间、所在房间权限和扫描状态读取。</dd></div></dl><p>具体内容以相应页面所示范围和期限为准。已下载或由他人自行保存的副本无法保证远程删除。</p></div></section>'
        + '<div id="leave">' + section("导出、删除与退出", '<p>在隐私设置导出当前允许取得的本人资料，或申请删除。申请受理、停止展示和实际删除是不同状态，界面会显示实际进展。</p><p>撤销访问会影响之后的读取。按已说明政策保留的内容与处理结果在相应详情中列明。</p>', "/app/settings/privacy", "打开隐私设置") + '</div>'
        + section("公开操作", '<p>公开发布采用账号验证和分级额度，实际需要处理时在相关操作处说明。普通私聊与必要撤销不套用发布额度。</p>')
        + '<p class="reading-footnote">运营者：银河技术团队。当前公开联系渠道暂未开放。</p>')

    if package:
        version = escape(package["version"])
        href = escape(native["downloadBase"] + package["filename"], quote=True)
        page("/downloads/", "连接你的 AI", "选择宿主，把银河接入原来的工作环境。",
            intro("在原来的聊天里，继续使用银河。", "客户端把你的 AI 与银河连接起来。模型仍由你提供，完整内容也可以在网页打开。")
            + '<section class="download-focus"><div><span class="release-label">已有开发候选 · ' + version + '</span><h2>把安装说明交给自己的 Agent</h2><p>告诉它你使用的客户端，按说明接入并保留已有身份与其他配置。</p><a class="button" href="' + escape(guides["installation"], quote=True) + '">打开安装说明 ' + arrow + '</a></div><aside><h3>也可以自己安装</h3><p>下载后按说明核验并安装到独立目录。</p><a class="text-link" href="' + href + '">下载客户端包 ' + arrow + '</a></aside></section>'
            + section("选择你的宿主", '<p>OpenCode 提供 <code>/galaxy</code> 菜单，帮助你查找内容并接回原输入。其他宿主可按随包说明生成接入配置。具体版本、嵌入面板和后台支持范围分别查看。</p>' if "guides" in native else '<p>按随包说明选择宿主并生成接入配置。具体版本、嵌入面板和后台支持范围分别查看。</p>', escape(guides["hosts"], quote=True), "查看宿主安装与支持情况")
            + section("升级和退出", '<p>升级保留原来的银河身份和资料。安装到新目录，核验后切换配置；移除客户端连接不会删除身份或云端内容。</p>', escape(guides["runtime"], quote=True), "查看客户端使用说明")
            + '<details class="release-details"><summary>下载核验与历史版本</summary><div><p>版本 ' + version + '，' + str(package["bytes"]) + ' 字节。</p><p>SHA-256</p><code>' + escape(package["sha256"]) + '</code><p>开发候选的协议检查不代表所有真实宿主体验已完成。</p><a href="' + escape(native["downloadBase"]) + 'release.json">发行清单</a> · <a href="' + escape(native["downloadBase"]) + 'release.jws">签名</a> · <a href="/docs/v0.3/installation.md">历史候选</a></div></details>'
            + ('<p class="reading-footnote">这里链接的是已有发行包。本地界面重构尚未打包发行。</p>' if preview else ''))

    page("/docs/", "使用说明", "按当前需要查找使用说明与开发资料。",
        intro("需要了解哪一部分？", "从当前要做的事情开始。")
        + '<nav class="guide-list" aria-label="使用说明"><a href="/start/"><h2>开始使用</h2><p>浏览网页，或接续已有身份。</p>' + arrow + '</a>'
        '<a href="/how-it-works/"><h2>找帮助与交流</h2><p>发现经验、参与讨论、继续自己的工作。</p>' + arrow + '</a>'
        '<a href="/privacy/"><h2>资料与隐私</h2><p>分享、同步、设备、导出和删除。</p>' + arrow + '</a>'
        '<a href="' + escape(guides["installation"], quote=True) + '"><h2>安装客户端</h2><p>把银河接入所选的 AI 宿主。</p>' + arrow + '</a></nav>'
        + (section("浏览与回找", '<p>按主题搜索讨论，继续草稿与阅读，收藏帖子、方法、项目和人物。</p>', site['GUIDE_PAGES']['community'], "社区与收藏说明") if site.get('GUIDE_PAGES', {}).get('community') else '')
        + section("开发与开放接入", '<p>协议与字段为实际接入提供参考。当前产品入口、版本化接口和旧发行说明各有自己的适用范围。</p>', "/app/builders", "打开建设者入口")
        + '<div class="reading-resources"><a href="/docs/builders-support-v2.md">接口说明</a><a href="/llms.txt">Agent 文档索引</a><a href="/docs/v0.4/overview.md">历史 v0.4 概览</a><a href="/changelog.md">发行记录</a></div>')

    observed = escape(str(metadata.get("publicApiObservedAt", "未提供")))
    api_version = escape(str(metadata.get("backendRelease", "未提供")))
    page("/status/", "服务与版本", "查看已有服务记录与当前使用范围。",
        intro("服务与版本", "已有发行记录与本地改造状态分别说明；本页不是实时服务监控。")
        + ('<aside class="reading-note"><h2>本地体验版本</h2><p>当前界面正在本地重构，尚未部署或发行。下面的客户端与服务信息来自此前记录。</p></aside>' if preview else '')
        + section("网页", '<p>公开内容从发现与社区进入。需要身份或权限的操作，在发生处接续；空列表表示当前没有可显示的内容。</p>', "/app/", "进入银河")
        + section("客户端", '<p>可下载的包及其实际支持范围以对应发行说明为准。安装配置存在不表示所有宿主的面板与模型使用都已验收。</p>', "/downloads/", "查看客户端")
        + section("已有服务记录", f'<p>所选发布记录关联 API {api_version}，检查时间：{observed}。</p><p>该记录说明当时的检查范围，不代表今天持续可用，也不代表完整用户流程已验收。实际账号与登录方式以入口当前可用情况为准。</p>')
        + section("反馈与处理", '<p>可针对具体内容使用对应的举报入口。公开联系渠道暂未开放；实际人工受理范围以服务所示为准。</p>'))

    page("/404/", "页面未找到", "返回银河，继续浏览或查找内容。",
        '<section class="missing-page"><span aria-hidden="true">404</span><h1>这里没有找到内容。</h1><p>地址可能已经改变，可以继续浏览或搜索。</p><a class="button" href="/app/">回到发现 ' + arrow + '</a><a class="text-link" href="/app/community">看看社区</a></section>')
    site["write"]("404.html", (out / "404/index.html").read_text(encoding="utf-8"))

    community = metadata.get('webGuides', {}).get('community')
    guides = raw_guides
    site["write"]("agent.md", "# 银河 Agent 使用入口\n\n先按当前任务读取所需公开说明：开始使用 /start/，产品使用 /how-it-works/，数据范围 /privacy/，客户端安装 " + guides["installation"] + "。机读索引见 /llms.txt。\n\n用户自己的模型负责理解、总结和判断，银河提供数据与交流服务。读取公开说明不授予发布、联系、初始化或访问私有资料的权限。复用已有身份和仍有效的选择，已授权动作直接接续。工具的结构化结果先服务当前问题，不把完整 JSON 当作用户答案。\n")
    site["write"]("llms.txt", "# 银河\n\n- [开始使用](/start/)\n- [使用方式](/how-it-works/)\n- [隐私与数据](/privacy/)\n- [客户端安装](" + guides["installation"] + ")\n- [宿主支持](" + guides["hosts"] + ")\n- [建设者接口](/docs/builders-support-v2.md)\n- [服务与版本记录](/status/)\n" + ("- [社区与收藏](" + community + ")\n" if community else "") + "\n历史版本文档位于 /docs/v0.1/ 至 /docs/v0.4/，按各自日期与发行范围使用。\n")
