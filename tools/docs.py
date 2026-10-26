"""Check current documentation links without loading private project history."""
import argparse
import html
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
FENCE = chr(96) * 3

def prose(text):
    return re.sub(r"(?ms)^" + FENCE + r".*?^" + FENCE + r"[^\n]*", "", text)

def anchors(text):
    result = set(re.findall(r'<a\s+[^>]*(?:id|name)=["\']([^"\']+)', text, re.I))
    seen = {}
    for title in re.findall(r"(?m)^#{1,6}\s+(.+?)\s*#*\s*$", prose(text)):
        title = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", title)
        title = re.sub(r"<[^>]+>", "", title)
        slug = re.sub(r"[^\w\- ]", "", html.unescape(title).lower()).strip().replace(" ", "-")
        count = seen.get(slug, 0)
        seen[slug] = count + 1
        result.add(slug if not count else slug + "-" + str(count))
    return result

def references(text):
    text = prose(text)
    for target in re.findall(r"\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)", text):
        yield target.strip("<>")
    yield from re.findall(r'(?:href|src)=["\']([^"\']+)', text, re.I)

def check(root=ROOT, files=None):
    root = root.resolve()
    names = files or [
        "README.md", "AGENTS.md", "WORK_STATUS.md", "CONTRIBUTING.md",
        *[p.relative_to(root).as_posix() for p in (root / "docs").rglob("*.md")],
        "originals/README.md",
    ]
    errors, checked, website_references = [], 0, 0
    for name in dict.fromkeys(names):
        source = root / name
        if not source.is_file():
            errors.append({"source": name, "reason": "missing-document"})
            continue
        for target in references(source.read_text(encoding="utf-8-sig")):
            url = urlsplit(target)
            if url.scheme or url.netloc:
                continue
            if name.startswith('apps/galaxy-site/public/') and url.path.startswith('/'):
                website_references += 1
                continue
            destination = (source.parent / unquote(url.path)).resolve() if url.path else source.resolve()
            try:
                destination.relative_to(root)
            except ValueError:
                errors.append({"source": name, "target": target, "reason": "outside-repository"})
                continue
            if not destination.exists():
                errors.append({"source": name, "target": target, "reason": "missing-target"})
                continue
            if url.fragment and destination.suffix == ".md":
                if unquote(url.fragment) not in anchors(destination.read_text(encoding="utf-8-sig")):
                    errors.append({"source": name, "target": target, "reason": "missing-heading"})
                    continue
            checked += 1
    return {"documents": len(dict.fromkeys(names)), "localReferences": checked, "websiteReferences": website_references, "errors": errors}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()
    result = check(files=args.files or None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(1 if result["errors"] else 0)
