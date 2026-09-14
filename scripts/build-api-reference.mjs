import { readFile,writeFile,readdir } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { resolve,relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { businessApiReference,specialApiReference } from '../packages/galaxy-official/api-reference.mjs';
import { migrations } from '../packages/galaxy-official/src/infrastructure/migrations.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
async function sourceFiles(directory){const files=[];for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory())files.push(...await sourceFiles(resolve(directory,entry.name)));
  else if(entry.name.endsWith('.mjs'))files.push(resolve(directory,entry.name));
}return files.sort((a,b)=>a<b?-1:a>b?1:0);}
export async function buildApiReference({check=false}={}) {
  const sources={},errors=[];
  for(const path of await sourceFiles(resolve(root,'packages/galaxy-official/src'))){
    const name=relative(root,path).replaceAll('\\','/'),source=await readFile(path,'utf8');sources[name]=sha(source);
    const tree=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const visit=node=>{
      if(ts.isNewExpression(node)&&node.expression.getText(tree)==='ServiceError'&&node.arguments?.length&&ts.isStringLiteral(node.arguments[0])){
        const status=node.arguments[1];errors.push({code:node.arguments[0].text,status:status===undefined?400:ts.isNumericLiteral(status)?Number(status.text):null,
          source:name,line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1});
      }
      ts.forEachChild(node,visit);
    };visit(tree);
  }
  const entries=[...businessApiReference,...specialApiReference];
  const catalog={version:1,kind:'development-source-reference-not-deployed-api',publicApiEndpoints:[],
    serviceVersion:JSON.parse(await readFile(resolve(root,'packages/galaxy-official/package.json'),'utf8')).version,schema:migrations.at(-1).version,
    endpointPolicy:'Paths are relative to an explicitly configured isolated service; no production base URL, OAuth credential or runnable public server is supplied.',
    entries,sources};
  const lines=['# 当前开发 API 目录 v1','','由实际路由、独立分发检查及显式接口描述生成。本文件是开发参考，公开 API 端点列表为空；目标服务的部署和运行状态以具体部署记录为准。不能把官网域名作为这里的服务器地址。',
    '',`当前服务 ${catalog.serviceVersion}；Schema${catalog.schema}；${businessApiReference.length} 个业务路由与 ${specialApiReference.length} 个发现、协议或内部路由。`,
    '', 'GET/DELETE 的 Personal MCP 条目明确为认证后405；不是成功可用操作。所有方法和配置条件见 [JSON目录](development-api-reference-v1.json)。',
    '', '## 请求与授权', '', '严格 HTTP JSON 和字节限制、错误、分页及重试见 [API行为约定](api-behavior-v0.1.md)。`galaxy-session` 是既有版本化会话，不能当作 OAuth；`optional-galaxy-session` 只允许匿名读取当前公开投影，提供失效凭据不会降级为匿名。`none` 表示没有 Bearer 要求，挑战/绑定/签名状态等接口仍须验证其专用证明。',
    '', '`query-type` 的 scope 映射：case/history→history、proof→proof、capsule→capsules、worker/hub→builders。审核角色、可见性、精确Consent与当前来源另外检查。查询参数仅适用于 Consent after 与 OIDC 回调，其他分页参数在 POST body 中。',
    '', 'JSON中 input.fields 是精确顶层字段；input.schema 指向业务 schema 源文件，文件内各操作定义以对应 service.operation 为准，不代表任意该文件对象均可提交。signed/payloadJson 均保持原签名字节，不能由 Agent 根据文档自行签发。',
    '', '## 业务路由', '', '| 方法与路径 | 认证 / Scope | 服务方法 | 详细说明 |','|---|---|---|---|'];
  for(const entry of businessApiReference)lines.push(`| ${entry.method} \`${entry.path}\` | ${entry.authentication}${entry.scope?' / '+entry.scope:''} | ${entry.service}.${entry.operation} | [说明](${entry.documentation}) |`);
  lines.push('','## 发现、协议与内部入口','','| 方法与路径 | 行为 | 详细说明 |','|---|---|---|');
  for(const entry of specialApiReference)lines.push(`| ${entry.method} \`${entry.path}\` | ${entry.meaning} | [说明](${entry.documentation}) |`);
  lines.push('','## 重建和使用','','`node scripts/build-api-reference.mjs` 重建目录及错误字面量索引；`--check` 只检查文件是否匹配。来源扫描限于 Official src，不读取工作区凭据或项目归档。错误索引包含静态 ServiceError 声明；动态/库错误及每个端点的可达状态不由静态扫描推断。',
    '', 'AI Agent应先读取版本、配置和目标模块说明，再在明确隔离的服务上使用对应便携客户端或原生宿主。验证入口 `node --test packages/galaxy-official/test/api-reference.test.mjs` 检查路由、认证要求、代理可达性和生成目录；业务真实性仍由对应业务工作流和生产验收证明。','');
  const outputs={'docs/development-api-reference-v1.json':JSON.stringify(catalog,null,2)+'\n','docs/development-api-reference-v1.md':lines.join('\n'),
    'docs/api-error-catalog-v0.1.json':JSON.stringify({version:1,kind:'static-literal-declarations-not-exhaustive-runtime-reachability',entries:errors},null,2)+'\n'};
  for(const [name,content] of Object.entries(outputs)){
    if(check){if(await readFile(resolve(root,name),'utf8')!==content)throw new Error('Stale generated API reference: '+name);}
    else await writeFile(resolve(root,name),content);
  }
  return {businessRoutes:businessApiReference.length,specialRoutes:specialApiReference.length,errorDeclarations:errors.length,sourceFiles:Object.keys(sources).length,check};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await buildApiReference({check:process.argv.includes('--check')})));
