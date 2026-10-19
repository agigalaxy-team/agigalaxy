"""The selected long homepage, with local examples and real product entrypoints."""
from html import escape
import json

from chrome import brand_mark


def symbol(name):
    paths = {
        'document': '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h5"/>',
        'spark': '<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/><path d="M20 2v4M18 4h4"/>',
        'talk': '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/>',
        'result': '<path d="M5 20V12M12 20V4M19 20V8"/>',
        'globe': '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/>',
        'laptop': '<path d="M5 4h14v12H5zM3 20h18l-2-4H5z"/>',
        'plug': '<path d="M8 3v6M16 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v4"/>',
        'check': '<path d="m7 12 3 3 7-7"/>',
        'idea': '<path d="M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z"/>',
    }
    return (
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + paths[name] + '</svg>'
    )


def tab(group, key, label, selected=False, cls=''):
    panel = f'gh-{group}-{key}'
    return (
        f'<button type="button" role="tab" class="{cls}" id="{panel}-tab" '
        f'data-gh-tab aria-controls="{panel}" aria-selected="{str(selected).lower()}" '
        f'tabindex="{0 if selected else -1}">{label}</button>'
    )


def panel_attrs(group, key, selected=False):
    panel = f'gh-{group}-{key}'
    return (
        f'id="{panel}" role="tabpanel" aria-labelledby="{panel}-tab" tabindex="0"'
        + ('' if selected else ' hidden')
    )


def bridge(copy, association=''):
    data = f' data-gh-association="{association}"' if association else ''
    return (
        f'<div class="gh-bridge"{data}><span class="gh-connection" aria-hidden="true"><i></i></span>'
        f'<strong>同一身份</strong><p>{copy}</p></div>'
    )


def render_homepage():
    """No generated pixels, service calls, invented members or model responses."""
    research = {
        'protocol': {
            'title': '开放协议',
            'lead': '连接数据、身份与能力。<br>组合使用时保留出处与权限。',
            'copy': '在开放、可互操作的数据与能力网络中，每一份资料被使用时，都保留来源与适用范围。',
            'original': '资料在组合使用时，仍保留各自的原始出处与适用范围。引用的内容可以回到原始记录核查。',
            'question': '这份资料可以怎样使用？',
            'answer': '结合已有资料继续整理，也能回到原文查看依据。引用的内容仍保留出处和使用范围。',
        },
        'capability': {
            'title': '可组合的能力',
            'lead': '方法、工具与自己的 AI。<br>在明确条件下，一起参与。',
            'copy': '已有的方法可以接入当前工作。输入、结果和适用条件继续随来源保留，不必从头重建。',
            'original': '整理方法需要包含来源的资料作为输入，结果仍关联原材料。换用工具时，原有适用条件继续保留。',
            'question': '已有的方法如何接着用？',
            'answer': '先用已有方法整理获准资料，再由自己的 AI 结合当前目标继续。使用时保留原材料与方法依据。',
        },
        'dataset': {
            'title': '开放数据集',
            'lead': '从获准的资料开始。<br>整理之后，仍能找到来处。',
            'copy': '同一主题的资料可以放在一起理解。选择所需内容，自己的 AI 在允许的范围内使用它们。',
            'original': '这份示例资料包含主题、观察日期和原始出处。整理与引用保留这些字段，只使用当前获准的内容。',
            'question': '整理后还能找到原资料吗？',
            'answer': '可以按主题整理，再从引用回到原始资料。日期与出处继续随内容保留，使用范围也不会因整理而扩大。',
        },
    }
    materials = {
        'protocol': {
            'title': '开放协议',
            'original': '资料在组合使用时，仍保留各自的原始出处与适用范围。',
            'before': '组合资料时，',
            'quote': '每一部分都保留自己的出处',
            'after': '，后续阅读仍能回到原文。',
            'source': '《开放协议》 · 资料使用说明',
        },
        'project': {
            'title': '项目记录',
            'original': '本次方案整理了资料来源与验证方法；后续修改继续关联原记录。',
            'before': '在已有方案的基础上，',
            'quote': '补充来源与验证方法',
            'after': '，形成下一份草稿并保留依据。',
            'source': '《AI 协作方案》 · 项目记录',
        },
    }
    identity = {
        'project': {
            'kind': '项目记录', 'title': 'AI 协作方案', 'icon': 'document',
            'fact': '已整理资料来源，并记下需要继续核对的验证方法。',
            'question': '接着完善这份方案。',
            'checks': ['引用已有方案中的资料整理结果', '沿用原记录中的来源与验证方法'],
            'suggestion': '在已有方案的基础上，补充尚待核对的资料，准备一份带有出处的新草稿。',
        },
        'exchange': {
            'kind': '交流', 'title': '资料使用讨论', 'icon': 'talk',
            'fact': '讨论中补充了资料的使用范围，并留下原文出处。',
            'question': '把讨论中的要点接回方案。',
            'checks': ['使用当前获准的讨论摘要', '保留摘要对应的原始内容'],
            'suggestion': '先整理讨论中已明确的内容与未解决的问题，再把可引用的部分带回原方案。',
        },
        'result': {
            'kind': '结果', 'title': '方案修订稿', 'icon': 'result',
            'fact': '修订稿保留了已有结果、原始依据和需要继续处理的部分。',
            'question': '基于这份结果，准备下一步。',
            'checks': ['延续已有修订稿中的有效内容', '回看结果所引用的原始材料'],
            'suggestion': '从已完成的部分继续，准备尚待补充的内容；新的草稿仍保留对应来源。',
        },
    }
    entries = {
        'web': {
            'name': '网页', 'icon': 'globe',
            'copy': '在浏览器中使用银河，随时阅读资料与交流。',
            'title': '打开网页，直接探索',
            'detail': '公开内容直接浏览；注册或登录在线账户即可发帖、回复，不要求先安装客户端或创建银河 ID。',
            'href': '/app/', 'action': '进入网页',
        },
        'native': {
            'name': '本机接入', 'icon': 'laptop',
            'copy': '在自己的设备上接入银河，连接获准的资料与工具。',
            'title': '在自己的设备上继续',
            'detail': '先安装本地银河插件，在插件中创建或接续 ID；已有身份与本地资料继续按你的选择使用。',
            'href': '/downloads/', 'action': '查看本机接入',
        },
        'ai': {
            'name': '常用 AI 工具', 'icon': 'plug',
            'copy': '在常用工具中接入银河，继续熟悉的工作方式。',
            'title': '从原来的 AI 对话继续',
            'detail': '在所支持的宿主安装银河插件，使用当前环境的 ID，把获准的背景交给自己的模型。',
            'href': '/downloads/', 'action': '查看 AI 工具接入',
        },
    }
    concepts = {
        'data': '每份资料，保留出处与使用范围。',
        'identity': '真实参与，持续关联同一身份。',
        'capability': '方法与工具，在原有条件下组合。',
    }
    example = escape(json.dumps({
        'concepts': concepts, 'entries': entries, 'preset': True,
        'notice': '资料、身份与回答均为预设内容'
    }, ensure_ascii=False, separators=(',', ':')), quote=True)

    research_tabs, research_panels = [], []
    for index, (key, item) in enumerate(research.items()):
        first = index == 0
        research_tabs.append(tab('research', key, item['title'], first))
        view = f'research-source-{key}'
        association = f'research-{key}'
        research_panels.append(f'''
<div class="gh-research-panel" {panel_attrs('research', key, first)}>
  <article class="gh-research-source" data-gh-association="{association}">
    <h3><span class="gh-inline-icon gh-pink-icon">{symbol('document')}</span>{item['title']}</h3>
    <div class="gh-source-views">
      <div {panel_attrs(view, 'overview', True)}><p class="gh-source-lead">{item['lead']}</p><p>{item['copy']}</p></div>
      <div class="gh-original" {panel_attrs(view, 'original')}><small>示例原文 · {item['title']}</small><blockquote><mark class="gh-linked-text">{item['original']}</mark></blockquote><p class="gh-source-note">为说明资料关系编写的示例，非正式协议条款。</p></div>
    </div>
    <div class="gh-text-tabs" role="tablist" aria-label="{item['title']}阅读方式">{tab(view, 'overview', '内容', True)}{tab(view, 'original', '原文')}</div>
  </article>
  {bridge('基于你的银河身份<br>连接两侧的内容', association)}
  <article class="gh-research-ai">
    <h3><span class="gh-inline-icon gh-pink-icon">{symbol('spark')}</span>我的 AI <small>预设回答</small></h3>
    <p class="gh-question">{item['question']}</p><p class="gh-ai-answer">{item['answer']}</p>
    <div class="gh-citation"><span>引用来源</span><div><strong>{symbol('document')}{item['title']}</strong><button type="button" class="gh-text-action" data-gh-reference="gh-{view}-original" data-gh-associate="{association}">查看原文</button></div></div>
  </article>
</div>''')

    material_tabs, material_panels = [], []
    for index, (key, item) in enumerate(materials.items()):
        first = index == 0
        association = f'material-{key}'
        material_tabs.append(tab('material', key, item['title'], first))
        material_panels.append(f'''
<div class="gh-material-panel" {panel_attrs('material', key, first)} data-gh-association="{association}">
  <article class="gh-source-document" id="gh-material-{key}-original" tabindex="-1"><small>原文 · 示例</small><h3>{item['title']}</h3><blockquote><mark class="gh-linked-text">{item['original']}</mark></blockquote><p class="gh-source-note">{item['source']}</p></article>
  <article class="gh-quoted-document"><small>组合中的引用</small><h3>研究笔记</h3><p>{item['before']}<mark class="gh-linked-text">{item['quote']}</mark>{item['after']}</p><button type="button" class="gh-text-action" data-gh-locate="gh-material-{key}-original" data-gh-associate="{association}">查看对应原文</button></article>
</div>''')

    identity_tabs, identity_panels = [], []
    for index, (key, item) in enumerate(identity.items()):
        first = index == 0
        label = f'<span class="gh-inline-icon">{symbol(item["icon"])}</span><span><strong>{item["kind"]}</strong><small>{item["title"]}</small></span>'
        identity_tabs.append(tab('identity', key, label, first, 'gh-record-choice'))
        checks = ''.join(f'<li><span>{symbol("check")}</span>{text}</li>' for text in item['checks'])
        identity_panels.append(f'''
<article class="gh-identity-answer" {panel_attrs('identity', key, first)}>
  <h3><span class="gh-inline-icon gh-pink-icon">{symbol('spark')}</span>自己的 AI <small>预设回答</small></h3>
  <div class="gh-identity-evidence" id="gh-identity-{key}-evidence" tabindex="-1" data-gh-association="identity-{key}"><small>{item['kind']} · {item['title']} · 示例</small><p class="gh-linked-text">{item['fact']}</p></div>
  <p class="gh-identity-question">{item['question']}</p><ul class="gh-answer-checks">{checks}</ul>
  <div class="gh-suggestion"><span class="gh-inline-icon">{symbol('idea')}</span><p><strong>可以这样继续</strong>{item['suggestion']}</p></div>
  <button type="button" class="gh-text-action" data-gh-locate="gh-identity-{key}-evidence" data-gh-associate="identity-{key}">查看这条经历的依据</button>
</article>''')

    entry_choices, entry_nodes = [], []
    for index, (key, item) in enumerate(entries.items()):
        selected = str(index == 0).lower()
        entry_choices.append(
            f'<button type="button" class="gh-entry-choice" data-gh-entry="{key}" aria-pressed="{selected}">'
            f'<span class="gh-entry-icon">{symbol(item["icon"])}</span>'
            f'<span><strong>{item["name"]}</strong><small>{item["copy"]}</small></span></button>'
        )
        entry_nodes.append(
            f'<button type="button" class="gh-entry-node gh-entry-node-{key}" data-gh-entry="{key}" '
            f'aria-pressed="{selected}" aria-label="在接入示意中选择{item["name"]}">'
            f'<span>{symbol(item["icon"])}</span><small>{item["name"]}</small></button>'
        )

    return f'''<div class="galaxy-home" data-home-example="{example}">
<header class="gh-hero gh-section">
  <div class="gh-hero-copy"><h1><span>开放的身份</span><span>与能力网络</span></h1><p>数据、身份与自己的 AI，持续连接。</p>
    <div class="gh-actions"><a class="gh-button gh-primary" href="/app/">探索银河</a><a class="gh-button" href="/downloads/">接入我的 AI</a></div>
  </div>
  <div class="gh-hero-network" data-gh-concept-current="data">
    <div class="gh-hero-orbit" aria-hidden="true"><svg viewBox="0 0 600 350" fill="none"><path class="gh-concept-line gh-concept-line-data" d="M60 132C164 134 204 155 298 166"/><path class="gh-concept-line gh-concept-line-capability" d="M304 165C390 155 456 141 549 108"/><path class="gh-concept-line gh-concept-line-identity" d="M299 165C300 232 259 271 224 280"/><circle class="gh-concept-dot gh-concept-dot-data" cx="60" cy="132" r="3"/><circle class="gh-concept-dot gh-concept-dot-capability" cx="549" cy="108" r="3"/><circle class="gh-concept-dot gh-concept-dot-identity" cx="224" cy="280" r="3"/></svg>{brand_mark('gh-hero-mark')}</div>
    <div class="gh-concept-choices" role="group" aria-label="了解银河中的数据、身份与能力">
      <button type="button" class="gh-concept gh-concept-data" data-gh-concept="data" aria-pressed="true">数据</button>
      <button type="button" class="gh-concept gh-concept-capability" data-gh-concept="capability" aria-pressed="false">能力</button>
      <button type="button" class="gh-concept gh-concept-identity" data-gh-concept="identity" aria-pressed="false">身份</button>
    </div>
    <p class="gh-concept-copy" data-gh-concept-copy aria-live="polite">{concepts['data']}</p>
  </div>
</header>

<section class="gh-research gh-section" aria-labelledby="gh-research-title" aria-describedby="gh-example-note">
  <div class="gh-section-heading"><div><span class="gh-kicker">交互示例</span><h2 id="gh-research-title">星河研究</h2><p>在真实资料的基础上，与自己的 AI 一起探索、理解和创造。</p></div><p class="gh-example-note" id="gh-example-note">资料、身份与回答均为预设内容</p></div>
  <div class="gh-tabs" role="tablist" aria-label="星河研究资料">{''.join(research_tabs)}</div>
  <div class="gh-research-stage">{''.join(research_panels)}</div>
</section>

<section class="gh-sources gh-section" aria-labelledby="gh-sources-title">
  <div class="gh-editorial-copy"><span class="gh-section-stroke" aria-hidden="true"></span><h2 id="gh-sources-title">资料可以组合，<br>出处始终清楚</h2><p>不同来源的资料可以在同一主题下被组合使用，每一段内容都能追溯到原始出处。</p><p class="gh-reading-hint">选中资料，在当前区域查看引用。</p></div>
  <div class="gh-materials"><div class="gh-tabs" role="tablist" aria-label="资料与引用示例">{''.join(material_tabs)}</div>{''.join(material_panels)}</div>
</section>

<section class="gh-identity-section gh-section" aria-labelledby="gh-identity-title">
  <div class="gh-identity-heading"><span class="gh-section-stroke" aria-hidden="true"></span><h2 id="gh-identity-title">同一身份，积累继续发挥作用</h2><p>已有经历作为背景，自己的 AI 在获准范围内继续使用。</p></div>
  <div class="gh-identity-stage"><div class="gh-profile"><div class="gh-profile-heading"><span class="gh-avatar" aria-hidden="true">G</span><div><h3>我的银河身份</h3><p>示例身份 · 资料与经历持续关联</p></div></div><div class="gh-record-choices" role="tablist" aria-orientation="vertical" aria-label="已有经历示例">{''.join(identity_tabs)}</div></div>
  {bridge('过去的资料<br>成为未来的起点')}
  <div class="gh-identity-panels">{''.join(identity_panels)}</div></div>
</section>

<section class="gh-access gh-section" aria-labelledby="gh-access-title">
  <div class="gh-access-copy"><span class="gh-section-stroke" aria-hidden="true"></span><h2 id="gh-access-title">从你熟悉的地方接入</h2><p>直接用在线账户参与，或在本地银河中与自己的 AI 一起工作。</p><div class="gh-entry-choices" role="group" aria-label="选择接入方式">{''.join(entry_choices)}</div><a class="gh-text-action" href="/downloads/">查看接入文档</a></div>
  <div class="gh-access-preview"><div class="gh-access-network" data-gh-entry-current="web"><svg class="gh-access-links" viewBox="0 0 520 330" fill="none" aria-hidden="true"><path class="gh-access-link-web" d="M260 165V55"/><path class="gh-access-link-native" d="M247 175C197 172 146 213 133 254"/><path class="gh-access-link-ai" d="M272 175C324 172 374 213 387 254"/></svg><div class="gh-access-brand">{brand_mark()}</div><div role="group" aria-label="接入关系示意">{''.join(entry_nodes)}</div></div><div class="gh-entry-detail" aria-live="polite" aria-atomic="true"><h3 data-gh-entry-title>{entries['web']['title']}</h3><p data-gh-entry-detail>{entries['web']['detail']}</p><a class="gh-text-action" data-gh-entry-link href="{entries['web']['href']}">{entries['web']['action']}</a></div></div>
</section>

<section class="gh-closing gh-section" aria-labelledby="gh-closing-title">
  <svg class="gh-closing-orbits" viewBox="0 0 1600 300" preserveAspectRatio="none" fill="none" aria-hidden="true"><ellipse cx="805" cy="164" rx="1005" ry="150" transform="rotate(-9 805 164)"/><ellipse cx="830" cy="200" rx="1120" ry="152" transform="rotate(-9 830 200)"/><circle cx="1390" cy="215" r="5"/></svg>
  <div><span class="gh-section-stroke" aria-hidden="true"></span><h2 id="gh-closing-title">开始探索银河</h2><p>连接你的资料、身份与能力，让自己的 AI 继续原来的事情。</p><a class="gh-button gh-primary" href="/app/">进入银河</a></div>
</section>
<output class="sr-only" data-gh-announcement aria-live="polite"></output>
</div>'''
