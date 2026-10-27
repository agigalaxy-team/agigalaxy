const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
/** Keep unavailability distinct from a proven signed-out session. No principal is cached. */
export async function operatorMeResponse(requestHeaders,{readSession,project}){
 try{
  const session=await readSession(requestHeaders);
  if(session.state==='signed-out')return Response.json({user:null},{headers});
  if(session.state!=='signed-in')throw Error('operator_session_unknown');
  const principal=await project(session.operator);
  if(!principal||principal.externalId!==session.operator.id||typeof principal.id!=='string')throw Error('operator_projection_unknown');
  const user={id:principal.id,externalId:principal.externalId,collection:'operators',displayName:principal.displayName,role:principal.role,_strategy:'galaxy-operations-session'};
  return Response.json({user},{headers});
 }catch{return Response.json({error:'operator_session_unavailable',state:'unknown'},{status:503,headers});}
}
