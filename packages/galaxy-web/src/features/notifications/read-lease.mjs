/** Keep permission-derived notification content within its original read window.
 * @template {{sourceExpiresAt?:string,readExpiresAt?:number}} T
 * @param {T[]} items
 * @param {number} startedAt
 * @param {number} [now]
 * @returns {(T & {readUntil:number})[]}
 */
export function leaseNotificationItems(items, startedAt, now=Date.now()) {
 return items.map(item=>({...item,readUntil:Math.min(startedAt+60000,
  item.sourceExpiresAt===undefined?Infinity:Date.parse(item.sourceExpiresAt),
  item.readExpiresAt===undefined?Infinity:item.readExpiresAt*1000)}))
  .filter(item=>Number.isFinite(item.readUntil)&&item.readUntil>now);
}

/** @template {{readUntil:number}} T @param {T[]} items @param {number} [now] @returns {T[]} */
export function currentNotificationItems(items,now=Date.now()) {
 return items.filter(item=>Number.isFinite(item.readUntil)&&item.readUntil>now);
}
