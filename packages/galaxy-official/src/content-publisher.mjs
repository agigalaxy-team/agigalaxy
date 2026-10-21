import {openDatabase} from './database.mjs';
import {createOperationsJobs} from './operations-jobs.mjs';
import {createContentPublicationWorker} from './content-publications.mjs';
import {createFilesystemContentPublisher,loadContentPublisherConfiguration} from './content-publisher-files.mjs';
import {assertSupportedSchema} from './infrastructure/migrations.mjs';
import {createRuntimeLogger,consoleRuntimeLogger,runtimeLogConfiguration,installRuntimeFailureHandlers} from './operations/runtime-log.mjs';
import {createShutdownDeadline} from './shutdown-deadline.mjs';
import {readFile} from 'node:fs/promises';

let db,jobs,worker,stopPromise;
let runtimeLog=consoleRuntimeLogger('content-publisher',{destination:process.stderr,environment:process.env.GALAXY_ENVIRONMENT});
let stage='environment';
const runtimeStartedAt=performance.now(),shutdown=createShutdownDeadline();
async function closeStep(current,operation){const startedAt=performance.now();try{await operation();}catch(error){process.exitCode=1;runtimeLog.error({event:'runtime_shutdown_failed',stage:current,startedAt,error});}}
const stop=signal=>{
  if(stopPromise)return stopPromise;
  const startedAt=performance.now();runtimeLog.write({event:'runtime_stopping',stage:'shutdown',signal});shutdown.start();
  stopPromise=(async()=>{
    await closeStep('publisher-stop',()=>worker?.stop());
    await closeStep('queue-stop',()=>jobs?.stop());
    await closeStep('database-close',()=>db?.end());
    runtimeLog.write({event:'runtime_stopped',stage:'shutdown',startedAt,exitCode:process.exitCode??0});
    try{await runtimeLog.close();}catch{process.exitCode=1;}
  })().finally(()=>shutdown.finish());
  return stopPromise;
};
try{
  if(typeof process.getuid==='function'&&process.getuid()===0)throw Error('Non-root publisher required');
  stage='runtime-log';
  const configuredLog=await createRuntimeLogger({component:'content-publisher',...runtimeLogConfiguration(process.env)});
  await runtimeLog.close();runtimeLog=configuredLog;
  // Same captured API source, separate entry point. Read release metadata only.
  stage='release';
  const release=await readFile(new URL('../../../service-release.json',import.meta.url),'utf8').then(text=>JSON.parse(text).releaseId,()=>null);
  runtimeLog.updateContext({release,environment:process.env.GALAXY_ENVIRONMENT});
  stage='publisher-config';
  const config=await loadContentPublisherConfiguration(process.env.GALAXY_CONTENT_PUBLISHER_CONFIG_FILE);
  stage='database';db=openDatabase(process.env.DATABASE_URL,{logger:runtimeLog.write});
  assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
  stage='queue-start';
  jobs=createOperationsJobs({db,supervise:false,onError:diagnostic=>runtimeLog.error({event:'content_publication_queue_failed',...diagnostic}),onEvent:runtimeLog.write});
  stage='publisher-files';
  const filesystem=await createFilesystemContentPublisher(config),publisher={};
  for(const [name,current]of [['current','publisher-current'],['prepare','publisher-prepare'],['activate','publisher-activate']]){
    publisher[name]=async(...args)=>{
      const startedAt=performance.now();
      try{const result=await filesystem[name](...args);runtimeLog.write({event:'content_publication_step',stage:current,startedAt,outcome:'succeeded'});return result;}
      catch(error){runtimeLog.error({event:'content_publication_step_failed',stage:current,startedAt,error});throw error;}
    };
  }
  worker=createContentPublicationWorker({db,endpoint:config.endpoint,publicOrigin:config.publicOrigin,jobs,publisher});
  stage='publisher-start';await worker.start();
  runtimeLog.write({event:'content_publication_worker_started',stage,startedAt:runtimeStartedAt});
  installRuntimeFailureHandlers({logger:runtimeLog.error,onFatal:()=>stop()});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void stop(signal);});
}catch(error){
  runtimeLog.error({event:'content_publication_startup_failed',stage,startedAt:runtimeStartedAt,error});process.exitCode=1;
  await stop();
}
