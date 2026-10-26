import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "tools/docs.py"
spec = importlib.util.spec_from_file_location("docs_helper", SCRIPT)
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)

class DocumentationChecks(unittest.TestCase):
    def test_direct_target_and_heading_with_code_fence_ignored(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.md").write_text("[目标](b.md#实际标题)\n" + docs.FENCE + "\n[not a document](absent.md)\n" + docs.FENCE, encoding="utf-8")
            (root / "b.md").write_text("# 实际标题\n", encoding="utf-8")
            self.assertEqual(docs.check(root, ["a.md"])["errors"], [])

    def test_missing_target_and_missing_heading_are_distinct(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.md").write_text("[一](absent.md)\n[二](b.md#不存在)", encoding="utf-8")
            (root / "b.md").write_text("# 实际标题\n", encoding="utf-8")
            self.assertEqual([x["reason"] for x in docs.check(root, ["a.md"])["errors"]], ["missing-target", "missing-heading"])

    def test_outside_repository_link_is_not_a_valid_internal_reference(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.md").write_text("[外](../outside.md)", encoding="utf-8")
            self.assertEqual(docs.check(root, ["a.md"])["errors"][0]["reason"], "outside-repository")

    def test_served_site_routes_are_distinct_from_filesystem_links(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp); name = "apps/galaxy-site/public/guide.md"
            (root / name).parent.mkdir(parents=True)
            (root / name).write_text("[社区](/app/community)", encoding="utf-8")
            result = docs.check(root, [name])
            self.assertEqual(result["websiteReferences"], 1)
            self.assertEqual(result["localReferences"], 0)
            self.assertEqual(result["errors"], [])

if __name__ == "__main__":
    unittest.main()
