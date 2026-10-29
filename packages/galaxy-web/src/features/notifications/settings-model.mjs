import {inboxOptionsSchema} from '../../../../galaxy-contracts/src/notification-inbox-schema.mjs';

const sorted = settings => {
  const value=inboxOptionsSchema.parse(settings);
  return {...value,mutedRoomIds:[...new Set(value.mutedRoomIds)].sort(),blockedSubjectIds:[...new Set(value.blockedSubjectIds)].sort(),
    roomBlocks:[...new Map(value.roomBlocks.map(item=>[JSON.stringify([item.roomId,item.subjectId]),item])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
};
export const sameNotificationOptions=(left,right)=>JSON.stringify(sorted(left))===JSON.stringify(sorted(right));
export function applyNotificationChanges(settings,changes={}) {
  const value=sorted(settings),changeList=(ids,patch={})=>[...new Set([...ids.filter(id=>patch[id]!==false),...Object.keys(patch).filter(id=>patch[id]===true)])];
  return sorted({...value,...(typeof changes.rooms==='boolean'?{rooms:changes.rooms}:{}),...(typeof changes.tasks==='boolean'?{tasks:changes.tasks}:{}),
    mutedRoomIds:changeList(value.mutedRoomIds,changes.mutedRooms),blockedSubjectIds:changeList(value.blockedSubjectIds,changes.blockedPeople),
    roomBlocks:value.roomBlocks.filter(item=>changes.roomBlocks?.[JSON.stringify([item.roomId,item.subjectId])]!==false)});
}
export const hasNotificationChanges=changes=>typeof changes?.rooms==='boolean'||typeof changes?.tasks==='boolean'||Object.values(changes??{}).some(value=>value&&typeof value==='object'&&Object.keys(value).length>0);
export const notificationSettingsSatisfied=(current,attempt)=>!!current&&!!attempt&&current.revision>=attempt.expectedRevision&&sameNotificationOptions(current.settings,attempt.changes?applyNotificationChanges(current.settings,attempt.changes):attempt.settings);

// A preferences revision is the existing service CAS. A lost response is
// resolved by reading current preferences; it is never called an exact event
// receipt. No new authority, endpoint, journal or duplicate settings is added.
export async function saveNotificationSelection(client,attempt,{check=()=>{},allowWrite=true}={}) {
  check();const current=await client.options();check();
  if(notificationSettingsSatisfied(current,attempt))return {...current,matchedCurrent:true};
  if(!allowWrite)return null;
  if(current.revision!==attempt.expectedRevision)throw Object.assign(Error('通知设置已在别处改变。你的选择仍保留，请查看当前设置后保存。'),{code:'inbox_options_conflict',current});
  try {const saved=await client.saveOptions({expectedRevision:attempt.expectedRevision,settings:attempt.settings});check();return saved;}
  catch(error){check();
    // A transport may lose a successful response or retry the same CAS and
    // receive a conflict. Current desired state resolves either case.
    try{const latest=await client.options();check();if(notificationSettingsSatisfied(latest,attempt))return {...latest,matchedCurrent:true};if(latest.revision!==attempt.expectedRevision)throw Object.assign(Error('通知设置已在别处改变。你的选择仍保留，请查看当前设置后保存。'),{code:'inbox_options_conflict',current:latest});}
    catch(readError){if(readError?.code==='inbox_options_conflict')throw readError;check();}
    throw error;
  }
}
