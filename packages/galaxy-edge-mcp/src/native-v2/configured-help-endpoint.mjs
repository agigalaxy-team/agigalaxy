// Native uses the authority already selected in its public configuration.
// Network requests still pass through the pinned, current-control browser API;
// this validator only permits the exact origin used by the local Help journal.
export function createConfiguredHelpEndpointValidator(endpoint) {
 const selected = new URL(endpoint);
 if (selected.protocol !== 'https:' || selected.origin !== endpoint || selected.username || selected.password)
  throw new Error('native_help_endpoint_invalid');
 return value => {
  if (value !== endpoint) throw new Error('native_help_endpoint_changed');
  return new URL(endpoint);
 };
}
