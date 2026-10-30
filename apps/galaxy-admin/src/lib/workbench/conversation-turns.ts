import type {AgentOsCommand,AgentOsConversation,AgentOsNativeRun} from './agentos-client';

// An ACK/original-operation receipt updates its own turn. Completed siblings
// keep their references, content and presentation state.
export function applyConversationReceipt<T extends AgentOsConversation>(conversation:T,receipt:AgentOsCommand,message?:string,retryOfOperationId?:string):T{
 const operationId=receipt.operationId;
 if(!operationId||receipt.state==='context-changed'||receipt.state==='not-started')return conversation;
 const previous=conversation.runs.find(run=>run.operationId===operationId);
 const runId=receipt.runId??receipt.native?.runId??previous?.runId;
 if(!runId)return conversation;
 if(previous&&previous.runId!==runId)throw Error('Invalid conversation receipt binding');
 if(receipt.native&&(receipt.native.operationId!==operationId||receipt.native.runId!==runId))throw Error('Invalid conversation receipt binding');
 const native=receipt.native;
 const turn:AgentOsNativeRun={runId,operationId,status:native?.status??previous?.status??'PENDING',content:native?.content??previous?.content??null,userInput:native?.userInput??previous?.userInput??message??null,createdAt:native?.createdAt??previous?.createdAt??null,events:native?.events??previous?.events??[],awaitingHuman:native?.awaitingHuman??previous?.awaitingHuman??false,...previous,...native};
 turn.userInput=native?.userInput??previous?.userInput??message??null;
 turn.taskProgress=receipt.taskProgress??native?.taskProgress??previous?.taskProgress;
 if(receipt.native)turn.displayOnly=false;
 for(const key of ['sentAt','completedAt'] as const){
  const value=native&&Object.prototype.hasOwnProperty.call(native,key)?native[key]:key==='sentAt'&&Object.prototype.hasOwnProperty.call(receipt,'sentAt')?receipt.sentAt:previous?.[key];
  turn[key]=value===null?null:typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
 }
 if(retryOfOperationId&&!turn.regeneratedFrom){const parent=conversation.runs.find(run=>run.operationId===retryOfOperationId);if(parent)turn.regeneratedFrom=parent.runId;}
 return {...conversation,runs:previous?conversation.runs.map(run=>run===previous?turn:run):[...conversation.runs,turn]};
}
