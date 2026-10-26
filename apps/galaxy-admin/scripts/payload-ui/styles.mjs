import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {comparable,fail,payloadUiClientVersion,sourceFile} from './source.mjs';
import {payloadUiDuplicateStyleSources,pinnedGlobalStyleRules} from './pinned-styles.mjs';

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

export function readDuplicateStyles(plan,require) {
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
