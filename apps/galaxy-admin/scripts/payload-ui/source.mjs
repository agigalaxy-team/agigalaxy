import path from 'node:path';
import ts from 'typescript';

export const payloadUiClientVersion = '3.91.0';
export const forward = value => value.replaceAll('\\', '/');
export const comparable = value => process.platform === 'win32' ? forward(value).toLowerCase() : forward(value);
export const literal = value => JSON.stringify(forward(value));
export const fail = message => { throw new Error(`[galaxy-payload-ui] ${message}`); };

// Turbopack treats a leading / as a project-root request, not a filesystem path.
// Keep the physical target but express it from the actual importing module.
export function moduleLiteral(resourcePath,target) {
  if (!path.isAbsolute(target)) return literal(target);
  if (!path.isAbsolute(resourcePath)) fail('A physical importing module path is required.');
  const relative = forward(path.relative(path.dirname(resourcePath),target));
  if (!relative || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) fail('UI modules must be reachable through relative imports on the same filesystem.');
  return literal(relative.startsWith('.') ? relative : `./${relative}`);
}

export function sourceFile(source, filename) {
  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind);
  if (tree.parseDiagnostics.length) fail(`Cannot parse ${filename}: ${ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText, ' ')}`);
  return tree;
}

export function applyEdits(source, edits) {
  let next = source;
  let boundary = source.length;
  for (const edit of [...edits].sort((a,b) => b.start-a.start)) {
    if (edit.end > boundary || edit.start > edit.end) fail('Overlapping source edits; upstream shape needs review.');
    next = next.slice(0,edit.start) + edit.text + next.slice(edit.end);
    boundary = edit.start;
  }
  return next;
}

export function stripSourceMap(source) {
  return source.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '');
}
