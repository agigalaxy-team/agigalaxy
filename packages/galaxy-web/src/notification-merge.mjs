/** Merge notification pages without reordering existing items or duplicating IDs.
 * @template {{id:string}} T
 * @param {T[]} [existing]
 * @param {T[]} [incoming]
 * @returns {T[]}
 */
export function mergeNotificationItems(existing = [], incoming = []) {
  const positions = new Map(existing.map((item, index) => item?.id ? [item.id, index] : []).filter(Boolean));
  const result = [...existing];
  for (const item of incoming) {
    if (!item?.id) continue;
    const index = positions.get(item.id);
    if (index !== undefined) result[index] = { ...result[index], ...item };
    else { positions.set(item.id, result.length); result.push(item); }
  }
  return result;
}

/** Related message notices share a reading destination; original receipt IDs remain intact.
 * @template {{id:string,eventKind:string,object:{type:string,id:string},at:string,read:boolean}} T
 * @param {T[]} [items]
 * @returns {(T & {rowKey:string,notices:T[]})[]}
 */
export function notificationRows(items = []) {
  const grouped = new Map();
  for (const item of items) {
    const key = item.eventKind === 'room-message' && item.object?.type === 'room' ? 'room:'+item.object.id : item.id;
    const previous=grouped.get(key);
    if(!previous)grouped.set(key,{...item,rowKey:key,notices:[item]});
    else {
      const latest=Date.parse(item.at)>Date.parse(previous.at)?item:previous;
      grouped.set(key,{...latest,rowKey:key,read:previous.read&&item.read,notices:[...previous.notices,item]});
    }
  }
  return [...grouped.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
}

export async function markNotificationRowRead(client,item) {
  const notices=new Map((item.notices??[item]).map(notice=>[notice.id,notice]));
  if(item.eventKind==='room-message'&&item.object?.type==='room') {
    // The displayed conversation includes its older notices even when the
    // inbox was paginated. Unknown same-second notices may have arrived after
    // the click, so only known visible notices or strictly older ones are read.
    const until=Date.parse(item.at),seen=new Set();let after;
    do {
      const page=await client.query({unreadOnly:true,limit:20,...(after?{after}:{})});
      for(const notice of page.items)if(notice.eventKind==='room-message'&&notice.object?.type==='room'&&notice.object.id===item.object.id&&Date.parse(notice.at)<until)notices.set(notice.id,notice);
      after=page.nextAfter;if(after&&seen.has(after))break;if(after)seen.add(after);
    }while(after);
  }
  for(const notice of notices.values())if(!notice.read)await client.markRead({id:notice.id,reader:'human'});
}
