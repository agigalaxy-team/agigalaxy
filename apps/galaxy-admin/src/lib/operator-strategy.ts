import type {AuthStrategy,Payload} from 'payload';
import {readOperatorSession} from './operations.mjs';
import {operatorBusinessAuthorization,operatorSync,type OperatorUser,type OperatorBusinessAuthorization} from './access';

// The mapping is a CMS identity projection. Authority comes from the live BFF
// session on every request, never from a stored role or a Payload password.
async function projection(payload:Payload,operator:{id:string;displayName:string;role:'administrator'|'reader';businessAuthorization?:OperatorBusinessAuthorization}){
  const principal:OperatorUser={id:operator.id,collection:'operators',externalId:operator.id,displayName:operator.displayName,role:operator.role,verifiedOperator:true,businessAuthorization:operatorBusinessAuthorization(operator)};
  const find=()=>payload.find({collection:'operators',where:{externalId:{equals:operator.id}},limit:1,depth:0,overrideAccess:false,user:principal});
  let document=(await find()).docs[0];
  if(!document){
    try{document=await payload.create({collection:'operators',data:{externalId:operator.id,displayName:operator.displayName,role:operator.role},overrideAccess:false,user:principal,context:{operatorProjection:operatorSync}});}
    catch(error){document=(await find()).docs[0];if(!document)throw error;}
  }else if(document.displayName!==operator.displayName||document.role!==operator.role){
    document=await payload.update({collection:'operators',id:document.id,data:{displayName:operator.displayName,role:operator.role},overrideAccess:false,user:principal,context:{operatorProjection:operatorSync}});
  }
  return {...document,...principal,id:String(document.id)};
}
const operatorStrategyName='galaxy-operations-session';
export const operatorStrategy:AuthStrategy={
  name:operatorStrategyName,
  authenticate:async({headers,payload})=>{
    const session=await readOperatorSession(headers);
    if(session.state!=='signed-in')return {user:null};
    // Payload's me endpoint reloads stored fields, then preserves _strategy.
    // Keep the real authentication provenance across that public projection.
    return {user:{...await projection(payload,session.operator),_strategy:operatorStrategyName}};
  },
};
