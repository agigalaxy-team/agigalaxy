'use client';
import {useCallback} from 'react';
import {useOperationCommand} from '../components/OperationControls';
import {operationsRequest} from './operations-client';
import {autonomyBase,autonomyErrors} from './autonomy-view-model';
import type {AutonomyOperation} from '../components/autonomy-types';

export function useAutonomyCommand<T extends {operationId:string}>({csrfToken,canWrite,onCommitted,onConflict}:{csrfToken:string;canWrite:boolean;onCommitted:(value:T)=>void|Promise<void>;onConflict?:()=>void}){
 const recover=useCallback(async(intent:{body:Record<string,unknown>},{signal}:{signal:AbortSignal})=>{
  const value=await operationsRequest<AutonomyOperation>(autonomyBase+'/operations/'+encodeURIComponent(String(intent.body.operationId)),{signal});
  if(value.operationId!==intent.body.operationId||value.readExpiresAt*1000<=Date.now())throw Error('Original autonomy result unavailable');
  if(value.state==='recorded'&&value.result.operationId===intent.body.operationId)return {state:'recorded' as const,value:value.result as unknown as T};
  // A not-recorded lookup does not establish that an in-flight request had no effect.
  throw Error('Original autonomy result pending');
 },[]);
 return useOperationCommand<T>({csrfToken,canWrite,canRecover:true,onCommitted,onConflict,recover,errorMessages:autonomyErrors,recoveryPendingMessage:'连接暂时中断，正在查询原处理结果。',validateResult:(value,intent)=>{if(value.operationId!==intent.body.operationId)throw Error('Unbound autonomy result');}});
}
