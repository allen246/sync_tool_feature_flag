/* ============================================================
 *  modal.js — Manage modal show/hide + global Escape + backdrop close.
 *
 *  Modals are pre-rendered in index.html. We don't create their DOM —
 *  we just toggle the `.hidden` class and bind shared close behaviour.
 *
 *  Public API:
 *    showModalById(id)          — remove .hidden
 *    closeModalById(id)         — add .hidden
 *    showNotesModal(notes[])    — populates #noteContent and opens
 *    closeNotesModal()
 *    bindModalEscape()          — wire Esc + backdrop close globally
 * ============================================================ */

import { qs } from './dom.js';

export function showModalById(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('hidden');
}

export function closeModalById(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('hidden');
}

export function showNotesModal(notes) {
  const target = qs('#noteContent');
  if (!target) return;
  const ul = notes.map(n => `<li>${n.replace(/^Note:\s*/i, '')}</li>`).join('');
  target.innerHTML = `<ul>${ul}</ul>`;
  showModalById('noteModal');
}

export function closeNotesModal() { closeModalById('noteModal'); }

/** IDs of modals that own their close lifecycle (they have edits to confirm,
 *  layered overlays, etc.) and should NOT be force-closed by this generic
 *  Escape / backdrop handler. */
const SELF_MANAGED_MODAL_IDS = new Set(['tableModal']);

/** Wire global Escape + backdrop close for every .modal on the page,
 *  except those listed above. */
export function bindModalEscape() {
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal:not(.hidden)').forEach(m => {
      if (SELF_MANAGED_MODAL_IDS.has(m.id)) return;
      m.classList.add('hidden');
    });
  });
  document.addEventListener('click', e => {
    // Click on the modal backdrop itself (not its content) closes it —
    // unless the modal manages its own close (e.g. tableModal, which
    // routes the close through requestCloseTableModal so pending edits
    // surface the Review Changes overlay).
    if (e.target && e.target.classList && e.target.classList.contains('modal')
        && !e.target.classList.contains('hidden')
        && !SELF_MANAGED_MODAL_IDS.has(e.target.id)) {
      e.target.classList.add('hidden');
    }
  });
}
