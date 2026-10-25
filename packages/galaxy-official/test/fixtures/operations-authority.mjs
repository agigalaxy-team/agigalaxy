import {randomUUID} from 'node:crypto';
import {OperationsPermissionsService} from '../../src/operations-permissions.mjs';

// The native directory is an explicit local fixture. Business action grants
// are saved and checked by the real PG service, never copied from actor JSON.
export async function attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:codes}){
 const roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 const operatorAuthorization=async actor=>roles.get(actor.operatorId)??null;
 const permissions=new OperationsPermissionsService({db:businessAdmin.db,endpoint:businessAdmin.endpoint,
  now:businessAdmin.now,operatorAuthorization});
 businessAdmin.permissions=permissions;
 businessAdmin.operatorAuthorization=operatorAuthorization;
 const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,
  name:'受影响模块只读夹具 '+randomUUID(),description:'Explicit local fixture authority',enabled:true,permissions:codes},
  {authorize:async()=>admin})).role;
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,
  operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin});
 return {permissions,roles};
}
