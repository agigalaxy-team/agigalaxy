// Configured code adapters only. This is not a remote plugin loading interface.
export function evidenceSource(adapter) {
  if (!adapter || !/^[a-z][a-z0-9-]{0,63}$/.test(adapter.jobKind)
    || typeof adapter.verifier !== 'string' || adapter.verifier.length > 120
    || !adapter.referenceSchema?.parse
    || !['sourceKey', 'verify', 'validateObservation'].every(key => typeof adapter[key] === 'function'))
    throw new Error('Invalid evidence source adapter');
  return Object.freeze({ ...adapter });
}

export function checkedObservation(adapter, observation, reference, now) {
  const checked = adapter.validateObservation(observation, reference, now);
  // Adapters report observations, never authorization/revocation or generalized
  // capability certification. Those decisions belong to application policies.
  if (!checked || checked.status !== 'observed' || checked.capabilitiesVerified !== false
    || checked.verifier !== adapter.verifier || checked.collectedAt !== now
    || !Number.isSafeInteger(checked.validUntil) || checked.validUntil <= now || checked.validUntil > now + 86400)
    throw new Error('Invalid evidence observation');
  return checked;
}
