// Diagnostics for problems that only show up with real services.
//
// Open the app with ?debug once (it is remembered) to log playback events to
// the browser console, prefixed [phosphor:...]. ?debug=0 turns it off again.

const enabled = (() => {
  try {
    const flag = new URLSearchParams(location.search).get('debug');
    if (flag === '0') localStorage.removeItem('phosphor.debug');
    else if (flag !== null) localStorage.setItem('phosphor.debug', '1');
    return localStorage.getItem('phosphor.debug') === '1';
  } catch {
    return false;
  }
})();

export function debug(scope: string, ...details: unknown[]) {
  if (enabled) console.info(`[phosphor:${scope}]`, ...details);
}
