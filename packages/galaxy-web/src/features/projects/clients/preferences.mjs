import {discoveryPreferencesSchema} from "../../../../../galaxy-contracts/src/discovery-schema.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const ordered = value => value === null ? null : {
  enabled: value.enabled,
  purposes: [...value.purposes].sort(compare),
  functions: [...value.functions].sort(compare),
  temporary: value.temporary ? {
    until: value.temporary.until,
    contact: value.temporary.contact,
    ...(value.temporary.purposes ? {purposes: [...value.temporary.purposes].sort(compare)} : {}),
    ...(value.temporary.functions ? {functions: [...value.temporary.functions].sort(compare)} : {}),
  } : null,
};
export const sameProjectContactPreferences = (left, right) => same(ordered(left), ordered(right));

function conflict(current) {
  return Object.assign(new Error('这份作品的联系范围已在别处更新。你的选择仍保留，请核对当前设置。'), {currentPreferences: current});
}

/** Re-read after an uncertain response; never repeat a write against a new revision. */
export async function saveProjectContactPreferences({readCurrent, write, expectedRevision, preferences}) {
  const desired = preferences === null ? null : discoveryPreferencesSchema.parse(preferences);
  const before = await readCurrent();
  if (sameProjectContactPreferences(before.preferences, desired)) return before;
  if (before.revision !== expectedRevision) throw conflict(before);
  try {
    return await write({expectedRevision, preferences: desired});
  } catch (error) {
    let after;
    try { after = await readCurrent(); } catch { throw error; }
    if (after.revision > expectedRevision && sameProjectContactPreferences(after.preferences, desired)) return after;
    if (after.revision !== expectedRevision) throw conflict(after);
    throw error;
  }
}
