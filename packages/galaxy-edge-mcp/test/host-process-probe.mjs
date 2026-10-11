import {writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createCodexAppServerDriver} from '../src/native-v2/host-adapters/codex-app-server.mjs';

// Explicit read-only process probe. It never creates/resumes a thread, starts a
// turn, changes accounts/settings or records model/session contents.
const [command,outputPath]=process.argv.slice(2);
if(!command||!outputPath)throw Error('probe_arguments_required');
const driver=createCodexAppServerDriver({command,cwd:process.cwd()});
try{
  const capabilities=await driver.capabilities();
  const report={timestamp:new Date().toISOString(),action:'codex-host-capability-handshake',outcome:'passed',
    host:'codex-app-server',installedCliVersion:capabilities.process.userAgent?.match(/Codex Desktop\/([^ ]+)/)?.[1]??null,initialized:capabilities.initialized,
    process:capabilities.process,availableModels:capabilities.models.map(item=>item.model??item.id),nextCursor:capabilities.nextCursor,
    readerConfigurationConfirmed:capabilities.readerConfigurationConfirmed,
    readerConfigurationError:capabilities.readerConfigurationError,
    threadCreates:0,turnStarts:0,modelInferenceTested:false,globalConfigurationChanged:false};
  await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report)+'\n');
}catch(error){
  const report={timestamp:new Date().toISOString(),action:'codex-host-capability-handshake',outcome:'failed',host:'codex-app-server',
    errorCode:['host_process_failed','host_disconnected','host_rpc_failed','host_rpc_unknown'].includes(error.message)?error.message:'host_capability_unavailable',
    threadCreates:0,turnStarts:0,modelInferenceTested:false,globalConfigurationChanged:false};
  await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report)+'\n');process.exitCode=1;
}finally{await driver.close();}
