/**
 * Build-only adapter for the pinned Payload UI 3.91.0 distribution.
 *
 * It rewrites named imports to the distribution's original modules, including
 * Payload's own relative imports back to its prebundled client entry. The
 * original files remain the module identities: no provider or Context copy is
 * generated. Only BulkUpload's heavy contents get a new dynamic module.
 *
 * Generated inputs live in app/dist (not node_modules) and are recreated on the
 * build host. This is deliberately version/shape specific; updating Payload
 * requires reviewing this adapter instead of silently mixing UI Contexts.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

import {comparable,fail,payloadUiClientVersion,sourceFile} from './payload-ui/source.mjs';
import {payloadUiDuplicateStyleSources} from './payload-ui/pinned-styles.mjs';
import {readDuplicateStyles} from './payload-ui/styles.mjs';
import {inspectBulkUpload,splitPayloadBulkUpload} from './payload-ui/modules.mjs';

export {payloadUiClientVersion} from './payload-ui/source.mjs';
export {payloadUiDuplicateStyleSources} from './payload-ui/pinned-styles.mjs';
export {validatePayloadUiDuplicateStyleInputs} from './payload-ui/styles.mjs';
export {splitPayloadBulkUpload,transformPayloadUiClientModule} from './payload-ui/modules.mjs';

// 329 direct re-exports plus the locally imported PopupList namespace and toast.
const expectedRuntimeExports = 331;
const scriptFile = fileURLToPath(import.meta.url);
const plans = new Map();
const adapterFiles = [scriptFile,...['source.mjs','pinned-styles.mjs','styles.mjs','modules.mjs'].map(name => fileURLToPath(new URL(`./payload-ui/${name}`,import.meta.url)))];

function readRuntimeExports(declaration, clientDirectory, uiRoot) {
  const tree = sourceFile(declaration, 'payload-client-exports.d.ts');
  const exports = new Map();
  const locals = new Map();
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) locals.set(bindings.name.text,{source:node.moduleSpecifier.text,importedName:'*'});
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly) locals.set(item.name.text,{source:node.moduleSpecifier.text,importedName:item.propertyName?.text??item.name.text});
  }
  for (const node of tree.statements) {
    if (!ts.isExportDeclaration(node) || node.isTypeOnly) continue;
    if ((node.moduleSpecifier && !ts.isStringLiteral(node.moduleSpecifier)) || !node.exportClause || !ts.isNamedExports(node.exportClause)) fail('Unsupported runtime export declaration.');
    for (const item of node.exportClause.elements) {
      if (item.isTypeOnly) continue;
      const publicName = item.name.text;
      const localName = item.propertyName?.text ?? publicName;
      const binding = node.moduleSpecifier ? {source:node.moduleSpecifier.text,importedName:localName} : locals.get(localName);
      if (!binding) fail(`Runtime export ${publicName} has no original import source.`);
      const {source,importedName} = binding;
      if (exports.has(publicName)) fail(`Duplicate runtime export ${publicName}.`);
      if (!source.startsWith('.')) {
        if (source !== 'sonner' || publicName !== 'toast' || importedName !== 'toast') fail(`Unsupported external UI export ${publicName}.`);
        exports.set(publicName,{publicName,importedName,filename:null,specifier:source});
        continue;
      }
      const candidate = path.resolve(clientDirectory,source);
      if (!candidate.startsWith(uiRoot + path.sep) || !fs.existsSync(candidate)) fail(`Missing original runtime module for ${publicName}.`);
      const filename = fs.realpathSync(candidate);
      exports.set(publicName,{publicName,importedName,filename});
    }
  }
  if (exports.size !== expectedRuntimeExports) fail(`Expected ${expectedRuntimeExports} runtime exports for ${payloadUiClientVersion}, received ${exports.size}.`);
  return exports;
}

export function validatePayloadUiClientMetadata(metadata) {
  if (metadata.name !== '@payloadcms/ui' || metadata.version !== payloadUiClientVersion || metadata.license !== 'MIT') fail(`This adapter requires @payloadcms/ui ${payloadUiClientVersion} (MIT); received ${metadata.name} ${metadata.version}.`);
}

/** Read the fixed distribution and return one canonical physical module map. */
export function readPayloadUiClientPlan(appRoot) {
  appRoot = fs.realpathSync(appRoot);
  if (plans.has(appRoot)) return plans.get(appRoot);
  const require = createRequire(path.join(appRoot,'package.json'));
  const clientEntry = fs.realpathSync(require.resolve('@payloadcms/ui'));
  const clientDirectory = path.dirname(clientEntry);
  const uiRoot = fs.realpathSync(path.resolve(clientDirectory,'../../..'));
  const metadataFile = path.join(uiRoot,'package.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile,'utf8'));
  validatePayloadUiClientMetadata(metadata);
  if (comparable(clientEntry) !== comparable(path.join(uiRoot,'dist/exports/client/index.js'))) fail('Payload client entry location changed.');
  const declarationFile = path.join(clientDirectory,'index.d.ts');
  const exports = readRuntimeExports(fs.readFileSync(declarationFile,'utf8'),clientDirectory,uiRoot);
  const bulkFile = fs.realpathSync(path.join(uiRoot,'dist/elements/BulkUpload/index.js'));
  const bulkSource = fs.readFileSync(bulkFile,'utf8');
  const bulk = inspectBulkUpload(bulkSource,bulkFile);
  const licenseFile = path.join(uiRoot,'LICENSE.md');
  const license = fs.readFileSync(licenseFile,'utf8');
  if (!license.includes('MIT License') || !license.includes('Payload CMS, Inc.')) fail('Payload MIT attribution is unavailable.');
  const generatedDirectory = path.join(appRoot,'dist/galaxy-payload-ui-client');
  const plan = {appRoot,uiRoot,clientEntry,declarationFile,metadataFile,bulkFile,bulkSource,bulk,exports,license,licenseFile,generatedDirectory,bodyFile:path.join(generatedDirectory,'BulkUploadContents.js'),loaderFile:path.join(generatedDirectory,'loader.cjs')};
  const duplicateStyles=readDuplicateStyles(plan,require);
  plan.duplicateStyles=duplicateStyles.styles;
  plan.styleDependencies=duplicateStyles.dependencies;
  plans.set(appRoot,plan);
  return plan;
}

function writeGenerated(filename,contents) {
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  if (!fs.existsSync(filename) || fs.readFileSync(filename,'utf8') !== contents) fs.writeFileSync(filename,contents);
}

/** Generate only derived build inputs; the installed package is read-only. */
export function preparePayloadUiClientImports(appRoot) {
  const plan = readPayloadUiClientPlan(appRoot);
  const {body} = splitPayloadBulkUpload(plan.bulkSource,plan);
  writeGenerated(plan.bodyFile,body);
  writeGenerated(path.join(plan.generatedDirectory,'PAYLOAD-LICENSE.md'),plan.license);
  // CJS is the loader-runner entry; the implementation remains in the ESM adapter modules.
  const loader = `module.exports = function galaxyPayloadUiLoader(source, map) {\n  const done = this.async();\n  const options = this.getOptions ? this.getOptions() : this.query;\n  const context = this;\n  import(${JSON.stringify(pathToFileURL(scriptFile).href)}).then(mod => {\n    const plan = mod.readPayloadUiClientPlan(options.appRoot);\n    for (const file of [plan.declarationFile, plan.metadataFile, plan.bulkFile, plan.licenseFile, ...plan.styleDependencies, ...${JSON.stringify(adapterFiles)}]) context.addDependency(file);\n    const result = mod.transformPayloadUiClientModule(String(source), {resourcePath: context.resourcePath, plan});\n    done(null, result, result === String(source) ? map : undefined);\n  }).catch(done);\n};\n`;
  writeGenerated(plan.loaderFile,loader);
  const use = {loader:plan.loaderFile,options:{appRoot:plan.appRoot}};
  const condition = {any:[
    {path:'**/node_modules/@payloadcms/ui/dist/elements/BulkUpload/index.js'},
    ...payloadUiDuplicateStyleSources.map(item=>({path:`**/node_modules/@payloadcms/ui/${item.source.replace(/\.scss$/,'.js')}`})),
    {content:/@payloadcms\/ui|exports[\\/]client[\\/]index\.js/},
  ]};
  return {
    plan,
    turbopackRules:Object.fromEntries(['*.js','*.mjs','*.jsx','*.ts','*.tsx'].map(glob => [glob,{condition,loaders:[use]}])),
    webpackRule:{test:/\.[cm]?[jt]sx?$/,enforce:'pre',use:[use]},
  };
}
