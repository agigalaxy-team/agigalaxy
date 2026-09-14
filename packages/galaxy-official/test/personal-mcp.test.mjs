import test from 'node:test';
import { verifyPersonalMcp } from './personal-mcp-workflow.mjs';
test('independent MCP SDK discovers OAuth and uses PKCE/resource tokens with live Galaxy authorization and Consent', {timeout:60000},()=>verifyPersonalMcp());
