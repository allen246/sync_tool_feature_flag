/* ============================================================
 *  feedback.js — Loading state.
 *
 *  Drives a single full-page blocking overlay (#globalLoader)
 *  whenever any button is in flight. Optionally accepts a short
 *  status message ("generating pull SQL", "diffing brokers", etc).
 *
 *  Public API:
 *    setLoading(btn, on, msg?)  — flag a button and toggle the overlay
 *    activeButton()             — the button that fired the current event
 *    runWithLoading(btn, fn, msg?) — async wrapper that guarantees pairing
 *
 *  Multiple buttons can be "loading" at once; the overlay only
 *  clears when the last one finishes. The status message is
 *  whichever caller passed one most recently.
 * ============================================================ */

const DEFAULT_MSG = 'running query · please wait';

export function setLoading(btn, on, msg) {
  if (!btn) return;
  const loader = document.getElementById('globalLoader');
  const sub    = document.getElementById('globalLoaderSub');
  if (on) {
    btn.dataset.loading = 'true';
    btn.setAttribute('aria-busy', 'true');
    if (loader) loader.dataset.loading = 'true';
    if (sub && msg) sub.textContent = msg;
  } else {
    delete btn.dataset.loading;
    btn.removeAttribute('aria-busy');
    if (loader) {
      // Only release the overlay when no other button is still pending
      const stillLoading = document.querySelectorAll('button[data-loading="true"]').length;
      if (!stillLoading) {
        delete loader.dataset.loading;
        if (sub) sub.textContent = DEFAULT_MSG;  // reset for next run
      }
    }
  }
}

/** The button that triggered the current inline-onclick handler. */
export function activeButton() {
  return (typeof event !== 'undefined' && event && event.target)
    ? event.target.closest('button')
    : null;
}

/** Wrap an async/promise op so loading state pairs are guaranteed. */
export async function runWithLoading(btn, fn, msg) {
  setLoading(btn, true, msg);
  try { return await fn(); }
  finally { setLoading(btn, false); }
}
