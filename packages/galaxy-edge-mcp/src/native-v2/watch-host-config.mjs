import * as z from 'zod/v4';
import {isAbsolute} from 'node:path';
import {createCodexAppServerDriver} from './host-adapters/codex-app-server.mjs';
import {createClaudeCodeDriver} from './host-adapters/claude-code.mjs';

// This is local trusted configuration, never a tool/model supplied command.
// It grants no room permission and enables no model until a separate choice.
const localCommand={command:z.string().min(1).max(4000).refine(isAbsolute),cwd:z.string().min(1).max(4000).refine(isAbsolute)};
export const nativeWatchHostConfigSchema=z.discriminatedUnion('kind',[z.strictObject({
 kind:z.literal('codex-app-server'),
 ...localCommand,
 disabledMcpServers:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(64).refine(names=>new Set(names).size===names.length).default([]),
}),z.strictObject({kind:z.literal('claude-code'),...localCommand})]);
export function createConfiguredWatchHost(configuration,{createDriver}={}){
 if(configuration===undefined||configuration===null)return null;
 const parsed=nativeWatchHostConfigSchema.parse(configuration);
 const factory=createDriver??(parsed.kind==='claude-code'?createClaudeCodeDriver:createCodexAppServerDriver);
 // A JSON configuration cannot assert that managed reader settings are safe.
 // Claude's production factory keeps its effective-profile gate fail-closed.
 return Object.freeze({configuration:parsed,createDriver:()=>factory({command:parsed.command,cwd:parsed.cwd,
  ...(parsed.kind==='codex-app-server'?{disabledMcpServers:parsed.disabledMcpServers}:{})})});
}
