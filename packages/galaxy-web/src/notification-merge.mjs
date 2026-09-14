/** Merge notification pages without reordering existing items or duplicating IDs. */
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
