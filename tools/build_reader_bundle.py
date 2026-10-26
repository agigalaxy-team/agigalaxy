"""Build reader entries from the core repository's public-material subset."""

from pathlib import Path
import re
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[1]
RAW = "https://raw.githubusercontent.com/agigalaxy-team/agigalaxy-public/main/"
DOCUMENTS = [
    "MANIFESTO.md",
    "docs/growth-and-contribution.md",
    "docs/community-governance.md",
    "docs/client-entry.md",
    "docs/vision-and-architecture.md",
    "docs/ecosystem-and-hubs.md",
    "docs/business-and-participation.md",
    "docs/open-components.md",
    "docs/technical-faq.md",
    "docs/native-client/0.1.19/runtime.md",
    "docs/native-client/0.1.19/hosts.md",
    "docs/native-client/0.1.19/installation.md",
    "docs/network.md",
    "docs/getting-started.md",
    "docs/privacy.md",
    "docs/technology.md",
    "docs/status.md",
]


def absolute_links(text, source):
    def replace(match):
        target = match.group(2)
        return match.group(1) + urljoin(RAW + source, target) + ")"

    return re.sub(r"(\]\()([^\s)]+)\)", replace, text)


def main():
    index = [
        "# Galaxy / AGI Galaxy public materials",
        "",
        "Public project and user documentation. Beta; core implementation managed separately.",
        "",
        "Choose documents for the current question. The combined bundle is optional, not a required reading sequence.",
        "For source development, use that checkout's AGENTS.md and relevant component guide; this public bundle is not a development checklist.",
        "",
        "- Reading guide: " + RAW + "docs/ai-reading.md",
        "- Combined plain text: " + RAW + "llms-full.txt",
        "- Capsule JSON example (synthetic): " + RAW + "examples/capsule-v2.json",
        "",
        "## Documents",
    ]
    sections = [
        "# 银河公开技术与使用资料合并阅读包",
        "",
        "Generated from the core repository public-material subset. Links point to the public counterpart repository.",
        "Read the stated dates, release scopes, implementation boundaries and limitations.",
        "Use this bundle when full public background is needed; source development starts with the checkout's AGENTS.md and relevant component guide.",
        "",
    ]
    for source in DOCUMENTS:
        content = (ROOT / source).read_text(encoding="utf-8").strip()
        title = next((line[2:] for line in content.splitlines() if line.startswith("# ")), source)
        index.append("- " + title + ": " + RAW + source)
        sections.extend(["---", "", "Public counterpart: " + RAW + source, "", absolute_links(content, source), ""])
    example = "examples/capsule-v2.json"
    sections.extend(["---", "", "Public counterpart: " + RAW + example, "", "# Capsule v2 合成结构示例", "", "```json", (ROOT / example).read_text(encoding="utf-8").strip(), "```", ""])
    (ROOT / "llms.txt").write_text("\n".join(index) + "\n", encoding="utf-8", newline="\n")
    (ROOT / "llms-full.txt").write_text("\n".join(sections), encoding="utf-8", newline="\n")
    print("Updated llms.txt and llms-full.txt from " + str(len(DOCUMENTS)) + " public documents and one synthetic example.")


if __name__ == "__main__":
    main()
