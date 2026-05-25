/* ============================================================
 *  json-group.js — Auto-decorates every .json-group with action
 *  buttons (Upload, optionally Table View, etc.) without touching
 *  the tab template strings.
 *
 *  Upload is now a dropdown that lists registered formats:
 *    · JSON / TXT (built-in default for every group)
 *    · CSV   (registered by the workflow tab via registerUploadVariant)
 *
 *  Tabs add additional "action" buttons (e.g. Table View) via
 *  registerJsonGroupAction.
 *
 *  Extension points
 *  ────────────────
 *    registerUploadVariant(textareaId, variant)
 *      Adds a row to the Upload dropdown. Variant shape:
 *        { key, label, hint?, accept?, onPick(textarea) }
 *
 *    registerJsonGroupAction(textareaId, action)
 *      Mounts a separate button after the Upload dropdown.
 *      Action shape: { cls, icon, label, title?, onClick(textarea) }
 *
 *  decorateJsonGroups() is idempotent — safe to call after every
 *  tab render.
 * ============================================================ */

import { ICONS, qs, qsa } from '../lib/dom.js';
import { triggerFileUpload } from '../lib/data.js';

/* ── Registries ─────────────────────────────────────────────── */
/** @typedef {{ key:string, label:string, hint?:string, accept?:string, icon?:string, onPick:(t:HTMLTextAreaElement)=>void }} UploadVariant */
const UPLOAD_VARIANTS = new Map();   // textareaId → UploadVariant[]
const ACTIONS         = new Map();   // textareaId → action[]

/** Built-in JSON upload, present on every json-group. Strict accept —
 *  the OS file picker shows ONLY .json files. */
const DEFAULT_JSON_VARIANT = {
  key:    'json',
  label:  'JSON',
  accept: '.json,application/json',
  onPick: (textarea) => triggerFileUpload(textarea, { accept: '.json,application/json' }),
};

/** @param {string} textareaId @param {UploadVariant} variant */
export function registerUploadVariant(textareaId, variant) {
  if (!UPLOAD_VARIANTS.has(textareaId)) UPLOAD_VARIANTS.set(textareaId, []);
  UPLOAD_VARIANTS.get(textareaId).push(variant);
}

/** @typedef {{ cls:string, icon:string, label:string, title?:string, onClick:(t:HTMLTextAreaElement)=>void }} JsonGroupAction */
/** @param {string} textareaId @param {JsonGroupAction} action */
export function registerJsonGroupAction(textareaId, action) {
  if (!ACTIONS.has(textareaId)) ACTIONS.set(textareaId, []);
  ACTIONS.get(textareaId).push(action);
}

/* ── Decorator (idempotent) ─────────────────────────────────── */
export function decorateJsonGroups() {
  qsa('.json-group').forEach(group => {
    const textarea = group.querySelector('textarea');
    const labelRow = group.querySelector('.json-label-row');
    if (!textarea || !labelRow) return;
    const pill = labelRow.querySelector('.db-pill');

    if (!labelRow.querySelector('.json-upload-wrap')) {
      const variants = [DEFAULT_JSON_VARIANT, ...(UPLOAD_VARIANTS.get(textarea.id) || [])];
      const wrap = makeUploadDropdown(textarea, variants);
      if (pill) labelRow.insertBefore(wrap, pill);
      else      labelRow.appendChild(wrap);
    }

    const extras = ACTIONS.get(textarea.id) || [];
    extras.forEach(action => {
      if (labelRow.querySelector('.' + action.cls)) return;
      const btn = makeActionBtn({ ...action, onClick: () => action.onClick(textarea) });
      if (pill) labelRow.insertBefore(btn, pill);
      else      labelRow.appendChild(btn);
    });
  });
}

/* ── Upload dropdown / direct button ────────────────────────
 * Single variant  → plain button; click opens the OS file picker
 *                   immediately. No menu, no chevron, no empty grid
 *                   slot. (Branch/Feature Flag/MQ tabs only have JSON.)
 * Two+ variants   → button with a chevron; opens a popover tile menu.
 *                   (Workflow tab has JSON + CSV.)
 */
function makeUploadDropdown(textarea, variants) {
  const wrap = document.createElement('span');
  wrap.className = 'json-upload-wrap';

  // Fast path for single-variant case — no menu, instant trigger.
  if (variants.length <= 1) {
    const v = variants[0];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'json-upload-btn is-single';
    btn.setAttribute('title', v ? `Upload ${v.label} file` : 'Upload file');
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = ICONS.upload + '<span>Upload</span>';
    btn.addEventListener('click', e => {
      e.preventDefault();
      if (btn.disabled || !v) return;
      v.onPick(textarea);
    });
    wrap._closeMenu = () => {};
    wrap.appendChild(btn);
    return wrap;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'json-upload-btn';
  btn.setAttribute('title', 'Upload from file');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = ICONS.upload + '<span>Upload</span><span class="json-upload-caret" aria-hidden="true">▾</span>';

  const menu = document.createElement('div');
  menu.className = 'json-upload-menu hidden';
  menu.dataset.count = String(variants.length);
  menu.setAttribute('role', 'menu');

  // Quick fast-path: if there's only one variant, the dropdown still
  // works but the menu shows just one row. (We could skip the menu
  // entirely for single-variant cases, but consistent UX is worth
  // the one extra tap for JSON-only groups.)
  // Two-tile grid — single big format label per tile, no descriptive text.
  // Layout: tiles wrap horizontally; with two options they sit side-by-side.
  menu.innerHTML = variants.map((v, idx) => `
    <button type="button" class="json-upload-menu-item" data-vkey="${v.key}" role="menuitem"
            ${idx === 0 ? 'data-first="true"' : ''}>
      <span class="up-mi-glyph" aria-hidden="true">${v.icon || ICONS.upload}</span>
      <span class="up-mi-label">${v.label}</span>
    </button>
  `).join('');

  menu.querySelectorAll('.json-upload-menu-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const key = item.dataset.vkey;
      closeMenu();
      const v = variants.find(x => x.key === key);
      if (v) v.onPick(textarea);
    });
  });

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    const open = !menu.classList.contains('hidden');
    closeAllMenus();
    if (!open) openMenu();
  });

  // Keyboard navigation
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      closeAllMenus();
      openMenu();
      focusFirstItem();
    } else if (e.key === 'Escape') {
      closeMenu();
    }
  });
  menu.addEventListener('keydown', e => {
    const items = Array.from(menu.querySelectorAll('.json-upload-menu-item'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape')  { e.preventDefault(); closeMenu(); btn.focus(); }
    else if (e.key === 'Tab')     { closeMenu(); }
  });

  function openMenu() {
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }
  function focusFirstItem() {
    setTimeout(() => menu.querySelector('.json-upload-menu-item')?.focus(), 30);
  }
  // Track close behaviour from outside
  wrap._closeMenu = closeMenu;

  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

/** Close any open upload menus. */
function closeAllMenus() {
  qsa('.json-upload-wrap').forEach(w => w._closeMenu && w._closeMenu());
}

// Click outside any open menu → close all menus.
document.addEventListener('click', e => {
  if (!e.target.closest || !e.target.closest('.json-upload-wrap')) closeAllMenus();
});
// Esc closes any open menu (separate from in-menu keyboard nav).
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllMenus();
});

/* ── Plain action button (Table View, etc.) ─────────────────── */
function makeActionBtn({ cls, icon, label, title, onClick }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  if (title) { b.setAttribute('title', title); b.setAttribute('aria-label', title); }
  b.innerHTML = icon + '<span>' + label + '</span>';
  b.addEventListener('click', e => { e.preventDefault(); onClick(); });
  return b;
}
