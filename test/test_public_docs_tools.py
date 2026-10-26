"""Focused offline tests for canonical public publishing boundaries."""
import json
import posixpath
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import sync_public_docs as public


class PublicDocsToolsTests(unittest.TestCase):
    def test_explicit_sources_and_all_published_links(self):
        files, entries = public.plan()
        self.assertEqual(len(files), len(entries) + 2)
        self.assertEqual({x['source'] for x in entries if x['source'].startswith('docs/assets/')}, public.ASSETS)
        for item in entries:
            self.assertTrue(item['source'].startswith('docs/public/') or item['source'] in public.ASSETS)
            self.assertFalse(item['source'].startswith('docs/public/docs/'))
            self.assertNotIn('originals', Path(item['source']).parts)
        public.validate_links(files)
        self.assertIn(b'development-candidate', files['docs/native-client/0.1.19/installation.md'])
        self.assertIn('0.1.16'.encode(), files['docs/native-client/0.1.16/installation.md'])
        self.assertNotIn(b'07-logs/', b'\n'.join(files.values()))
        references = set()
        for name, body in files.items():
            if name.endswith('.md'):
                for match in public.LINK.finditer(body.decode('utf-8')):
                    if public.local_link(match['url']):
                        references.add(posixpath.normpath(posixpath.join(posixpath.dirname(name), match['url'])))
        self.assertTrue(public.ASSETS.issubset(references), 'Only actually referenced assets may be published')

    def test_dry_run_idempotency_and_unlisted_preservation(self):
        files, _ = public.plan()
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'preview'
            result = public.apply_plan(output, files, dry_run=True)
            self.assertEqual(len(result['changed']), len(files))
            self.assertFalse(output.exists())
            public.apply_plan(output, files)
            sentinel = output / 'unlisted.txt'
            sentinel.write_text('preserve', encoding='utf-8')
            self.assertEqual(public.apply_plan(output, files, check=True)['changed'], [])
            self.assertEqual(public.apply_plan(output, files)['changed'], [])
            self.assertEqual(sentinel.read_text(), 'preserve')
            self.assertFalse(list(output.rglob('*.tmp')))

    def test_output_must_not_overwrite_source(self):
        for output in (ROOT, ROOT.parent, ROOT / 'outputs/preview'):
            with self.assertRaisesRegex(ValueError, 'outside the source'):
                public.apply_plan(output, {'README.md': b'no'}, dry_run=True)

    def test_path_traversal_rejected_before_any_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'preview'
            with self.assertRaises(ValueError):
                public.apply_plan(output, {'valid.txt': b'yes', '../escape.txt': b'no'})
            self.assertFalse(output.exists())
        for value in ('../secret', '/absolute', 'C:/secret', '.git/config', 'a\\b', 'a/../b'):
            with self.assertRaises(ValueError):
                public.relative(value)

    def test_private_sources_cannot_be_added_to_manifest(self):
        manifest = json.loads((ROOT / public.MANIFEST).read_text(encoding='utf-8'))
        for source in ('docs/deployment.md', 'originals/discussion.md', 'docs/public/originals/discussion.md'):
            variant = dict(manifest)
            variant['files'] = manifest['files'] + [{'source': source, 'target': 'leak.md'}]
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                path = root / public.MANIFEST
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps(variant), encoding='utf-8')
                with self.assertRaises(ValueError):
                    public.plan(root)

    def test_missing_relative_link_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'Unpublished'):
            public.rewrite_links('[internal](../../originals/discussion.md)',
                                 'docs/public/a.md', 'docs/a.md', {})

    def test_atomic_failure_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'preview'
            with patch.object(public.os, 'replace', side_effect=OSError('synthetic failure')):
                with self.assertRaises(OSError):
                    public.apply_plan(output, {'a.txt': b'a'})
            self.assertFalse(list(output.rglob('*.tmp')))
            self.assertFalse((output / 'a.txt').exists())


if __name__ == '__main__':
    unittest.main()
