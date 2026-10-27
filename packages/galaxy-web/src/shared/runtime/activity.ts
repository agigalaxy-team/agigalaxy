let lastActivity = 0;
let listeners = 0;
const heard = (event: Event) => { if (event.isTrusted && document.visibilityState === 'visible') lastActivity = Date.now(); };
/** Only actual input marks activity. Timers, SSE, focus and visibility do not. */
export function observeUserActivity() {
 if (++listeners === 1) for (const name of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) window.addEventListener(name, heard, {passive:true});
 return () => { if (--listeners === 0) for (const name of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) window.removeEventListener(name, heard); };
}
export const userActivityVersion = () => lastActivity;
