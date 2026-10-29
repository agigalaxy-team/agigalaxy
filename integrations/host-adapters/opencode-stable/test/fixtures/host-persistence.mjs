import {createHostLocalClient} from '../../bridge/host-local-client.mjs';

// Each UI operation uses the current Go host protocol and closes its child.
export function hostPersistenceFixture(directory) {
  const run=(namespace,name)=>(...args)=>{
    const client=createHostLocalClient({dataDirectory:directory,localOnly:true});
    return Promise.resolve().then(()=>namespace?client[namespace][name](...args):client[name](...args)).finally(()=>client.close());
  };
  return {
    store: {
      getLocalSnapshot: run('store','getLocalSnapshot'),
      getGalaxyIntegrationStatus: run('store','getGalaxyIntegrationStatus'),
      resetGalaxyIntegration: run('store','resetGalaxyIntegration'),
    },
    connection: {getGalaxyConnectionStatus: run('connection','getGalaxyConnectionStatus')},
    history: {identity: run('history','identity')},
    initialize: run(null,'initialize'),
    preparationStatus: run(null,'preparationStatus'),
    deferPreparation: run(null,'deferPreparation'),
    close: async () => {},
  };
}
