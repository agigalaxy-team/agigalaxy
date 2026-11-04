"""Publish the repository manual and the common Native Skill on stable site URLs."""
from html import escape
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from guide_pages import render_markdown
from public_reading import CONTRACT

REPO = Path(__file__).resolve().parents[2]
GITHUB = "https://github.com/agigalaxy-team/agigalaxy/blob/main"
MANUAL_ROOT = "/docs/galaxy/"
CHAPTERS = (
    "README.md", "ai-reading.md", "getting-started.md", "client-entry.md", "network.md",
    "vision-and-architecture.md", "technology.md", "ecosystem-and-hubs.md", "privacy.md",
    "status.md", "technical-faq.md", "open-components.md", "growth-and-contribution.md",
    "business-and-participation.md", "community-governance.md", "site-files/MANIFESTO.md",
    "site-files/SUPPORT.md",
)
PUBLIC_ASSETS = (*[path.lstrip("/") for path in CONTRACT["staticImages"]], "docs/public/examples/capsule-v2.json")


def publish_manual(site):
    pages = {
        "/docs/public/" + source: MANUAL_ROOT + ("" if source == "README.md" else source.removesuffix(".md").lower() + "/")
        for source in CHAPTERS
    }
    assets = {"/" + asset for asset in PUBLIC_ASSETS}
    for asset in PUBLIC_ASSETS:
        target = site["OUT"] / asset
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((REPO / asset).read_bytes())

    for source, url in pages.items():
        markdown = (REPO / source.lstrip("/")).read_text(encoding="utf-8")
        site["write"](source.lstrip("/"), markdown)
        title, body, headings = render_markdown(markdown, source, pages, repository=GITHUB, local_assets=assets)
        sections = "".join(f'<a href="#{anchor}">{escape(label)}</a>' for level, anchor, label in headings if level == 2)
        index_link = "" if url == MANUAL_ROOT else '<a href="/docs/galaxy/">银河说明书</a>'
        site["page"](url, title, "银河现行说明书", '<div class="guide-breadcrumb">' + index_link
                     + f'<a href="{escape(source, quote=True)}">Markdown 原文</a></div>'
                     + f'<header class="guide-heading"><h1>{escape(title)}</h1></header>'
                     + ('<nav class="reading-topics" aria-label="本页目录">' + sections + '</nav>' if sections else '')
                     + '<article class="guide-body">' + body + '</article>')

    site["write"]("agent.md", (REPO / "docs/public/ai-reading.md").read_text(encoding="utf-8"))
    site["write"]("downloads/galaxy-update.mjs", (REPO / "scripts/galaxy-update-legacy.mjs").read_text(encoding="utf-8"))
    skill = REPO / "integrations/native-v2/skills/galaxy"
    paths = [skill / "SKILL.md", *sorted((skill / "references").glob("*.md"))]
    archive_path = site["OUT"] / "skills/galaxy.zip"
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(archive_path, "w") as archive:
        for path in paths:
            relative = "galaxy/" + path.relative_to(skill).as_posix()
            target = site["OUT"] / "skills" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            content = path.read_bytes()
            target.write_bytes(content)
            archive.writestr(ZipInfo(relative), content, compress_type=ZIP_DEFLATED)
    return pages.values()
