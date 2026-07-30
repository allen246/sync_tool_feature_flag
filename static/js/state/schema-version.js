/* ============================================================
 *  schema-version.js — Legacy (v1) ↔ multi-tenant (v2) switch.
 *
 *  Every tab, field, button and flow is identical across versions.
 *  The only thing that changes is which generator the backend runs,
 *  and therefore which tables the emitted SQL targets:
 *
 *    v1 → scripts/*.py        (legacy schema)
 *    v2 → scripts/v2/*.py     (multi-tenant schema)
 *
 *  The active version travels as a cookie, so none of the existing
 *  fetch call sites in /tabs needed touching. Flask reads it back on
 *  every request and renders it into <body data-schema-version>, which
 *  is the single source of truth this module reads on load.
 *
 *  Switching reloads the page: the server has to re-render with the new
 *  version so the header pill, banner and generated SQL can never
 *  disagree with the cookie.
 *
 *  Public API:
 *    startSchemaVersion()   — idempotent; wires the banner + header pill
 *    activeSchemaVersion()  — 'v1' | 'v2'
 * ============================================================ */

import { showToast } from '../lib/toast.js';

const COOKIE = 'schema_version';
const DISMISS_KEY = 'syncmgmt.schemaVersionNoticeDismissed';
const ONE_YEAR = 31536000;

export function activeSchemaVersion() {
  return document.body.dataset.schemaVersion === 'v2' ? 'v2' : 'v1';
}

function setCookie(version) {
  document.cookie = `${COOKIE}=${version}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

/** True when the user has typed or pasted anything a reload would discard. */
function hasUnsavedWork() {
  return Array.from(document.querySelectorAll('#content textarea, #content input'))
    .some(el => el.value && el.value.trim());
}

function switchTo(version) {
  if (version === activeSchemaVersion()) return;
  if (hasUnsavedWork() && !confirm(
    'Switching schema version reloads the page and clears the pasted '
    + 'queries and snapshots on screen.\n\nContinue?')) return;

  setCookie(version);
  showToast('Switching Schema',
    `Note: reloading on ${version === 'v2' ? 'multi-tenant (v2)' : 'legacy (v1)'} schema…`,
    'info');
  // Give the toast a frame to paint before the navigation tears it down.
  setTimeout(() => window.location.reload(), 400);
}

function dismissNotice() {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
  const notice = document.getElementById('schemaVersionNotice');
  if (notice) notice.classList.add('hidden');
}

function noticeDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; }
}

export function startSchemaVersion() {
  const version = activeSchemaVersion();
  const notice = document.getElementById('schemaVersionNotice');
  const pill   = document.getElementById('schemaVersionPill');

  if (pill) {
    pill.dataset.version = version;
    pill.textContent = version === 'v2' ? 'SCHEMA v2' : 'SCHEMA v1';
    pill.title = version === 'v2'
      ? 'Multi-tenant schema active — click to return to the legacy schema'
      : 'Legacy schema active — click to switch to the multi-tenant schema';
    pill.addEventListener('click', () => switchTo(version === 'v2' ? 'v1' : 'v2'));
  }

  if (!notice) return;

  // On v2 the bar is a persistent state indicator and is never dismissible —
  // it is the only always-visible signal that generated SQL targets the new
  // tables. On v1 it is a one-time upgrade notice.
  notice.dataset.version = version;
  if (version === 'v1' && noticeDismissed()) {
    notice.classList.add('hidden');
  } else {
    notice.classList.remove('hidden');
  }

  const action = document.getElementById('schemaVersionAction');
  if (action) action.addEventListener('click', () => switchTo(version === 'v2' ? 'v1' : 'v2'));

  const dismiss = document.getElementById('schemaVersionDismiss');
  if (dismiss) dismiss.addEventListener('click', dismissNotice);
}
