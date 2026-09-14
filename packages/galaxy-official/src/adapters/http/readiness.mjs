// One outstanding backend probe, including after its response deadline. A stuck
// dependency cannot multiply queries with every incoming health request.
export function boundedReadiness(probe, timeoutMs = 2000) {
  if (typeof probe !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new Error('Invalid readiness configuration');
  let active = null;
  return () => {
    if (active) return active;
    let finish;
    const result = new Promise(resolve => { finish = resolve; });
    active = result;
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve().then(probe).then(value => finish(value === true), () => finish(false)).finally(() => {
      clearTimeout(timer);
      if (active === result) active = null;
    });
    return result;
  };
}
