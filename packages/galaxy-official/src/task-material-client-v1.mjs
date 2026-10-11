import {createTaskClientV2} from './task-client-v2.mjs';
// Reuses the real Task transport/session checks, including every digest await.
export function createTaskMaterialClientV1(options){
 const tasks=createTaskClientV2(options);
 return Object.freeze({prepare:tasks.prepareTaskMaterials,status:tasks.taskMaterialStatus});
}
