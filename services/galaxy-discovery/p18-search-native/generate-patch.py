"""Generate only the new chart admission patch against the current API source."""
import difflib
import pathlib

root=pathlib.Path(__file__).resolve().parent
relative='apps/api/src/controllers/export.controller.ts'
original=(root/'current-reference'/relative).read_text(encoding='utf-8')
needle='''        z.object({
          name: z.string(),'''
if original.count(needle)!=2:
    raise RuntimeError('Expected exactly the native series and legacy events schemas')
modified=original.replace(needle,'''        z.object({
          // Galaxy 2026-10-23: keep caller series identity through native sorting.
          id: z.string().min(1).max(100).optional(),
          name: z.string(),''')
needle='''  return ChartEngine.execute({'''
if modified.count(needle)!=1:
    raise RuntimeError('Expected exactly the chart execution return')
modified=modified.replace(needle,'''  reply.header('Link', '<https://agigalaxy.org/open-source/openpanel-public2-galaxy-search-20261023/source.tar.gz>; rel="source"');
  return ChartEngine.execute({''')
(root/'search-series-id.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True),modified.splitlines(True),fromfile='a/'+relative,tofile='b/'+relative)),encoding='utf-8',newline='\n')
(root/'modified-source'/relative).parent.mkdir(parents=True,exist_ok=True)
(root/'modified-source'/relative).write_text(modified,encoding='utf-8',newline='\n')
