import {stableJson} from "../../../../galaxy-official/src/shared/web-primitives.mjs";

// Contribution observedAt describes this read, not a change to the authored
// record. Keep its immutable locator, all selected values and provenance exact.
// A CI proof's observation time is part of the signed claim and stays exact.
export function samePeeringMaterial(source, before, current) {
  if (!source || !before || !current) return false;
  if (source.kind === 'ci-proof-v2') return stableJson(before) === stableJson(current);
  if (source.kind !== 'contribution-summary'
    || before.authority !== 'author-selected-contribution-summary'
    || current.authority !== before.authority) return false;
  const {observedAt: _beforeRead, ...original} = before;
  const {observedAt: _currentRead, ...fresh} = current;
  return stableJson(original) === stableJson(fresh);
}
