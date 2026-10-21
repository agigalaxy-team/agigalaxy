import type {AuthStrategy,Payload} from 'payload';
import {readOperatorSession} from './operations.mjs';
import {operatorSync,type OperatorUser} from './access';

// The mapping is a CMS identity projection. Authority comes from the live BFF
// session on every request, never from a stored role or a Payload password.
async function projection(payload:Payload,operator:{id:string;displayName:string;role:'administrator'|'reader'}){
  const principal:OperatorUser={id:operator.id,collection:'operators',externalId:operator.id,displayName:operator.displayName,role:operator.role,verifiedOperator:true};
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
export const operatorStrategy:AuthStrategy={
  name:'galaxy-operations-session',
  authenticate:async({headers,payload})=>{
    const session=await readOperatorSession(headers);
    if(session.state!=='signed-in')return {user:null};
    return {user:await projection(payload,session.operator)};
  },
};
