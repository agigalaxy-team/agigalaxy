export function createOperationsMessagingWorkers({messaging}){return {run:(data,context)=>messaging.execute(data,context),delivery:(data,context)=>messaging.deliver(data,context)};}
