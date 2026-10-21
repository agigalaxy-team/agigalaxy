"""Current user-facing pages, separate from immutable release documents.

The renderer uses authored content and local release metadata only. It never
contacts a service, changes a release pointer, or creates a new client package.
"""
from html import escape
import json

from home_page import render_homepage
from cms_content import content_slot


def icon(name):
    paths = {
        "search": '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
        "talk": '<path d="M20 11a8 8 0 0 1-8 8H5l-4 3V11a9 9 0 0 1 19 0Z"/><path d="M6 9h9M6 13h6"/>',
        "book": '<path d="M4 3h13a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3M3 17h17M8 7h7M8 11h5"/>',
        "people": '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"/>',
        "screen": '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>'


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

    def intro(title, text):
        return content_slot('page-intro', f'<header class="reading-intro"><h1>{title}</h1><p>{text}</p></header>')

    def section(title, text, href=None, label=None):
        link = f'<a class="text-link" href="{href}">{label} </a>' if href else ''
        return f'<section class="reading-section"><h2>{title}</h2><div>{text}{link}</div></section>'

    page("/", "开放的身份与能力网络", "资料保留来源，身份持续积累，用自己的 AI 继续原来的事情。", render_homepage())

    page("/how-it-works/", "怎样使用银河", "从阅读、交流到使用结果，按自己的需要使用银河。",
        intro("从你正在做的事开始。", "可以只来看看，也可以带着问题和经验，与别人一起往前走。")
        + section("先找找已有的经验", '<p>阅读相关方法、项目和真实经历，判断哪些对自己有用。想进一步了解时，再看完整内容与依据。</p>', "/app/", "发现内容")
        + section("有想法，就聊聊", '<p>在帖子里提问和回复，或与相关的人继续对话。闲聊、分享作品和讨论一个兴趣，都可以独立进行。</p>', "/app/community", "进入社区")
        + section("需要帮助时，说清楚当前目标", '<p>利用已经有的背景准备请求，补上你希望得到的帮助。选择要分享的内容后发布，收到回应再决定怎样继续交流。</p>', "/app/publish", "发起求助")
        + section("把有用的结果带回去", '<p>读到的方法、收到的建议和实际文件都可以回到原来的事情中使用。真实经历保留来处，下一次寻找帮助时也有更多依据。</p>')
        + section("和自己的 AI 一起使用", '<p>把银河接入常用的 AI 工具，整理资料、寻找帮助，接着原来的工作继续。</p>', "/downloads/", "接入我的 AI"))

    page("/start/", "开始使用", "直接在网页浏览，或从自己的AI工作中使用银河。",
        intro("开始使用银河", "在网页中浏览交流，或连接常用的 AI 工具。")
        + '<div class="entry-choices"><section><span class="purpose-symbol">' + icon("search") + '</span><h2>浏览与交流</h2><p>发现内容、参与讨论，分享自己的经验。</p><a class="button" href="/app/community">进入社区</a><a class="text-link" href="/app/account">登录或注册</a></section>'
        '<section><span class="purpose-symbol">' + icon("screen") + '</span><h2>连接自己的 AI</h2><p>安装银河客户端，在熟悉的工具中继续工作。</p><a class="button" href="/downloads/">安装客户端</a><a class="text-link" href="/app/account?section=access">已安装，继续接入</a></section></div>')

    page("/network/", "开放网络", "银河的用户模型、信息服务和开放接入。",
        intro("自己的工作，开放的连接。", "人、组织与 Agent 分别保留身份和经历。在线账户承接官网活动，本机银河让自己的 AI 在获准范围内使用数据与能力。")
        + '<figure class="network-picture"><div class="network-origin"><span>本机银河</span><strong>主体 ID · 本地履历</strong><small>个人、组织与独立 Agent 分别记录</small></div><svg class="network-links" viewBox="0 0 70 320" width="70" height="320" fill="none" aria-hidden="true"><path d="M0 160H30M30 80V240M30 80H70M30 240H70" stroke="#e8bed1" stroke-width="1.5"/><circle cx="30" cy="160" r="4" fill="#d38bab"/></svg><div class="network-services"><section><span>可选官方服务</span><strong>银河在线账户</strong><small>官网活动与所选同步资料</small></section><section><span>可选其他服务</span><strong>第三方 Hub</strong><small>由开源模块部署和接入</small></section></div><figcaption>本地使用无需连接线上服务，可按需关联官方账户或第三方 Hub。一个账户可关联多个 ID，同一 ID 也可关联多个账户；每次动作按指定账户与授权执行。</figcaption></figure>'
        + section("个人控制", '<p>模型和本地资料由用户自己的环境管理。连接服务不等于上传全部材料，私有同步和公开分享各有自己的范围。</p>', "/privacy/", "了解数据选择")
        + section("本机身份与官方账户", '<p>在线账户可直接注册和使用，无须先有本地 ID。关联后，账户可以保存所选同步资料，本地银河也能按授权操作指定账户。银河 ID 的创建与关联需要当前设备上的银河实际参与。</p>', "/app/settings/identity?section=account", "了解银河账户关联")
        + section("建设与接入", '<p>连接自己的工具、资料与服务，参与开放网络的建设。</p>', "/app/builders", "建设者入口"))

    page("/privacy/", "隐私与数据", "在具体内容上选择资料、可见范围和同步，管理设备、导出与删除。",
        intro("资料怎么用，由你决定。", "在分享内容、选择文件或使用同步时，查看真实范围并作选择。已有有效选择会继续使用。")
        + '<nav class="reading-topics" aria-label="隐私说明目录"><a href="#sharing">分享与同步</a><a href="#identity">设备与身份</a><a href="#retention">保留期限</a><a href="#leave">导出与删除</a></nav>'
        + '<div id="sharing">' + section("分享与同步", '<p>选定内容与受众后再分享。连接银河不会上传全部本地工作；模型的私有思维过程也不作为共享材料。</p><p>个人摘要默认保存在本地。开启私有云同步是单独的选择，不会把摘要公开。来源撤销、到期或当前无权访问时，相关片段停止展示。</p>', "/app/account?section=settings&view=work", "管理已同步工作") + '</div>'
        + section("本地记录与上传", '<p>客户端在本地积累工作履历，由你自己的 AI 整理。上传范围可在客户端调整：</p><dl class="policy-list"><div><dt>仅本地</dt><dd>不上传工作资料。</dd></div><div><dt>履历概况 · 默认</dt><dd>所选经历和主要环境概况，不含工作原文与文件。</dd></div><div><dt>工作内容</dt><dd>所选工作的说明、过程摘要和材料。</dd></div><div><dt>会话归档</dt><dd>额外包含你选定的完整会话。</dd></div></dl><p>尚未连接服务时，资料保存在本地。已有有效选择会继续沿用；宿主模型的数据使用按宿主设置处理。</p>')
        + section("在线账户的对外查询", '<p>允许上传不代表允许公开。在线账户单独设置对外查询入口和可见范围，开放查询不会反过来扩大本地上传范围。自己的完整会话归档保持私有。</p>', "/app/account?section=settings", "管理在线账户资料与查询")
        + '<div id="identity">' + section("设备与身份", '<p>本地银河保存你的 ID 和设备控制密钥。关联在线账户时，由当前设备上的银河确认。</p>', "/app/settings/identity?section=account", "管理账户关联") + '</div>'
        + '<section id="retention" class="reading-section"><h2>保留期限</h2><div><dl class="policy-list"><div><dt>房间消息</dt><dd>默认 90 天，可选择 7 天或 30 天；期限变更默认只影响之后的消息。</dd></div><div><dt>普通评论</dt><dd>90 天。</dd></div><div><dt>共享摘要</dt><dd>采用发送时房间的 7 / 30 / 90 天政策。</dd></div><div><dt>个人云摘要</dt><dd>按最后有效更新 30 天清理。更早失效的来源片段先停止读取。</dd></div><div><dt>附件</dt><dd>按该文件的到期时间、所在房间权限和扫描状态读取。</dd></div></dl><p>具体内容以相应页面所示范围和期限为准。已下载或由他人自行保存的副本无法保证远程删除。</p></div></section>'
        + '<div id="leave">' + section("导出与删除", '<p>已同步工作在账户中管理。选定归档的完整会话保持私有，可以阅读、导出、删除或设置自动清理。</p><nav class="reading-resources" aria-label="本人资料管理"><a href="/app/account?section=settings&view=work">已同步工作</a><a href="/app/account?section=settings&view=archives">私有会话</a></nav>') + '</div>'
        + section("本地身份与设备资料", '<p>需要导出本地 ID 对应的服务资料、管理设备或申请删除时，在当前设备连接本地银河后办理。退出在线账户或解除关联不会删除本地身份和履历。</p>', "/app/settings/privacy", "身份资料与设备设置"))

    if package:
        version = escape(package["version"])
        href = escape(native["downloadBase"] + package["filename"], quote=True)
        bundle = native.get('installBundle')
        install_href = escape(native['downloadBase'] + bundle['filename'], quote=True) if bundle else href
        page("/downloads/", "客户端下载", "取得银河客户端、安装说明与原始发行资料。",
            intro("客户端下载", "把银河接入常用的 AI 工具。")
            + '<nav class="reading-topics" aria-label="客户端入口"><a href="/app/account?section=access">账户中的接入与 AI</a><a href="#client-package">下载与安装</a></nav>'
            + '<section class="download-focus" id="client-package"><div><span class="release-label">开发版 · ' + version + '</span><h2>银河客户端</h2><p>在原来的工作环境中浏览银河、积累履历，使用自己的模型继续工作。</p><a class="button" href="' + install_href + '">下载客户端</a><a class="text-link" href="' + escape(guides["installation"], quote=True) + '">安装说明</a></div><aside><h3>让 Agent 帮你安装</h3><p>将安装说明交给常用的 AI 工具即可。</p><a class="text-link" href="' + escape(guides["installation"], quote=True) + '">查看安装说明</a></aside></section>'
            + section("常用 AI 工具", '<p>OpenCode 安装后照常使用，自动积累本地工作记录。需要阅读或查找内容时打开 <code>/galaxy</code>。其他工具按随包说明接入。</p>' if "guides" in native else '<p>按随包说明选择常用工具并完成接入。</p>', escape(guides["hosts"], quote=True), "查看支持的工具")
            + section("升级和退出", '<p>安装新版时沿用原资料目录，身份和履历继续保留。移除客户端连接不会删除身份或云端内容。</p>', escape(guides["runtime"], quote=True), "查看客户端使用说明")
            + section("发行资料", '<p>下载签名与发行清单，查阅历史版本。</p>', "/downloads/verification/", "发行文件与历史版本"))


        page("/downloads/verification/", "下载核验与历史版本", "核验当前客户端包，查阅对应发行资料。",
            intro("下载核验与历史版本", "按需要查看包信息、发行资料和历史说明。")
            + '<nav class="reading-topics" aria-label="核验资料目录"><a href="/downloads/">返回客户端下载</a><a href="#current-package">当前下载</a><a href="#release-files">发行文件</a><a href="#past-guides">历史说明</a></nav>'
            + '<section id="current-package" class="reading-section"><h2>当前下载</h2><div><dl class="release-facts"><div><dt>版本</dt><dd>' + version + '</dd></div><div><dt>大小</dt><dd>' + str(package["bytes"]) + ' 字节</dd></div><div><dt>SHA-256</dt><dd><code>' + escape(package["sha256"]) + '</code></dd></div></dl><a class="text-link" href="' + href + '">下载客户端包</a></div></section>'
            + '<div id="release-files">' + section("发行文件", '<p>安装工具使用这些文件核对下载来源和完整性。</p><nav class="reading-resources" aria-label="发行核验文件"><a href="' + escape(native["downloadBase"], quote=True) + 'release.json">发行清单</a><a href="' + escape(native["downloadBase"], quote=True) + 'release.jws">签名文件</a></nav>') + '</div>'
            + '<div id="past-guides">' + section("历史说明", '<p>历史安装说明按各自的版本与发行范围使用，当前接入方式从账户中心取得。</p><nav class="reading-resources" aria-label="旧版入口原件"><a href="/archives/public/docs/index.html">旧版文档入口原件</a><a href="/archives/public/downloads/index.html">旧版下载入口原件</a></nav>', "/docs/v0.3/installation.md", "阅读历史候选安装说明") + '</div>')


    page("/docs/", "使用说明", "按当前需要查找使用说明与开发资料。",
        intro("需要了解哪一部分？", "从当前要做的事情开始。")
        + '<nav class="guide-list" aria-label="使用说明"><a href="/start/"><h2>开始使用</h2><p>直接浏览、注册在线账户，或在本地使用银河。</p>' + '</a>'
        '<a href="/how-it-works/"><h2>找帮助与交流</h2><p>发现经验、参与讨论、继续自己的工作。</p>' + '</a>'
        '<a href="/privacy/"><h2>资料与隐私</h2><p>分享、同步、设备、导出和删除。</p>' + '</a>'
        '<a href="' + escape(guides["installation"], quote=True) + '"><h2>安装客户端</h2><p>把银河接入所选的 AI 宿主。</p>' + '</a></nav>'
        + (section("浏览与回找", '<p>按主题搜索讨论，继续草稿与阅读，收藏帖子、方法、项目和人物。</p>', site['GUIDE_PAGES']['community'], "社区与收藏说明") if site.get('GUIDE_PAGES', {}).get('community') else '')
        + section("开发与开放接入", '<p>协议与字段为实际接入提供参考。当前产品入口、版本化接口和旧发行说明各有自己的适用范围。</p>', "/app/builders", "打开建设者入口")
        + '<div class="reading-resources"><a href="/docs/builders-support-v2.md">接口说明</a><a href="/llms.txt">Agent 文档索引</a><a href="/docs/v0.4/overview.md">历史 v0.4 概览</a><a href="/changelog.md">发行记录</a></div>')

    api_version = escape(str(metadata.get("backendRelease", "未提供")))
    site_version = escape(str(metadata.get("releaseId", metadata.get("version", "未提供"))))
    page("/status/", "版本信息", "银河网站、服务与客户端的发行版本。",
        intro("版本信息", "当前发行版本与使用入口。")
        + section("网站", f'<p>{site_version}</p>', "/app/", "打开银河")
        + section("API", f'<p>{api_version}</p>', "/docs/builders-support-v2.md", "接口文档")
        + section("客户端", '<p>' + escape(str(package.get("version", "未提供"))) + '</p>', "/downloads/", "下载客户端")
        + section("历史发行记录", '<p>查阅此前版本的发行说明。</p>', "/changelog.md", "查看历史记录"))

    page("/404/", "页面未找到", "返回银河，继续浏览或查找内容。",
        '<section class="missing-page"><span aria-hidden="true">404</span><h1>这里没有找到内容。</h1><p>地址可能已经改变，可以继续浏览或搜索。</p><a class="button" href="/app/">回到发现 ' + '</a><a class="text-link" href="/app/community">看看社区</a></section>')
    site["write"]("404.html", (out / "404/index.html").read_text(encoding="utf-8"))

    community = metadata.get('webGuides', {}).get('community')
    guides = raw_guides
    site["write"]("agent.md", "# 银河 Agent 使用入口\n\n先按当前任务读取所需公开说明：开始使用 /start/，产品使用 /how-it-works/，数据范围 /privacy/，客户端安装 " + guides["installation"] + "。机读索引见 /llms.txt。\n\n普通官网参与使用在线账户，不要求本地 ID、模型或外部认证。银河 ID 只由已安装的本机银河创建；网页配合当前设备创建、关联和接续，不独立生成或缓存 ID。账户与 ID 可双向多关联，各次动作保留明确的目标与授权；列表和选择不授予 ID 控制。正常客户端默认个人，独立 Agent 走 Worker 路径。版本化发行原件按其原发行范围阅读，当前本机接入从 /app/account?section=access 取得。\n\n银河官方不承担 AI 模型能力，也不提供主体或专业认证。模型由用户或参与者自己选择和使用，负责理解、总结和判断；银河提供实际的数据、身份、网络服务及确定性后台处理。普通工作默认本地积累，四档上传与线上查询分别控制，完整会话只按所选范围私有归档。读取公开说明不授予发布、联系、初始化或访问私有资料的权限。复用已有身份和仍有效的选择，已授权动作直接接续。工具的结构化结果先服务当前问题，不把完整 JSON 当作用户答案。\n")
    site["write"]("llms.txt", "# 银河\n\n- [开始使用](/start/)\n- [使用方式](/how-it-works/)\n- [隐私与数据](/privacy/)\n- [客户端安装](" + guides["installation"] + ")\n- [宿主支持](" + guides["hosts"] + ")\n- [建设者接口](/docs/builders-support-v2.md)\n- [服务与版本记录](/status/)\n" + ("- [社区与收藏](" + community + ")\n" if community else "") + "\n历史版本文档位于 /docs/v0.1/ 至 /docs/v0.4/，按各自日期与发行范围使用。\n")
