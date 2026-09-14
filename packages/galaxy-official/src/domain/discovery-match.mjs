export const normalizeFunction = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const tags = values => [...new Set(values.map(normalizeFunction))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

export function effectiveDiscovery(preferences, now) {
  const temporary = preferences.temporary && preferences.temporary.until > now ? preferences.temporary : null;
  return {
    enabled: preferences.enabled && temporary?.contact !== 'paused',
    purposes: temporary?.purposes ?? preferences.purposes,
    functions: tags(temporary?.functions ?? preferences.functions),
    temporaryUntil: temporary?.until ?? null,
  };
}

export function matchProjects(source, candidate, sourceWish, candidateWish) {
  if (!sourceWish.enabled || !candidateWish.enabled) return null;
  const purposes = sourceWish.purposes.filter(value => candidateWish.purposes.includes(value));
  const left = tags(source.functions), right = tags(candidate.functions);
  const sharedFunctions = left.filter(value => right.includes(value));
  if (!purposes.length || !sharedFunctions.length) return null;
  if ([sourceWish, candidateWish].some(wish => wish.functions.length && !sharedFunctions.some(value => wish.functions.includes(value)))) return null;
  const leftTech = tags(source.technologies), rightTech = tags(candidate.technologies);
  return {
    method: 'functional-tags-v1',
    score: sharedFunctions.length / new Set([...left, ...right]).size,
    sharedFunctions, purposes,
    differences: {
      sourceOnlyFunctions: left.filter(value => !right.includes(value)),
      candidateOnlyFunctions: right.filter(value => !left.includes(value)),
      sourceOnlyTechnologies: leftTech.filter(value => !rightTech.includes(value)),
      candidateOnlyTechnologies: rightTech.filter(value => !leftTech.includes(value)),
    },
  };
}
