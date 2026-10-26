import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_openpanel', Path(__file__).with_name('prepare-openpanel-source.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class SourceContextTests(unittest.TestCase):
    def archive(self, names):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            for name, kind in names:
                item = tarfile.TarInfo(name)
                item.type = kind
                if kind == tarfile.SYMTYPE:
                    item.linkname = '../../outside'
                archive.addfile(item)
        data.seek(0)
        return tarfile.open(fileobj=data, mode='r')

    def test_archive_cannot_escape_or_replace_a_source_entry(self):
        for entries in [
            [(builder.TOP + '/../outside', tarfile.REGTYPE)],
            [(builder.TOP + '/link', tarfile.SYMTYPE)],
            [(builder.TOP + '/same', tarfile.REGTYPE)] * 2,
            [(builder.TOP + '/.env', tarfile.REGTYPE)],
        ]:
            with self.subTest(entries=entries), self.archive(entries) as archive:
                with self.assertRaises(ValueError):
                    builder.members(archive)

    def test_sources_are_rejected_before_any_output_is_created(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'not-a-runtime-input.tar.gz'
            source.write_bytes(b'not an archive')
            output = builder.HERE / 'must-not-create-source-output'
            self.assertFalse(output.exists())
            with self.assertRaisesRegex(ValueError, 'separate new directory'):
                builder.prepare(source, output, 'p18')
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
