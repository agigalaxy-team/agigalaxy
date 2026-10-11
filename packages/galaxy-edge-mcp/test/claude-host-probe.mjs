import {writeFile} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {createClaudeCodeDriver} from '../src/native-v2/host-adapters/claude-code.mjs';
const [command,reportPath]=process.argv.slice(2);
if(!isAbsolute(command??'')||!isAbsolute(reportPath??''))throw Error('absolute_host_and_report_paths_required');
const driver=createClaudeCodeDriver({command,cwd:process.cwd()});
try{
  const capabilities=await driver.capabilities();
  const report={schemaVersion:1,observedAt:new Date().toISOString(),scope:'installed-cli-version-help-only',capabilities,
    hostSessionCreates:0,modelTurnsStarted:0,userPromptSent:false,globalConfigurationChanged:false,backgroundServiceInstalled:false,
    originalTurnRecovery:'missing terminal remains unknown; no session resume or inference used'};
  await writeFile(resolve(reportPath),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({reportPath:resolve(reportPath),version:capabilities.version,
    readerProfileDocumented:capabilities.readerProfileDocumented,readerConfigurationConfirmed:capabilities.readerConfigurationConfirmed,modelTurnsStarted:0})+'\n');
}finally{await driver.close();}
