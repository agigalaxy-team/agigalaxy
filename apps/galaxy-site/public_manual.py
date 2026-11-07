"""Publish the repository manual and the common Native Skill on stable site URLs."""
from html import escape
from pathlib import Path, PurePosixPath
import shutil
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


def publish_manual(site, released_skill=None):
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
    publish_skill(Path(site["OUT"]).resolve(), released_skill)
    return pages.values()


def publish_skill(output, released_skill):
    skill_parent = output / "skills"
    public_skill = skill_parent / "galaxy"
    if (skill_parent.is_symlink() or public_skill.is_symlink()
            or not public_skill.resolve().is_relative_to(output)
            or public_skill.resolve() != public_skill):
        raise ValueError("Generated Skill directory must stay inside the output directory")
    if public_skill.exists():
        if not public_skill.is_dir():
            raise ValueError("Generated Skill target must be a directory")
        shutil.rmtree(public_skill)
    archive_path = skill_parent / "galaxy.zip"
    if archive_path.is_symlink():
        raise ValueError("Generated Skill archive must not be a symbolic link")
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    if released_skill is not None:
        # The installer compares Skill files byte-for-byte with its packaged
        # tree. Use the verified release ZIP even when checkout line endings differ.
        with ZipFile(released_skill) as archive:
            names = archive.namelist()
            if "galaxy/SKILL.md" not in names or len(names) != len(set(names)):
                raise ValueError("Invalid released Skill archive")
            for name in names:
                path = PurePosixPath(name)
                if (not name.startswith("galaxy/") or name.endswith("/") or "\\" in name
                        or path.as_posix() != name or ".." in path.parts):
                    raise ValueError("Invalid released Skill path")
                target = skill_parent.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
        shutil.copyfile(released_skill, archive_path)
        return

    skill = REPO / "integrations/native-v2/skills/galaxy"
    if skill.is_symlink():
        raise ValueError("Skill source must not be a symbolic link")
    paths = []
    for path in sorted(skill.rglob("*")):
        parts = path.relative_to(skill).parts
        if (any(part in {"__pycache__", ".pytest_cache", ".git", "node_modules"} for part in parts)
                or path.name == ".DS_Store" or path.suffix.lower() in {".pyc", ".pyo", ".tmp", ".swp"}
                or path.name.endswith("~")):
            continue
        if path.is_symlink():
            raise ValueError("Skill assets must not contain symbolic links")
        if path.is_file():
            paths.append(path)
        elif not path.is_dir():
            raise ValueError("Skill assets must be regular files or directories")
    if skill / "SKILL.md" not in paths:
        raise FileNotFoundError(skill / "SKILL.md")
    with ZipFile(archive_path, "w") as archive:
        for path in paths:
            relative = "galaxy/" + path.relative_to(skill).as_posix()
            target = public_skill / path.relative_to(skill)
            target.parent.mkdir(parents=True, exist_ok=True)
            content = path.read_bytes()
            target.write_bytes(content)
            archive.writestr(ZipInfo(relative), content, compress_type=ZIP_DEFLATED)
