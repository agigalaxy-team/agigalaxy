// This is a process boundary, not cancellation or proof of transaction outcome.
// Keep the timer referenced so an unresolved cleanup promise cannot exit as a
// successful stop. Repeated signals never extend the original deadline.
export function createShutdownDeadline({ timeoutMs = 15000, exit = code => process.exit(code) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof exit !== 'function')
    throw new Error('Invalid shutdown configuration');
  let started = false, finished = false, timer;
  return Object.freeze({
    start() {
      if (started || finished) return;
      started = true;
      timer = setTimeout(() => exit(1), timeoutMs);
    },
    finish() { finished = true; clearTimeout(timer); },
  });
}
