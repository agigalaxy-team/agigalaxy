import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {applyEdits,comparable,fail,moduleLiteral,payloadUiClientVersion,sourceFile,stripSourceMap} from './source.mjs';

const heavyImportBindings = new Map([
  ['payload/shared',['validateMimeType']],
  ['sonner',['toast']],
  ['../../providers/Config/index.js',['useConfig']],
  ['../../providers/EditDepth/index.js',['EditDepthProvider']],
  ['../../providers/Translation/index.js',['useTranslation']],
  ['../../providers/UploadControls/index.js',['UploadControlsProvider']],
  ['./AddFilesView/index.js',['AddFilesView']],
  ['./AddingFilesView/index.js',['AddingFilesView']],
  ['./FormsManager/index.js',['FormsManagerProvider','useFormsManager']],
]);

export function inspectBulkUpload(source, filename) {
  const tree = sourceFile(source,filename);
  const content = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'DrawerContent');
  const providers = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'BulkUploadProvider');
  const drawers = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'BulkUploadDrawer');
  const contexts = tree.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).filter(node => node.name.getText(tree) === 'Context');
  if (content.length !== 1 || providers.length !== 1 || drawers.length !== 1 || contexts.length !== 1) fail('BulkUpload provider/drawer/Context shape changed.');
  if (!ts.isCallExpression(contexts[0].initializer) || contexts[0].initializer.expression.getText(tree) !== 'React.createContext') fail('BulkUpload Context is no longer the expected original module Context.');
  const imports = tree.statements.filter(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && heavyImportBindings.has(node.moduleSpecifier.text));
  if (imports.length !== heavyImportBindings.size) fail('BulkUpload contents import set changed.');
  for (const node of imports) {
    const expected = heavyImportBindings.get(node.moduleSpecifier.text);
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== expected.length || bindings.elements.some((item,index) => item.name.text !== expected[index] || item.propertyName || item.isTypeOnly)) fail(`BulkUpload import bindings changed: ${node.moduleSpecifier.text}.`);
  }
  const expressions = [];
  const walk = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === '_jsx' && node.arguments[0]?.getText(tree) === 'FormsManagerProvider') expressions.push(node);
    ts.forEachChild(node,walk);
  };
  walk(drawers[0]);
  if (expressions.length !== 1) fail('BulkUpload heavy contents boundary changed.');
  const expression = expressions[0];
  // These are the three original provider wrappers, not a substitute upload UI.
  const body = expression.getText(tree);
  if (!body.includes('_jsx(UploadControlsProvider,') || !body.includes('_jsx(EditDepthProvider,') || !body.includes('_jsx(DrawerContent,')) fail('BulkUpload contents providers changed.');
  if (!providers[0].getText(tree).includes('_jsx(BulkUploadDrawer, {})')) fail('BulkUpload drawer mount changed.');
  return {tree,content:content[0],provider:providers[0],drawer:drawers[0],contexts,imports,expression};
}

function isClientEntry(specifier,resourcePath,plan) {
  if (specifier === '@payloadcms/ui') return true;
  if (!specifier.endsWith('/exports/client/index.js') && !specifier.endsWith('\\exports\\client\\index.js')) return false;
  const resolved = path.isAbsolute(specifier) ? specifier : path.resolve(path.dirname(resourcePath),specifier);
  return fs.existsSync(resolved) && comparable(fs.realpathSync(resolved)) === comparable(plan.clientEntry);
}

function requireExport(plan,name) {
  const entry = plan.exports.get(name);
  if (!entry) fail(`Unknown runtime UI export ${name}; review the pinned import map.`);
  return entry;
}

function namedImports(node,tree,plan,resourcePath) {
  if (node.importClause?.isTypeOnly) return null;
  if (!node.importClause || node.importClause.name || !node.importClause.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) || node.attributes) fail('Only named UI imports are supported; do not fall back to a second prebundled Context.');
  const groups = new Map();
  const namespaces = [];
  const types = [];
  for (const item of node.importClause.namedBindings.elements) {
    if (item.isTypeOnly) { types.push(item.getText(tree).replace(/^type\s+/,'')); continue; }
    const entry = requireExport(plan,item.propertyName?.text ?? item.name.text);
    const localName = item.name.text;
    if (entry.importedName === '*') { namespaces.push(`import * as ${localName} from ${moduleLiteral(resourcePath,entry.filename)};`); continue; }
    const binding = entry.importedName === localName ? localName : `${entry.importedName} as ${localName}`;
    const target=entry.specifier??entry.filename;
    const group = groups.get(target) ?? [];
    group.push(binding); groups.set(target,group);
  }
  const declarations = [...groups].map(([filename,bindings]) => `import {${bindings.join(', ')}} from ${moduleLiteral(resourcePath,filename)};`).concat(namespaces);
  if (types.length) declarations.push(`import type {${types.join(', ')}} from ${node.moduleSpecifier.getText(tree)};`);
  return declarations.join('\n');
}

function namedExports(node,tree,plan,resourcePath) {
  if (node.isTypeOnly) return null;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.attributes) fail('Only named UI re-exports are supported; a full entry would reload the prebundle.');
  const groups = new Map();
  const namespaces = [];
  const types = [];
  for (const item of node.exportClause.elements) {
    if (item.isTypeOnly) { types.push(item.getText(tree).replace(/^type\s+/,'')); continue; }
    const entry = requireExport(plan,item.propertyName?.text ?? item.name.text);
    if (entry.importedName === '*') { namespaces.push(`export * as ${item.name.text} from ${moduleLiteral(resourcePath,entry.filename)};`); continue; }
    const binding = entry.importedName === item.name.text ? item.name.text : `${entry.importedName} as ${item.name.text}`;
    const target=entry.specifier??entry.filename;
    const group = groups.get(target) ?? [];
    group.push(binding); groups.set(target,group);
  }
  const declarations = [...groups].map(([filename,bindings]) => `export {${bindings.join(', ')}} from ${moduleLiteral(resourcePath,filename)};`).concat(namespaces);
  if (types.length) declarations.push(`export type {${types.join(', ')}} from ${node.moduleSpecifier.getText(tree)};`);
  return declarations.join('\n');
}

function licenseComment(plan) {
  return `/*! Derived from @payloadcms/ui ${payloadUiClientVersion}.\n${plan.license.trim()}\n*/\n`;
}

/** Split only the heavy child tree. The provider, Context and reset effect stay. */
export function splitPayloadBulkUpload(source,plan) {
  const bulk = inspectBulkUpload(source,plan.bulkFile);
  const edits = [
    {start:bulk.content.getStart(bulk.tree),end:bulk.content.end,text:''},
    {start:bulk.expression.getStart(bulk.tree),end:bulk.expression.end,text:'_jsx(React.Suspense, {fallback: null, children: _jsx(GalaxyBulkUploadContents, {})})'},
    ...bulk.imports.map(node => ({start:node.getStart(bulk.tree),end:node.end,text:''})),
  ];
  const light = licenseComment(plan) + stripSourceMap(applyEdits(source,edits)) + `\nconst GalaxyBulkUploadContents = React.lazy(() => import(${moduleLiteral(plan.bulkFile,plan.bodyFile)}));\n`;
  const heavyImports = bulk.imports.map(node => {
    const original = node.moduleSpecifier.text;
    const target = original.startsWith('.') ? moduleLiteral(plan.bodyFile,path.resolve(path.dirname(plan.bulkFile),original)) : node.moduleSpecifier.getText(bulk.tree);
    return applyEdits(node.getText(bulk.tree),[{start:node.moduleSpecifier.getStart(bulk.tree)-node.getStart(bulk.tree),end:node.moduleSpecifier.end-node.getStart(bulk.tree),text:target}]);
  });
  const body = licenseComment(plan) + `'use client';\nimport React from 'react';\nimport {jsx as _jsx} from 'react/jsx-runtime';\nimport {useModal} from '@faceless-ui/modal';\nimport {useBulkUpload} from ${moduleLiteral(plan.bodyFile,plan.bulkFile)};\n${heavyImports.join('\n')}\n${bulk.content.getText(bulk.tree)}\nexport default function BulkUploadContents() { return ${bulk.expression.getText(bulk.tree)}; }\n`;
  return {light,body};
}

/** Also handles raw Payload files importing their own relative prebundle entry. */
export function transformPayloadUiClientModule(source,{resourcePath,plan}) {
  if (comparable(resourcePath) === comparable(plan.clientEntry)) fail('The prebundled UI entry was still reached; review the importing module instead of loading a second Context set.');
  if (comparable(resourcePath) === comparable(plan.bulkFile)) return splitPayloadBulkUpload(source,plan).light;
  const duplicateStyle=plan.duplicateStyles.has(comparable(resourcePath));
  if (!duplicateStyle && !source.includes('@payloadcms/ui') && !source.includes('exports/client/index.js') && !source.includes('exports\\client\\index.js')) return source;
  const tree = sourceFile(source,resourcePath);
  const edits = [];
  if (duplicateStyle) {
    const styles=tree.statements.filter(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='./index.scss');
    if (styles.length!==1||styles[0].importClause||styles[0].attributes) fail(`Reviewed SCSS side-effect import changed in ${resourcePath}.`);
    edits.push({start:styles[0].getStart(tree),end:styles[0].end,text:''});
  }
  for (const node of tree.statements) {
    if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier) || !isClientEntry(node.moduleSpecifier.text,resourcePath,plan)) continue;
    const text = ts.isImportDeclaration(node) ? namedImports(node,tree,plan,resourcePath) : namedExports(node,tree,plan,resourcePath);
    if (text !== null) edits.push({start:node.getStart(tree),end:node.end,text});
  }
  const checkDynamic = node => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) && isClientEntry(node.arguments[0].text,resourcePath,plan)) fail(`Dynamic/full UI entry in ${resourcePath}; use named imports so Contexts remain shared.`);
    ts.forEachChild(node,checkDynamic);
  };
  checkDynamic(tree);
  return edits.length ? stripSourceMap(applyEdits(source,edits)) : source;
}
