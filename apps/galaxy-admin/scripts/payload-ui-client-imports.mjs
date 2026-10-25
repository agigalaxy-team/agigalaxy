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

export const payloadUiClientVersion = '3.91.0';
// 329 direct re-exports plus the locally imported PopupList namespace and toast.
const expectedRuntimeExports = 331;
const scriptFile = fileURLToPath(import.meta.url);
const plans = new Map();
const forward = value => value.replaceAll('\\', '/');
const comparable = value => process.platform === 'win32' ? forward(value).toLowerCase() : forward(value);
const literal = value => JSON.stringify(forward(value));
const fail = message => { throw new Error(`[galaxy-payload-ui] ${message}`); };

/*! Pinned SCSS excerpts from @payloadcms/ui 3.91.0.
MIT License

Copyright (c) 2018-2025 Payload CMS, Inc. <info@payloadcms.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
export const payloadUiDuplicateStyleSources = Object.freeze([
  {
    "source": "dist/providers/RouteTransition/ProgressBar/index.scss",
    "expectedSource": "@layer payload-default {\n  .progress-bar {\n    position: fixed;\n    top: 0;\n    left: 0;\n    width: 100%;\n    height: 2px;\n    z-index: 9999;\n    opacity: 1;\n\n    &__progress {\n      height: 100%;\n      background-color: var(--theme-elevation-1000);\n      transition: width ease-in var(--transition-duration);\n    }\n\n    &--fade-out {\n      opacity: 0;\n      transition: opacity linear var(--transition-duration);\n      transition-delay: var(--transition-duration);\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/X/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--x {\n    .stroke {\n      stroke: currentColor;\n      stroke-width: $style-stroke-width-s;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/More/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--more {\n    height: $baseline;\n    width: $baseline;\n\n    .fill {\n      fill: var(--theme-elevation-800);\n      stroke: currentColor;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/fields/FieldLabel/index.scss",
    "expectedSource": "@import '../../scss/styles.scss';\n\n@layer payload-default {\n  label.field-label {\n    display: flex;\n    align-items: center;\n  }\n\n  label.field-label:not(.unstyled) {\n    @extend %body;\n    display: flex;\n    padding-bottom: base(0.25);\n    color: var(--theme-elevation-800);\n    font-family: var(--font-body);\n    [dir='ltr'] & {\n      margin-right: auto;\n    }\n    [dir='rtl'] & {\n      margin-left: auto;\n    }\n\n    .required {\n      color: var(--theme-error-500);\n    }\n\n    .required {\n      [dir='ltr'] & {\n        margin-left: base(0.25);\n      }\n      [dir='rtl'] & {\n        margin-right: base(0.25);\n      }\n    }\n  }\n\n  .localized {\n    @extend %body;\n    [dir='ltr'] & {\n      margin-left: base(0.25);\n    }\n    [dir='rtl'] & {\n      margin-right: base(0.25);\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/Check/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--check {\n    height: $baseline;\n    width: $baseline;\n\n    .stroke {\n      fill: none;\n      stroke: currentColor;\n      stroke-width: $style-stroke-width-m;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/icons/Line/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .icon--line {\n    width: $baseline;\n    height: $baseline;\n\n    .stroke {\n      stroke: currentColor;\n      stroke-width: $style-stroke-width;\n    }\n  }\n}\n"
  },
  {
    "source": "dist/elements/IDLabel/index.scss",
    "expectedSource": "@import '../../scss/styles';\n\n@layer payload-default {\n  .id-label {\n    font-size: base(0.8);\n    line-height: base(1.2);\n    font-weight: normal;\n    color: var(--theme-elevation-600);\n    background: var(--theme-elevation-100);\n    padding: base(0.2) base(0.4);\n    border-radius: $style-radius-m;\n    display: inline-flex;\n    width: fit-content;\n  }\n}\n"
  },
  {
    "source": "dist/elements/RenderTitle/index.scss",
    "expectedSource": "@import '../../scss/styles.scss';\n\n@layer payload-default {\n  .render-title {\n    display: inline-block;\n    &__id {\n      vertical-align: middle;\n      position: relative;\n    }\n  }\n}\n"
  }
]);
// Full original-distribution rules, including declaration order and layer context.
// Deployment-minified equality was separately proved against the emitted CSS.
const pinnedGlobalStyleRules = Object.freeze([
  {
    "selector": ".icon--x .stroke",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      },
      {
        "property": "stroke-width",
        "value": "1px",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--more",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "height",
        "value": "1.5384615385rem",
        "important": false
      },
      {
        "property": "width",
        "value": "1.5384615385rem",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--more .fill",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "fill",
        "value": "var(--theme-elevation-800)",
        "important": false
      },
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      }
    ]
  },
  {
    "selector": ".localized",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "font-size",
        "value": "13px",
        "important": false
      },
      {
        "property": "line-height",
        "value": "20px",
        "important": false
      },
      {
        "property": "font-weight",
        "value": "400",
        "important": false
      },
      {
        "property": "font-family",
        "value": "var(--font-body)",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "font-size",
        "value": "13px",
        "important": false
      },
      {
        "property": "line-height",
        "value": "20px",
        "important": false
      },
      {
        "property": "font-weight",
        "value": "400",
        "important": false
      },
      {
        "property": "font-family",
        "value": "var(--font-body)",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "display",
        "value": "flex",
        "important": false
      },
      {
        "property": "align-items",
        "value": "center",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "display",
        "value": "flex",
        "important": false
      },
      {
        "property": "padding-bottom",
        "value": "5px",
        "important": false
      },
      {
        "property": "color",
        "value": "var(--theme-elevation-800)",
        "important": false
      },
      {
        "property": "font-family",
        "value": "var(--font-body)",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=ltr] label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-right",
        "value": "auto",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=rtl] label.field-label:not(.unstyled)",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-left",
        "value": "auto",
        "important": false
      }
    ]
  },
  {
    "selector": "label.field-label:not(.unstyled) .required",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "color",
        "value": "var(--theme-error-500)",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=ltr] label.field-label:not(.unstyled) .required",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-left",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=rtl] label.field-label:not(.unstyled) .required",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-right",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=ltr] .localized",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-left",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": "[dir=rtl] .localized",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "margin-right",
        "value": "5px",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--check",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "height",
        "value": "1.5384615385rem",
        "important": false
      },
      {
        "property": "width",
        "value": "1.5384615385rem",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--check .stroke",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "fill",
        "value": "none",
        "important": false
      },
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      },
      {
        "property": "stroke-width",
        "value": "2px",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--line",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "width",
        "value": "1.5384615385rem",
        "important": false
      },
      {
        "property": "height",
        "value": "1.5384615385rem",
        "important": false
      }
    ]
  },
  {
    "selector": ".icon--line .stroke",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "stroke",
        "value": "currentColor",
        "important": false
      },
      {
        "property": "stroke-width",
        "value": "1px",
        "important": false
      }
    ]
  },
  {
    "selector": ".id-label",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "font-size",
        "value": "16px",
        "important": false
      },
      {
        "property": "line-height",
        "value": "24px",
        "important": false
      },
      {
        "property": "font-weight",
        "value": "400",
        "important": false
      },
      {
        "property": "color",
        "value": "var(--theme-elevation-600)",
        "important": false
      },
      {
        "property": "background",
        "value": "var(--theme-elevation-100)",
        "important": false
      },
      {
        "property": "padding",
        "value": "4px 8px",
        "important": false
      },
      {
        "property": "border-radius",
        "value": "4px",
        "important": false
      },
      {
        "property": "display",
        "value": "inline-flex",
        "important": false
      },
      {
        "property": "width",
        "value": "fit-content",
        "important": false
      }
    ]
  },
  {
    "selector": ".render-title",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "display",
        "value": "inline-block",
        "important": false
      }
    ]
  },
  {
    "selector": ".render-title__id",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "vertical-align",
        "value": "middle",
        "important": false
      },
      {
        "property": "position",
        "value": "relative",
        "important": false
      }
    ]
  },
  {
    "selector": ".progress-bar",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "position",
        "value": "fixed",
        "important": false
      },
      {
        "property": "top",
        "value": "0",
        "important": false
      },
      {
        "property": "left",
        "value": "0",
        "important": false
      },
      {
        "property": "width",
        "value": "100%",
        "important": false
      },
      {
        "property": "height",
        "value": "2px",
        "important": false
      },
      {
        "property": "z-index",
        "value": "9999",
        "important": false
      },
      {
        "property": "opacity",
        "value": "1",
        "important": false
      }
    ]
  },
  {
    "selector": ".progress-bar__progress",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "height",
        "value": "100%",
        "important": false
      },
      {
        "property": "background-color",
        "value": "var(--theme-elevation-1000)",
        "important": false
      },
      {
        "property": "transition",
        "value": "width ease-in var(--transition-duration)",
        "important": false
      }
    ]
  },
  {
    "selector": ".progress-bar--fade-out",
    "context": "@layer payload-default",
    "declarations": [
      {
        "property": "opacity",
        "value": "0",
        "important": false
      },
      {
        "property": "transition",
        "value": "opacity linear var(--transition-duration)",
        "important": false
      },
      {
        "property": "transition-delay",
        "value": "var(--transition-duration)",
        "important": false
      }
    ]
  }
]);

function globalStyleRules(source,postcss) {
  const selectors=new Set(pinnedGlobalStyleRules.map(rule=>rule.selector));
  const rows=[];
  const tree=postcss.parse(source);
  tree.walkRules(rule=>{
    const declarations=rule.nodes.filter(node=>node.type==='decl').map(node=>({property:node.prop,value:node.value,important:Boolean(node.important)}));
    if (!declarations.length) return;
    const context=[];
    for (let parent=rule.parent;parent&&parent.type!=='root';parent=parent.parent) if (parent.type==='atrule') context.unshift(`@${parent.name} ${parent.params}`);
    for (const selector of rule.selectors) if (selectors.has(selector)) rows.push({selector,context:context.join(' / '),declarations});
  });
  return rows;
}

/** Validate the reviewed source inputs before suppressing any style import. */
export function validatePayloadUiDuplicateStyleInputs({metadata,layoutSource,globalSource,scssSources,postcss}) {
  if (metadata.name!=='@payloadcms/next'||metadata.version!==payloadUiClientVersion||metadata.license!=='MIT') fail('Duplicate styles require the matching @payloadcms/next 3.91.0 MIT distribution.');
  const cssExport=metadata.exports?.['./css'];
  if (cssExport?.import!=='./dist/prod/styles.css'||cssExport?.default!=='./dist/prod/styles.css') fail('The reviewed Payload global CSS export changed.');
  const layout=sourceFile(layoutSource,'payload-layout.tsx');
  const imports=layout.statements.filter(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='@payloadcms/next/css');
  if (imports.length!==1||imports[0].importClause||imports[0].attributes) fail('The root layout must retain its one direct Payload global CSS side-effect import.');
  for (const item of payloadUiDuplicateStyleSources) if (typeof scssSources[item.source]!=='string'||scssSources[item.source].replaceAll('\r\n','\n')!==item.expectedSource) fail(`Reviewed SCSS source changed: ${item.source}.`);
  if (JSON.stringify(globalStyleRules(globalSource,postcss))!==JSON.stringify(pinnedGlobalStyleRules)) fail('The complete reviewed global style rules/declarations/layer contexts changed.');
}

function readDuplicateStyles(plan,require) {
  const globalFile=fs.realpathSync(require.resolve('@payloadcms/next/css'));
  const nextRoot=fs.realpathSync(path.resolve(path.dirname(globalFile),'../..'));
  if (comparable(globalFile)!==comparable(path.join(nextRoot,'dist/prod/styles.css'))) fail('Payload global CSS physical source changed.');
  const nextMetadataFile=path.join(nextRoot,'package.json');
  const metadata=JSON.parse(fs.readFileSync(nextMetadataFile,'utf8'));
  const layoutFile=path.join(plan.appRoot,'src/app/(payload)/layout.tsx');
  const scssSources={};
  const styles=new Map();
  const dependencies=[globalFile,nextMetadataFile,layoutFile];
  for (const item of payloadUiDuplicateStyleSources) {
    const scssFile=fs.realpathSync(path.join(plan.uiRoot,item.source));
    const importer=fs.realpathSync(scssFile.replace(/\.scss$/,'.js'));
    if (comparable(scssFile)!==comparable(path.join(plan.uiRoot,item.source))) fail('Reviewed SCSS moved outside the original UI module.');
    scssSources[item.source]=fs.readFileSync(scssFile,'utf8');
    styles.set(comparable(importer),{scssFile,importer});
    dependencies.push(scssFile,importer);
  }
  validatePayloadUiDuplicateStyleInputs({metadata,layoutSource:fs.readFileSync(layoutFile,'utf8'),globalSource:fs.readFileSync(globalFile,'utf8'),scssSources,postcss:require('postcss')});
  return {styles,dependencies};
}

// Turbopack treats a leading / as a project-root request, not a filesystem path.
// Keep the physical target but express it from the actual importing module.
function moduleLiteral(resourcePath,target) {
  if (!path.isAbsolute(target)) return literal(target);
  if (!path.isAbsolute(resourcePath)) fail('A physical importing module path is required.');
  const relative = forward(path.relative(path.dirname(resourcePath),target));
  if (!relative || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) fail('UI modules must be reachable through relative imports on the same filesystem.');
  return literal(relative.startsWith('.') ? relative : `./${relative}`);
}

function sourceFile(source, filename) {
  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind);
  if (tree.parseDiagnostics.length) fail(`Cannot parse ${filename}: ${ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText, ' ')}`);
  return tree;
}

function applyEdits(source, edits) {
  let next = source;
  let boundary = source.length;
  for (const edit of [...edits].sort((a,b) => b.start-a.start)) {
    if (edit.end > boundary || edit.start > edit.end) fail('Overlapping source edits; upstream shape needs review.');
    next = next.slice(0,edit.start) + edit.text + next.slice(edit.end);
    boundary = edit.start;
  }
  return next;
}

function stripSourceMap(source) {
  return source.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '');
}

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

function inspectBulkUpload(source, filename) {
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
  // CJS is the loader-runner entry; the implementation remains this one ESM source.
  const loader = `module.exports = function galaxyPayloadUiLoader(source, map) {\n  const done = this.async();\n  const options = this.getOptions ? this.getOptions() : this.query;\n  const context = this;\n  import(${JSON.stringify(pathToFileURL(scriptFile).href)}).then(mod => {\n    const plan = mod.readPayloadUiClientPlan(options.appRoot);\n    for (const file of [plan.declarationFile, plan.metadataFile, plan.bulkFile, plan.licenseFile, ...plan.styleDependencies, ${JSON.stringify(scriptFile)}]) context.addDependency(file);\n    const result = mod.transformPayloadUiClientModule(String(source), {resourcePath: context.resourcePath, plan});\n    done(null, result, result === String(source) ? map : undefined);\n  }).catch(done);\n};\n`;
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
