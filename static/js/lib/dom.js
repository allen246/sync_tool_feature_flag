/* ============================================================
 *  dom.js — Tiny DOM utilities + shared SVG icons.
 *  No dependencies. Pure functions.
 * ============================================================ */

export const qs  = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/** Set or remove an attribute based on a truthy flag. */
export function setAttr(el, name, on, value = '') {
  if (!el) return;
  if (on) el.setAttribute(name, value);
  else el.removeAttribute(name);
}

/** Toggle a class without forcing a state. */
export function toggleClass(el, name, on) {
  if (!el) return;
  el.classList.toggle(name, !!on);
}

/** Expose a map of functions on `window` so inline onclick handlers
 *  (which still live inside template strings) can resolve them.
 *  Modules should call this for any function used as an inline action. */
export function exposeGlobals(map) {
  Object.assign(window, map);
}

/* ── Shared inline-SVG icons. Centralised so a single tweak to the
 *  stroke weight or icon style propagates everywhere. */
export const ICONS = {
  check:    `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
  cross:    `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  warn:     `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
  info:     `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  copy:     `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" stroke-width="1.5"/><rect x="2" y="2" width="13" height="13" rx="2" stroke-width="1.5"/></svg>`,
  download: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-width="1.5" d="M12 3v12m0 0l-4-4m4 4l4-4"/><path stroke-width="1.5" d="M5 21h14"/></svg>`,
  upload:   `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5M5 21h14"/></svg>`,
  table:    `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M3 12h18M3 18h18M9 3v18M15 3v18"/></svg>`,
  generate: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>`,
  finish:   `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>`,
  remap:    `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7h11M4 12h8m-8 5h16m-4-4l4 4-4 4"/></svg>`,
  back:     `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M19 12H5m0 0l6-6m-6 6l6 6"/></svg>`,
};

/* ── Tiny format helpers ─────────────────────────────────────── */
export function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

export function pad2(n) { return String(n).padStart(2, '0'); }
