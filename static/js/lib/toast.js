/* ============================================================
 *  toast.js — Single-instance toast notifications.
 *
 *  Usage:  showToast('Title', 'Optional body', 'success'|'error'|'warning'|'info')
 *  Closes itself after 4.8s.
 * ============================================================ */

import { qs, ICONS } from './dom.js';

const TYPE_TO_ICON = { success: ICONS.check, error: ICONS.cross, warning: ICONS.warn, info: ICONS.info };

let timer = null;

export function showToast(title, msg, type = 'info') {
  const t = qs('#toast');
  if (!t) return;
  const msgHtml = msg ? `<div class="toast-msg">${msg}</div>` : '';
  const icon = TYPE_TO_ICON[type] || TYPE_TO_ICON.info;
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.innerHTML = `<div class="toast-inner"><div class="toast-icon">${icon}</div><div class="toast-text"><div class="toast-title">${title}</div>${msgHtml}</div></div>`;
  t.className = 'toast ' + type;
  t.style.display = 'block';
  clearTimeout(timer);
  timer = setTimeout(() => { t.style.display = 'none'; }, 3000);
}
