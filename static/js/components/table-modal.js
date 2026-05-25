/* ============================================================
 *  table-modal.js — Reusable Excel-grade table modal.
 *
 *  Features
 *  ────────
 *  · Substring text filter per column (existing)
 *  · Multi-select value filter per column (Excel AutoFilter)
 *  · 3-state column sort with additive multi-column priority
 *    (click = stack as next priority · Shift+click = collapse to this column only)
 *  · Edit mode — toggleable; allows cell edits, row removal,
 *    row insertion (Add Row), and row duplication
 *  · Close-with-confirmation when there are pending edits;
 *    shows a diff summary (added · edited · removed) and lets caller
 *    persist or discard
 *  · CSV export of currently visible rows
 *
 *  Usage
 *  ─────
 *    openTableModal({
 *      title:       'Source Workflow — Table View',
 *      filename:    'workflow',
 *      columns:     [{ key, label, width, numeric, editable }, ...],
 *      rows:        [...],
 *      defaultSort: [{ col, dir }, ...],
 *      onApply:     (modifiedRows) => { ... }  // called when user
 *        // confirms changes; receives the post-edit rows
 *    });
 *
 *  Column shape additions
 *  ──────────────────────
 *    editable: false  — exclude from edit-mode contenteditable
 *                       (objects/arrays default to non-editable)
 *
 *  The modal lives at #tableModal in index.html. Inline toolbar
 *  callbacks are exposed on window from main.js.
 * ============================================================ */

import { qs, escapeHtml } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { downloadBlob } from '../lib/data.js';

/* ── Singleton state ────────────────────────────────────── */
const state = {
  title:        '',
  filename:     'export',
  filenamePrefix: null,     // optional () => string, evaluated at export time
  columns:      [],
  originalData: [],            // immutable snapshot (deep-frozen view)
  data:         [],            // current rows post default-sort
  defaultSort:  [],

  filters:      {},            // { col: substring }
  multi:        {},            // { col: Set<string> of allowed raw-string values }
  sort:         [],            // [{ col, dir }, ...] — index 0 = highest priority

  editMode:     false,
  edits:        new Map(),     // origIndex → { colKey: newValue }
  removed:      new Set(),     // origIndex
  added:        new Set(),     // origIndex of rows added in this session
  origIndexes:  new WeakMap(), // row → origIndex (set on open)
  onApply:      null,

  // multi-filter popover transient state
  pop: { col: null, candidate: null /* Set being edited */ },

  // JSON cell editor transient state
  je:  { open: false, origIdx: null, col: null },
};

/* ── Public API ─────────────────────────────────────────── */
/** One-time wiring: scroll inside the table wrap closes the multi-filter
 *  popover (its position is computed from the chevron's viewport rect, so
 *  it drifts off the chevron once the user scrolls). Idempotent. */
function wireScrollClosers() {
  const wrap = qs('#tableModal .workflow-table-wrap');
  if (!wrap || wrap.dataset._scrollWired === '1') return;
  wrap.dataset._scrollWired = '1';
  wrap.addEventListener('scroll', () => {
    const pop = qs('#tableMultiFilter');
    if (pop && !pop.classList.contains('hidden')) hideMultiFilter();
  }, { passive: true });
}

export function openTableModal({ title, columns, rows, filename, filenamePrefix, defaultSort, onApply }) {
  if (!Array.isArray(rows)) {
    return showToast('Wrong Shape', 'Note: Table data must be a JSON array.', 'error');
  }
  const cols = columns || [];
  const defSort = defaultSort || [];
  const original = rows.slice();
  const sorted = defSort.length ? applyMultiSort(original.slice(), defSort, cols) : original.slice();

  Object.assign(state, {
    title:        title || 'Table View',
    filename:     filename || 'export',
    filenamePrefix: typeof filenamePrefix === 'function' ? filenamePrefix : null,
    columns:      cols,
    originalData: original,
    data:         sorted,
    defaultSort:  defSort,
    filters:      {},
    multi:        {},
    sort:         [],
    editMode:     false,
    edits:        new Map(),
    removed:      new Set(),
    added:        new Set(),
    origIndexes:  new WeakMap(),
    onApply:      typeof onApply === 'function' ? onApply : null,
  });

  // Tag each row in `data` with its origIndex (position in originalData).
  // We use a WeakMap so the tag survives sort but doesn't pollute the row.
  original.forEach((r, i) => state.origIndexes.set(r, i));
  sorted.forEach(r => { if (!state.origIndexes.has(r)) state.origIndexes.set(r, original.indexOf(r)); });

  setTitle();
  setEditMode(false);
  render(true);
  hideConfirm();
  qs('#tableModal').classList.remove('hidden');
  wireScrollClosers();
  setTimeout(() => { const f = qs('#tableModal .wt-filter'); if (f) f.focus(); }, 60);
}

/** Used by Esc, backdrop and the × button — triggers confirmation if dirty. */
export function requestCloseTableModal() {
  if (state.edits.size || state.removed.size || state.added.size) {
    showConfirm();
  } else {
    closeTableModal();
  }
}

export function closeTableModal() {
  hideConfirm();
  hideMultiFilter();
  qs('#tableModal').classList.add('hidden');
}

export function resetTableModalFilters() {
  state.filters = {};
  state.multi = {};
  state.sort = [];
  document.querySelectorAll('#tableModalTable .wt-filter').forEach(i => i.value = '');
  render(true);
}

export function downloadTableModalCSV() {
  const rows = computeRows();
  if (!rows.length) return showToast('Nothing to Export', 'Note: No rows match the current filters.', 'warning');
  const header = state.columns.map(c => c.key).join(',');

  /** Arrays render as `value1, value2` (matches the in-table display);
   *  objects stay JSON-stringified; primitives as-is. The CSV quoting
   *  step below escapes embedded commas/quotes/newlines as needed. */
  const esc = v => {
    let s;
    if (v == null)                  s = '';
    else if (Array.isArray(v))      s = v.join(', ');
    else if (typeof v === 'object') s = JSON.stringify(v);
    else                            s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const body = rows.map(r => state.columns.map(c => esc(effectiveValue(r, c.key))).join(',')).join('\n');

  // Filename: optional caller-provided prefix() runs at click time so the
  // current Tenant Code (or any other late-bound context) gets baked in.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = typeof state.filenamePrefix === 'function' ? state.filenamePrefix() : '';
  const name = (prefix ? prefix + '-' : '') + state.filename + '-' + ts + '.csv';
  downloadBlob(header + '\n' + body, name, 'text/csv;charset=utf-8');
  showToast('Downloaded', `Saved ${rows.length} row${rows.length === 1 ? '' : 's'} as ${name}`, 'success');
}

/* ── Edit mode ──────────────────────────────────────────── */
export function toggleTableEditMode() { setEditMode(!state.editMode); render(true); }

/* ── Row insertion / duplication ──────────────────────────────
 * Both paths push a row into state.originalData and assign it a
 * synthetic origIndex (its position in the data array). The row is
 * tracked in state.added so:
 *   · the diff summary surfaces it as an "Added row"
 *   · filters bypass it (always visible until applied)
 *   · the visual treatment can highlight it (wt-row-new class)
 * Apply: existing applyTableChanges() naturally includes new rows
 * since they live in state.originalData; the merge with state.edits
 * also picks up any cell tweaks the user made on the new row. */
function makeEmptyRow() {
  const r = {};
  state.columns.forEach(c => { r[c.key] = ''; });
  return r;
}
function deepCloneValue(v) {
  if (v == null)               return v;
  if (Array.isArray(v))        return v.map(deepCloneValue);
  if (typeof v === 'object')   { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; } }
  return v;
}
function makeClonedRow(srcRow) {
  const r = {};
  state.columns.forEach(c => {
    const v = effectiveValue(srcRow, c.key);
    r[c.key] = deepCloneValue(v);
  });
  return r;
}

/** Insert a freshly-created row into both originalData (so apply
 *  picks it up) and data (so it renders). After render, focus the
 *  new row's first editable cell. */
function insertNewRow(row, opts = {}) {
  const { afterOrigIdx = null, label = 'New' } = opts;
  const newIdx = state.originalData.length;
  state.originalData.push(row);
  state.added.add(newIdx);
  state.origIndexes.set(row, newIdx);

  // Visible-data placement: right after source row if duplicating,
  // otherwise at the top so the user sees it immediately.
  if (afterOrigIdx != null) {
    const i = state.data.findIndex(r => state.origIndexes.get(r) === afterOrigIdx);
    if (i >= 0) state.data.splice(i + 1, 0, row);
    else state.data.unshift(row);
  } else {
    state.data.unshift(row);
  }

  render(true);
  // Scroll & focus the new row's first editable cell
  setTimeout(() => {
    const tr = document.querySelector(`#tableModalTable tbody tr[data-orig="${newIdx}"]`);
    if (tr) {
      tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const firstEditable = tr.querySelector('.wt-cell-editable');
      if (firstEditable) {
        firstEditable.focus();
        // Place caret at the start
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStart(firstEditable, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, 80);
  showToast(label + ' Row Added', `Note: Row ${newIdx + 1} created in the working copy. Apply on close to persist.`, 'info');
}

/** Remove every trace of an added row. Used both by the delete-row
 *  affordance in the table and by the per-entry Revert button in the
 *  confirm overlay. Tombstones originalData[origIdx] (leaves a null
 *  hole) so later origIdx lookups for OTHER rows are unaffected;
 *  applyTableChanges already filters Boolean over originalData. */
function purgeAddedRow(origIdx) {
  if (!state.added.has(origIdx)) return false;
  state.added.delete(origIdx);
  state.edits.delete(origIdx);
  state.removed.delete(origIdx);
  const row = state.originalData[origIdx];
  if (row) {
    const di = state.data.findIndex(r => r === row);
    if (di >= 0) state.data.splice(di, 1);
    if (state.origIndexes.delete) state.origIndexes.delete(row);
  }
  state.originalData[origIdx] = null;
  return true;
}

export function addTableRow() {
  if (!state.editMode) setEditMode(true);
  insertNewRow(makeEmptyRow(), { label: 'New' });
}

export function duplicateTableRow(origIdx) {
  if (!state.editMode) setEditMode(true);
  const src = state.originalData[origIdx];
  if (!src) return showToast('Cannot Duplicate', 'Note: Source row not found.', 'error');
  insertNewRow(makeClonedRow(src), { afterOrigIdx: origIdx, label: 'Duplicated' });
}

function setEditMode(on) {
  state.editMode = on;
  const tbl   = qs('#tableModalTable');
  const btn   = qs('#tableModalEdit');
  const label = qs('#tableModalEditLabel');
  const iLock = qs('#tableModalEditIconLock');
  const iUnlk = qs('#tableModalEditIconUnlock');
  if (tbl)   tbl.dataset.editMode = on ? 'true' : 'false';
  if (label) label.textContent = on ? 'Lock' : 'Edit';
  if (btn)   btn.classList.toggle('is-on', !!on);
  if (iLock) iLock.classList.toggle('hidden', !on);
  if (iUnlk) iUnlk.classList.toggle('hidden',  on);
}

/* ── JSON cell editor overlay ───────────────────────────────
 * Object/array cells (e.g. `condition`, `to_groups`) are not safe
 * to edit via contenteditable — newlines, quotes, and structure
 * would all need preservation. Instead we open a dedicated overlay
 * with a pretty-printed textarea + live JSON validation. Save is
 * blocked while the buffer is invalid.
 */
function openJsonEditor(origIdx, col) {
  const colDef = state.columns.find(c => c.key === col);
  const row    = state.originalData[origIdx];
  const patch  = state.edits.get(origIdx);
  const value  = patch && col in patch ? patch[col] : (row ? row[col] : null);

  const text = (value === undefined || value === null) ? '' : JSON.stringify(value, null, 2);
  const ta   = qs('#tableModalJsonEditorTextarea');
  if (!ta) return;
  ta.value = text;

  qs('#tableModalJsonEditorCol').textContent    = colDef ? colDef.label : col;
  qs('#tableModalJsonEditorRowIdx').textContent = 'row ' + (origIdx + 1);

  state.je.open    = true;
  state.je.origIdx = origIdx;
  state.je.col     = col;

  qs('#tableModalJsonEditor').classList.remove('hidden');
  validateJsonEditor();
  setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); }, 80);
}

function validateJsonEditor() {
  const ta      = qs('#tableModalJsonEditorTextarea');
  const status  = qs('#tableModalJsonEditorStatus');
  const saveBtn = qs('#tableModalJsonEditorSave');
  if (!ta || !status) return false;

  const text = ta.value;
  const setStatus = (cls, glyph, msg) => {
    status.className = 'wt-json-editor-status ' + cls;
    status.querySelector('.wt-je-status-glyph').textContent = glyph;
    status.querySelector('.wt-je-status-text').textContent  = msg;
    ta.classList.toggle('is-invalid', cls === 'is-invalid');
    if (saveBtn) saveBtn.disabled = (cls === 'is-invalid');
  };

  if (!text.trim()) {
    setStatus('is-valid', '∅', 'Empty (will save as null)');
    return true;
  }
  try {
    JSON.parse(text);
    const bytes = new Blob([text]).size;
    setStatus('is-valid', '✓', `Valid JSON · ${bytes.toLocaleString()} bytes`);
    return true;
  } catch (e) {
    // JSON.parse errors include position info on most engines.
    setStatus('is-invalid', '×', e.message);
    return false;
  }
}

export function saveTableJsonEditor() {
  if (!state.je.open) return;
  const ta = qs('#tableModalJsonEditorTextarea');
  if (!ta) return;
  const text = ta.value;
  let value;
  try { value = text.trim() ? JSON.parse(text) : null; }
  catch (e) { return showToast('Invalid JSON', 'Cannot save: ' + e.message, 'error'); }

  const orig    = state.je.origIdx;
  const col     = state.je.col;
  const origRow = state.originalData[orig];
  const origVal = origRow ? origRow[col] : undefined;

  // No-op if value didn't actually change
  if (JSON.stringify(value) === JSON.stringify(origVal)) {
    const patch = state.edits.get(orig);
    if (patch) {
      delete patch[col];
      if (!Object.keys(patch).length) state.edits.delete(orig);
    }
  } else {
    if (!state.edits.has(orig)) state.edits.set(orig, {});
    state.edits.get(orig)[col] = value;
  }
  closeJsonEditor();
  render(false);
  showToast('JSON Saved', `Note: Row ${orig + 1} · ${col} updated in working copy.`, 'success');
}

export function cancelTableJsonEditor() { closeJsonEditor(); }

function closeJsonEditor() {
  state.je.open    = false;
  state.je.origIdx = null;
  state.je.col     = null;
  qs('#tableModalJsonEditor')?.classList.add('hidden');
}

export function formatTableJsonEditor() {
  const ta = qs('#tableModalJsonEditorTextarea');
  if (!ta) return;
  try {
    const v = ta.value.trim() ? JSON.parse(ta.value) : null;
    ta.value = v === null ? '' : JSON.stringify(v, null, 2);
    validateJsonEditor();
  } catch (e) {
    showToast('Cannot Re-format', e.message, 'error');
  }
}

/** One-time wiring for the JSON editor — runs once on module load.
 *  Listens to `input` for live validation, Tab for indent, Ctrl+Enter
 *  to save, Esc to cancel. Element pre-rendered in index.html. */
(function wireJsonEditorOnce() {
  if (typeof document === 'undefined') return;
  const init = () => {
    const ta = qs('#tableModalJsonEditorTextarea');
    if (!ta || ta.dataset._wired === '1') return;
    ta.dataset._wired = '1';
    ta.addEventListener('input', validateJsonEditor);
    ta.addEventListener('keydown', e => {
      // Tab → insert two spaces (no field-tabbing inside the editor)
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        validateJsonEditor();
        return;
      }
      // Ctrl+Enter (or Cmd+Enter) → save if valid
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (validateJsonEditor()) saveTableJsonEditor();
        return;
      }
      // Esc → cancel
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelTableJsonEditor();
      }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ── Confirm changes overlay ────────────────────────────── */
function showConfirm() {
  const body = qs('#tableModalConfirmBody');
  if (!body) return;
  const diffs = collectDiffs();
  body.innerHTML = renderDiffSummary(diffs);
  qs('#tableModalConfirm').classList.remove('hidden');
}
function hideConfirm() { qs('#tableModalConfirm')?.classList.add('hidden'); }

export function applyTableChanges() {
  const finalRows = state.originalData
    .map((row, i) => {
      if (!row) return null;                // tombstoned (purged added row)
      if (state.removed.has(i)) return null;
      const patch = state.edits.get(i);
      return patch ? { ...row, ...patch } : row;
    })
    .filter(Boolean);
  if (typeof state.onApply === 'function') state.onApply(finalRows);
  const editCount  = state.edits.size;
  // Net deletions: original rows the user removed. Added-then-removed
  // is already a no-op because purgeAddedRow clears both sets, but we
  // belt-and-brace here in case some path leaves a row in both states.
  const rmCount    = Array.from(state.removed).filter(i => !state.added.has(i)).length;
  // Net added = inserted-but-not-removed
  const addedNet   = Array.from(state.added).filter(i => !state.removed.has(i)).length;
  const parts = [];
  if (addedNet)  parts.push(`${addedNet} added`);
  if (editCount) parts.push(`${editCount} row${editCount === 1 ? '' : 's'} edited`);
  if (rmCount)   parts.push(`${rmCount} removed`);
  showToast('Changes Applied', parts.join(' · ') || 'No changes', 'success');
  state.edits.clear();
  state.removed.clear();
  state.added.clear();
  closeTableModal();
}

export function discardTableChanges() {
  state.edits.clear();
  state.removed.clear();
  state.added.clear();
  closeTableModal();
}

/* ── Multi-select filter popover ────────────────────────── */
export function openColumnMultiFilter(col, anchorRect) {
  const pop = qs('#tableMultiFilter');
  if (!pop) return;
  state.pop.col = col;
  state.pop.candidate = state.multi[col] ? new Set(state.multi[col]) : null;
  const colDef = state.columns.find(c => c.key === col);
  qs('#tableMultiFilterTitle').textContent = colDef ? colDef.label : col;

  // Distinct raw values in the currently-visible-after-other-filters set
  const valueCounts = buildValueCounts(col);
  populateMultiFilterList(valueCounts);
  positionPopover(pop, anchorRect);
  pop.classList.remove('hidden');
  const search = qs('#tableMultiFilterSearch');
  if (search) { search.value = ''; search.focus(); }
}

function buildValueCounts(col) {
  // Excel-style: when re-opening a column's filter, show ALL distinct
  // values in that column across the working dataset, regardless of
  // filters applied on OTHER columns. Otherwise a user who has filtered
  // col-B can never see values of col-A that don't co-occur with their
  // chosen col-B values — making "deselect to widen" impossible.
  //
  // We do still skip rows the user has removed in this session (those
  // are never coming back) and tombstoned slots (purged added rows).
  const fc = new Map();
  state.data.forEach((row) => {
    const orig = state.origIndexes.get(row);
    if (orig != null && state.removed.has(orig)) return;
    if (orig != null && !state.originalData[orig]) return;
    const v = String(rawCell(effectiveValue(row, col)));
    fc.set(v, (fc.get(v) || 0) + 1);
  });
  // Ensure any previously-selected value that no longer exists in the
  // dataset still appears (count 0) so the user can uncheck it.
  const sel = state.multi[col];
  if (sel) sel.forEach(v => { if (!fc.has(v)) fc.set(v, 0); });
  return Array.from(fc.entries()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

function populateMultiFilterList(valueCounts) {
  const list = qs('#tableMultiFilterList');
  const all  = qs('#tableMultiFilterAll');
  const cnt  = qs('#tableMultiFilterCount');
  if (!list) return;
  const col = state.pop.col;
  // If a candidate is unset (null), treat as "all selected".
  const selected = state.pop.candidate;
  list.innerHTML = valueCounts.map(([v, n]) => {
    const checked = selected === null ? true : selected.has(v);
    const display = v === '' ? '(blank)' : v;
    return `<label class="wt-mf-item">
      <input type="checkbox" data-value="${escapeHtml(v)}" ${checked ? 'checked' : ''}>
      <span class="wt-mf-value">${escapeHtml(display)}</span>
      <span class="wt-mf-count">${n.toLocaleString()}</span>
    </label>`;
  }).join('');
  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (state.pop.candidate === null) {
        state.pop.candidate = new Set(valueCounts.map(([v]) => v));
      }
      if (cb.checked) state.pop.candidate.add(cb.dataset.value);
      else            state.pop.candidate.delete(cb.dataset.value);
      syncAllCheckbox(valueCounts);
    });
  });
  if (cnt) cnt.textContent = `${valueCounts.length.toLocaleString()} value${valueCounts.length === 1 ? '' : 's'}`;
  syncAllCheckbox(valueCounts);

  // Search-within-popover
  const search = qs('#tableMultiFilterSearch');
  if (search) {
    search.oninput = () => {
      const q = search.value.toLowerCase().trim();
      list.querySelectorAll('.wt-mf-item').forEach(el => {
        const v = el.querySelector('input').dataset.value.toLowerCase();
        el.style.display = !q || v.includes(q) ? '' : 'none';
      });
    };
  }
  if (all) {
    all.onchange = () => {
      const visible = Array.from(list.querySelectorAll('.wt-mf-item'))
        .filter(el => el.style.display !== 'none');
      if (state.pop.candidate === null) state.pop.candidate = new Set(valueCounts.map(([v]) => v));
      visible.forEach(el => {
        const cb = el.querySelector('input');
        cb.checked = all.checked;
        if (all.checked) state.pop.candidate.add(cb.dataset.value);
        else             state.pop.candidate.delete(cb.dataset.value);
      });
    };
  }
}

function syncAllCheckbox(valueCounts) {
  const all = qs('#tableMultiFilterAll');
  if (!all) return;
  const c = state.pop.candidate;
  if (c === null || c.size === valueCounts.length) { all.checked = true;  all.indeterminate = false; }
  else if (c.size === 0)                           { all.checked = false; all.indeterminate = false; }
  else                                             { all.checked = false; all.indeterminate = true;  }
}

export function applyColumnMultiFilter() {
  if (!state.pop.col) return hideMultiFilter();
  if (state.pop.candidate === null) delete state.multi[state.pop.col];
  else                              state.multi[state.pop.col] = state.pop.candidate;
  hideMultiFilter();
  render(true);
}
export function cancelColumnMultiFilter() { hideMultiFilter(); }
export function clearColumnMultiFilter()  { state.pop.candidate = null; applyColumnMultiFilter(); }

function hideMultiFilter() {
  qs('#tableMultiFilter')?.classList.add('hidden');
  state.pop.col = null;
  state.pop.candidate = null;
}

function positionPopover(pop, rect) {
  if (!rect) return;
  const modal = qs('#tableModal .modal-content');
  if (!modal) return;
  const m = modal.getBoundingClientRect();
  let left = rect.left - m.left;
  let top  = rect.bottom - m.top + 4;
  // Constrain within modal bounds
  pop.style.left = Math.max(8, Math.min(m.width - 300, left)) + 'px';
  pop.style.top  = top + 'px';
}

/* ── Filtering / sorting ─────────────────────────────────── */
function effectiveValue(row, key) {
  const orig = state.origIndexes.get(row);
  const patch = orig != null ? state.edits.get(orig) : null;
  if (patch && key in patch) return patch[key];
  return row[key];
}
function rawCell(v) {
  if (v == null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return ''; } }
  return v;
}
function displayCell(v) {
  // Empty / null / empty-array all render as actual empty cells.
  // Cell borders and padding still make each cell distinguishable.
  if (v == null || v === '') return '';
  if (Array.isArray(v))      return v.length ? v.join(', ') : '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return ''; } }
  return String(v);
}
function passesTextFilters(row, filters) {
  return state.columns.every(c => {
    const q = (filters[c.key] || '').toLowerCase().trim();
    if (!q) return true;
    return String(rawCell(effectiveValue(row, c.key))).toLowerCase().includes(q);
  });
}
function passesMultiFilters(row, multi) {
  for (const col in multi) {
    const allowed = multi[col];
    if (!allowed) continue;
    const v = String(rawCell(effectiveValue(row, col)));
    if (!allowed.has(v)) return false;
  }
  return true;
}

function computeRows() {
  const rows = state.data.filter(r => {
    const orig = state.origIndexes.get(r);
    if (state.removed.has(orig)) return false;
    // Rows added in this session bypass filters so the user can always
    // see what they just added and edit it before applying.
    if (state.added.has(orig)) return true;
    return passesTextFilters(r, state.filters) && passesMultiFilters(r, state.multi);
  });
  const sortSpec = state.sort;
  if (!sortSpec.length) return rows;

  // Multi-column priority sort: spec[0] is the primary key, spec[1] the
  // tie-breaker, etc. Comparing live values via effectiveValue() so an
  // in-progress edit reorders correctly without being applied first.
  const colMap = new Map(state.columns.map(c => [c.key, c]));
  return rows.slice().sort((a, b) => {
    for (const { col, dir } of sortSpec) {
      const def = colMap.get(col);
      let av = rawCell(effectiveValue(a, col));
      let bv = rawCell(effectiveValue(b, col));
      if (def && def.numeric) {
        const an = Number(av), bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) { av = an; bv = bn; }
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return dir > 0 ? cmp : -cmp;
    }
    return 0;
  });
}

function applyMultiSort(arr, spec, columns) {
  return arr.sort((a, b) => {
    for (const { col, dir } of spec) {
      const def = columns.find(c => c.key === col);
      let av = rawCell(a[col]), bv = rawCell(b[col]);
      if (def && def.numeric) {
        const an = Number(av), bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) { av = an; bv = bn; }
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return dir > 0 ? cmp : -cmp;
    }
    return 0;
  });
}

/* ── Sort priority strip ──────────────────────────────────────
 * A horizontal strip above the table that surfaces all active sort
 * levels in priority order as chips. Each chip shows "{rank} · {col} ▲/▼"
 * and is clickable: click the chip to flip direction, click the × to
 * remove just that sort level. The strip hides itself entirely when
 * no sort is active — it earns its real-estate only when needed. */
function updateSortStrip() {
  const strip = qs('#tableModalSortStrip');
  if (!strip) return;
  const chipsHost = strip.querySelector('.wt-sort-strip-chips');
  if (!state.sort.length) {
    strip.classList.add('hidden');
    if (chipsHost) chipsHost.innerHTML = '';
    return;
  }
  strip.classList.remove('hidden');
  chipsHost.innerHTML = state.sort.map((s, i) => {
    const col = state.columns.find(c => c.key === s.col);
    const label = col ? col.label : s.col;
    const arrow = s.dir > 0 ? '▲' : '▼';
    return `<span class="wt-sort-chip" data-col="${escapeHtml(s.col)}" title="Click to flip direction · × to remove sort level">
      <span class="wt-sort-chip-rank">${i + 1}</span>
      <span class="wt-sort-chip-label">${escapeHtml(label)}</span>
      <span class="wt-sort-chip-arrow ${s.dir > 0 ? 'is-asc' : 'is-desc'}">${arrow}</span>
      <button type="button" class="wt-sort-chip-x" data-action="remove" aria-label="Remove sort level">×</button>
    </span>`;
  }).join('');
  chipsHost.querySelectorAll('.wt-sort-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const colKey = chip.dataset.col;
      if (e.target.closest('[data-action="remove"]')) {
        const idx = state.sort.findIndex(s => s.col === colKey);
        if (idx >= 0) state.sort.splice(idx, 1);
      } else {
        const item = state.sort.find(s => s.col === colKey);
        if (item) item.dir = item.dir > 0 ? -1 : 1;
      }
      render(true);
    });
  });
}

export function clearTableSort() {
  if (!state.sort.length) return;
  state.sort = [];
  render(true);
}

/* ── Rendering ───────────────────────────────────────────── */
function setTitle() {
  const t = qs('#tableModalTitle');
  if (!t) return;
  const textNode = Array.from(t.childNodes).find(n => n.nodeType === 3);
  if (textNode) textNode.textContent = ' ' + state.title + ' ';
  else t.insertAdjacentText('beforeend', ' ' + state.title + ' ');
}

/** Update only the visible row count in the title bar — used by the
 *  surgical row-delete path so we don't have to re-render the body. */
function recountVisibleRows() {
  const rows = computeRows();
  const total = state.originalData.length;
  const el = qs('#tableModalCount');
  if (el) el.textContent = `${rows.length.toLocaleString()} / ${total.toLocaleString()} rows`;
  // Refresh the Clear button enabled-state too
  const clearBtn = qs('#tableModalClear');
  const anyFilter = Object.values(state.filters).some(v => (v || '').trim())
                 || Object.keys(state.multi).length > 0
                 || state.sort.length > 0;
  if (clearBtn) clearBtn.disabled = !anyFilter;
}

function render(fullRebuild) {
  const { columns, filters, multi, sort, editMode } = state;
  const rows = computeRows();
  const table = qs('#tableModalTable');
  const wrap  = qs('#tableModal .workflow-table-wrap');
  // Preserve scroll across the rebuild — user is likely deep in the list.
  const savedTop  = wrap ? wrap.scrollTop  : 0;
  const savedLeft = wrap ? wrap.scrollLeft : 0;

  if (fullRebuild) {
    const thead = table.querySelector('thead');
    thead.innerHTML = `
      <tr class="wt-header-row">
        ${editMode ? '<th class="wt-actions-col" aria-label="Row actions"></th>' : ''}
        ${columns.map(c => {
          const idx = sort.findIndex(s => s.col === c.key);
          const sortItem = idx >= 0 ? sort[idx] : null;
          const arrow = sortItem ? (sortItem.dir > 0 ? '▲' : '▼') : '↕';
          const rankBadge = (sortItem && sort.length > 1)
            ? `<span class="wt-sort-rank" aria-label="sort priority ${idx + 1}">${idx + 1}</span>`
            : '';
          const styleW = c.width ? `style="min-width:${c.width}px;max-width:${c.width * 2}px"` : '';
          const hasMulti = !!multi[c.key];
          const sortTip = sortItem
            ? `Sort priority ${idx + 1} · ${sortItem.dir > 0 ? 'asc' : 'desc'} — click to flip direction or remove · Shift+click to sort by this column only`
            : 'Click to add as next sort priority · Shift+click to sort by this column only';
          return `<th data-col="${c.key}" ${styleW} class="${c.numeric ? 'is-numeric' : ''}">
            <div class="wt-th-inner">
              <button type="button" class="wt-sort-btn ${sortItem ? 'is-sorted' : ''}" data-col="${c.key}" title="${escapeHtml(sortTip)}">
                <span class="wt-th-label">${c.label}</span>
                <span class="wt-th-arrow ${sortItem ? 'is-active' : ''}">${arrow}</span>
                ${rankBadge}
              </button>
              <button type="button" class="wt-filter-btn ${hasMulti ? 'is-active' : ''}" data-col="${c.key}" title="Filter values">
                <span class="wt-filter-glyph">▽</span>
              </button>
            </div>
          </th>`;
        }).join('')}
      </tr>
      <tr class="wt-filter-row">
        ${editMode ? '<th class="wt-actions-col"></th>' : ''}
        ${columns.map(c => `<th>
          <input type="text" class="wt-filter" data-col="${c.key}"
                 placeholder="filter…" value="${escapeHtml(filters[c.key] || '')}">
        </th>`).join('')}
      </tr>
    `;
    thead.querySelectorAll('.wt-sort-btn').forEach(btn => {
      btn.addEventListener('click', (e) => cycleSort(btn.dataset.col, e.shiftKey));
    });
    thead.querySelectorAll('.wt-filter').forEach(inp => {
      inp.addEventListener('input', e => {
        state.filters[inp.dataset.col] = e.target.value;
        render(false);
      });
    });
    thead.querySelectorAll('.wt-filter-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const rect = btn.getBoundingClientRect();
        openColumnMultiFilter(btn.dataset.col, rect);
      });
    });
  } else {
    table.querySelectorAll('.wt-header-row th').forEach(th => {
      const key = th.dataset.col;
      if (!key) return;
      const idx = sort.findIndex(s => s.col === key);
      const sortItem = idx >= 0 ? sort[idx] : null;
      const arrow = th.querySelector('.wt-th-arrow');
      const sortBtn = th.querySelector('.wt-sort-btn');
      if (arrow) {
        if (sortItem) { arrow.textContent = sortItem.dir > 0 ? '▲' : '▼'; arrow.classList.add('is-active'); }
        else          { arrow.textContent = '↕'; arrow.classList.remove('is-active'); }
      }
      if (sortBtn) sortBtn.classList.toggle('is-sorted', !!sortItem);
      // Sync (or remove) the priority rank badge in-place
      let rank = th.querySelector('.wt-sort-rank');
      if (sortItem && sort.length > 1) {
        if (!rank) {
          rank = document.createElement('span');
          rank.className = 'wt-sort-rank';
          sortBtn && sortBtn.appendChild(rank);
        }
        rank.textContent = String(idx + 1);
        rank.setAttribute('aria-label', `sort priority ${idx + 1}`);
      } else if (rank) {
        rank.remove();
      }
      const fbtn = th.querySelector('.wt-filter-btn');
      if (fbtn) fbtn.classList.toggle('is-active', !!multi[key]);
    });
  }

  // Body
  const tbody = table.querySelector('tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr class="wt-empty"><td colspan="${columns.length + (editMode ? 1 : 0)}">
      <span class="wt-empty-glyph">◇</span> No rows match the current filters.
    </td></tr>`;
  } else {
    tbody.innerHTML = rows.map((row, i) => {
      const orig = state.origIndexes.get(row);
      const dirty = state.edits.has(orig);
      const isNew = state.added.has(orig);
      const trClasses = [
        i % 2 ? 'wt-row-alt' : '',
        dirty ? 'wt-row-dirty' : '',
        isNew ? 'wt-row-new' : '',
      ].filter(Boolean).join(' ');
      return `
        <tr class="${trClasses}" data-orig="${orig}">
          ${editMode ? `<td class="wt-actions-col">
            <div class="wt-row-actions">
              <button type="button" class="wt-row-dup" data-orig="${orig}" title="Duplicate row" aria-label="Duplicate row">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="8" y="8" width="12" height="12" rx="1.4"/>
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16V5a1 1 0 011-1h11"/>
                </svg>
              </button>
              <button type="button" class="wt-row-delete" data-orig="${orig}" title="Remove row" aria-label="Remove row">×</button>
              ${isNew ? '<span class="wt-row-new-badge" title="Added in this session">NEW</span>' : ''}
            </div>
          </td>` : ''}
          ${columns.map(c => {
            const v = effectiveValue(row, c.key);
            const display = displayCell(v);
            const isJson  = v !== null && typeof v === 'object';
            const cellDirty = dirty && state.edits.get(orig) && c.key in state.edits.get(orig);
            const editable  = editMode && c.editable !== false && !isJson;
            const jsonEditable = editMode && c.editable !== false && isJson;
            const tip = jsonEditable ? 'Click to edit JSON' : display;
            return `<td class="${c.numeric ? 'is-numeric' : ''} ${isJson ? 'is-json' : ''} ${cellDirty ? 'wt-cell-dirty' : ''} ${editable ? 'wt-cell-editable' : ''} ${jsonEditable ? 'wt-cell-json-editable' : ''}"
                         data-col="${c.key}" data-orig="${orig}"
                         ${editable ? 'contenteditable="true"' : ''}
                         title="${escapeHtml(tip)}">${escapeHtml(display)}</td>`;
          }).join('')}
        </tr>`;
    }).join('');
    if (editMode) wireEditableCells(tbody);
  }

  qs('#tableModalCount').textContent =
    `${rows.length.toLocaleString()} / ${state.originalData.length.toLocaleString()} rows`;

  updateSortStrip();

  const anyFilter = Object.values(state.filters).some(v => (v || '').trim())
                 || Object.keys(state.multi).length > 0
                 || state.sort.length > 0;
  const clearBtn = qs('#tableModalClear');
  if (clearBtn) clearBtn.disabled = !anyFilter;

  // Restore scroll position so a re-render doesn't snap the user back
  // to the top mid-scroll. Critical after edits/removals on large tables.
  if (wrap) {
    wrap.scrollTop = savedTop;
    wrap.scrollLeft = savedLeft;
  }
}

function wireEditableCells(tbody) {
  tbody.querySelectorAll('.wt-cell-editable').forEach(td => {
    td.addEventListener('input', () => {
      const orig = +td.dataset.orig;
      const col  = td.dataset.col;
      const colDef = state.columns.find(c => c.key === col);
      let val = td.textContent;
      if (colDef && colDef.numeric) {
        const n = Number(val);
        if (!Number.isNaN(n) && val.trim() !== '') val = n;
      }
      // Skip if value matches original (no actual change)
      const origRow = state.originalData[orig];
      if (origRow && val === origRow[col]) {
        const patch = state.edits.get(orig);
        if (patch) {
          delete patch[col];
          if (!Object.keys(patch).length) state.edits.delete(orig);
        }
      } else {
        if (!state.edits.has(orig)) state.edits.set(orig, {});
        state.edits.get(orig)[col] = val;
      }
      td.classList.toggle('wt-cell-dirty', state.edits.has(orig) && col in (state.edits.get(orig) || {}));
      td.closest('tr').classList.toggle('wt-row-dirty', state.edits.has(orig));
    });
    td.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.target.blur(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
    });
  });
  tbody.querySelectorAll('.wt-cell-json-editable').forEach(td => {
    td.addEventListener('click', () => {
      const orig = +td.dataset.orig;
      const col  = td.dataset.col;
      openJsonEditor(orig, col);
    });
  });
  tbody.querySelectorAll('.wt-row-dup').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const orig = +btn.dataset.orig;
      if (Number.isNaN(orig)) return;
      duplicateTableRow(orig);
    });
  });
  tbody.querySelectorAll('.wt-row-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const orig = +btn.dataset.orig;
      if (Number.isNaN(orig)) return;

      // If this row was added in this session, deleting it should leave
      // NO trace — it never existed in the saved data, so it must not
      // surface as a "removed row" in the diff or apply path. Purge it
      // from every tracking set. We tombstone the originalData slot
      // (rather than splice) so other rows' origIdx values stay stable.
      const wasAdded = state.added.has(orig);
      if (wasAdded) purgeAddedRow(orig);
      else          state.removed.add(orig);

      // Surgical remove: drop just this <tr> from the DOM and update
      // the row-count badge. Avoids a full innerHTML rebuild that would
      // (a) reset scroll position and (b) be expensive on 500-row sets.
      // The row stays out of view permanently because computeRows()
      // honours state.removed on every subsequent re-render too.
      const tr = btn.closest('tr');
      if (tr && tr.parentNode) {
        tr.classList.add('wt-row-vanish');
        // Brief fade-out, then remove. If user is mid-scroll, this lets
        // the eye track where the row went.
        setTimeout(() => {
          if (tr.parentNode) tr.remove();
          recountVisibleRows();
        }, 180);
      } else {
        recountVisibleRows();
      }
      const msg = wasAdded
        ? 'Note: This row was added in this session and has been discarded — no delete will be recorded.'
        : 'Note: Removed from the working copy. Apply on close to persist.';
      showToast(wasAdded ? 'Added Row Discarded' : 'Row Removed', msg, 'info');
    });
  });
}

/** Cycle the sort state for a column.
 *  Plain click: stack as the next priority. asc → desc → remove.
 *    Multi-sort is the default — clicking a second column adds it
 *    rather than replacing the first.
 *  Shift+click: collapse to a single-column sort on this column.
 *    If already the sole sort, cycle asc → desc → off. */
function cycleSort(col, shift) {
  const list = state.sort;
  const idx = list.findIndex(s => s.col === col);
  if (shift) {
    if (idx >= 0 && list.length === 1) {
      // Lone sort on this column: asc → desc → off
      if (list[0].dir > 0) list[0].dir = -1;
      else state.sort = [];
    } else {
      // Replace any existing sort(s) with a fresh single-column sort.
      // If this column was already in the multi-sort, preserve its
      // direction; otherwise start ascending.
      const prevDir = idx >= 0 ? list[idx].dir : 1;
      state.sort = [{ col, dir: prevDir }];
    }
  } else {
    if (idx < 0) list.push({ col, dir: 1 });
    else if (list[idx].dir > 0) list[idx].dir = -1;
    else list.splice(idx, 1);
  }
  render(true);
}

/* ── Diff summary ────────────────────────────────────────── */
function collectDiffs() {
  // Edits on rows that aren't pure additions — show them in the edits
  // section. Edits on added rows are folded into the "added" preview
  // since the displayed values already reflect the patch.
  const edits = [];
  state.edits.forEach((patch, origIdx) => {
    if (state.added.has(origIdx)) return;
    // Tombstoned (purged added row) — skip defensively.
    if (!state.originalData[origIdx]) return;
    const row = state.originalData[origIdx];
    const changed = Object.keys(patch).map(col => ({
      col,
      from: row ? row[col] : undefined,
      to:   patch[col],
    }));
    edits.push({ origIdx, row, changed });
  });
  // Net removed: rows the user explicitly deleted that AREN'T also in
  // `added`. An added-then-deleted row should never appear here.
  const removed = Array.from(state.removed)
    .filter(i => !state.added.has(i) && state.originalData[i])
    .map(i => ({ origIdx: i, row: state.originalData[i] }));
  // Net added rows: present in `added` but not slated for removal and
  // not tombstoned.
  const added = Array.from(state.added)
    .filter(i => !state.removed.has(i) && state.originalData[i])
    .map(i => {
      const row = state.originalData[i];
      const patch = state.edits.get(i) || {};
      const merged = { ...row, ...patch };
      return { origIdx: i, row: merged };
    });
  return { edits, removed, added };
}

/** Pretty-print a cell value for the diff view. Objects/arrays use
 *  2-space indentation so multi-line content is human-readable. */
function displayForDiff(v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v))      return v.length ? JSON.stringify(v, null, 2) : '';
  if (typeof v === 'object') { try { return JSON.stringify(v, null, 2); } catch (_) { return '<unserialisable>'; } }
  return String(v);
}

/** Per-entry revert button. Inline onclick keeps things consistent
 *  with the existing overlay buttons (Apply/Discard) and avoids a
 *  separate delegated handler that would have to live inside the
 *  diff body's innerHTML lifecycle. The functions referenced are
 *  exposed as window globals in main.js. */
function revertBtn(kind, origIdx, label = 'Revert') {
  return `<button type="button" class="wt-diff-revert"
    title="Revert this ${kind} (returns the row to its pre-edit state)"
    onclick="revertTableDiff('${kind}', ${origIdx})">
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 14l-4-4m0 0l4-4m-4 4h11a4 4 0 010 8h-1"/>
    </svg><span>${label}</span></button>`;
}

function renderDiffSummary({ edits, removed, added }) {
  const totalEdits = edits.reduce((n, e) => n + e.changed.length, 0);
  const totalChanges = added.length + edits.length + removed.length;
  if (totalChanges === 0) {
    return `<p class="wt-confirm-empty">No pending changes. Close this dialog to return to the table.</p>`;
  }
  let html = `
    <div class="wt-confirm-stats">
      <div class="wt-confirm-stat ok"><strong>${added.length}</strong><span>rows added</span></div>
      <div class="wt-confirm-stat"><strong>${edits.length}</strong><span>rows edited</span></div>
      <div class="wt-confirm-stat"><strong>${totalEdits}</strong><span>cell edits</span></div>
      <div class="wt-confirm-stat warn"><strong>${removed.length}</strong><span>rows removed</span></div>
    </div>
    <p class="wt-confirm-note">Applying will write the modified rows back to the Source Workflow Configuration and proceed to migration SQL generation. Use <strong>Revert</strong> on any individual entry to drop just that change, or <strong>Back to Edit</strong> to keep editing.</p>`;

  if (added.length) {
    html += `<details class="wt-confirm-section" open>
      <summary>Added rows <span>${added.length}</span></summary>
      <div class="wt-confirm-list">
        ${added.slice(0, 30).map(r => `
          <div class="wt-diff-added">
            <span class="wt-diff-idx">+ row ${r.origIdx + 1}</span>
            <span class="wt-diff-added-body">${escapeHtml(summariseRow(r.row)) || '<em>(empty)</em>'}</span>
            ${revertBtn('added', r.origIdx, 'Discard')}
          </div>
        `).join('')}
        ${added.length > 30 ? `<div class="wt-diff-more">… and ${added.length - 30} more</div>` : ''}
      </div>
    </details>`;
  }

  if (edits.length) {
    html += `<details class="wt-confirm-section" open>
      <summary>Cell edits <span>${totalEdits}</span></summary>
      <div class="wt-confirm-list">
        ${edits.slice(0, 50).map(e => `
          <div class="wt-diff-row">
            <div class="wt-diff-row-head">
              <span class="wt-diff-idx">row ${e.origIdx + 1}</span>
              <span class="wt-diff-row-count">${e.changed.length} change${e.changed.length === 1 ? '' : 's'}</span>
              ${revertBtn('edit', e.origIdx, 'Revert')}
            </div>
            <div class="wt-diff-cells">
              ${e.changed.map(ch => {
                const fromText = displayForDiff(ch.from);
                const toText   = displayForDiff(ch.to);
                return `
                  <div class="wt-diff-cell">
                    <div class="wt-diff-col">${escapeHtml(ch.col)}</div>
                    <div class="wt-diff-line wt-diff-line-old">
                      <span class="wt-diff-marker">−</span>
                      <pre class="wt-diff-val">${fromText === '' ? '<em>(empty)</em>' : escapeHtml(fromText)}</pre>
                    </div>
                    <div class="wt-diff-line wt-diff-line-new">
                      <span class="wt-diff-marker">+</span>
                      <pre class="wt-diff-val">${toText === '' ? '<em>(empty)</em>' : escapeHtml(toText)}</pre>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `).join('')}
        ${edits.length > 50 ? `<div class="wt-diff-more">… and ${edits.length - 50} more</div>` : ''}
      </div>
    </details>`;
  }
  if (removed.length) {
    html += `<details class="wt-confirm-section">
      <summary>Removed rows <span>${removed.length}</span></summary>
      <div class="wt-confirm-list">
        ${removed.slice(0, 30).map(r => `
          <div class="wt-diff-removed">
            <span class="wt-diff-idx">row ${r.origIdx + 1}</span>
            <span class="wt-diff-removed-body">${escapeHtml(summariseRow(r.row))}</span>
            ${revertBtn('removed', r.origIdx, 'Restore')}
          </div>
        `).join('')}
        ${removed.length > 30 ? `<div class="wt-diff-more">… and ${removed.length - 30} more</div>` : ''}
      </div>
    </details>`;
  }
  return html;
}

/** Single revert dispatcher — keeps the inline onclick surface small
 *  and lets the overlay re-render once after any kind of revert. */
export function revertTableDiff(kind, origIdx) {
  origIdx = +origIdx;
  if (Number.isNaN(origIdx)) return;
  if (kind === 'added') {
    purgeAddedRow(origIdx);
  } else if (kind === 'edit') {
    state.edits.delete(origIdx);
  } else if (kind === 'removed') {
    state.removed.delete(origIdx);
  } else {
    return;
  }
  // Re-render the table underneath so the row reappears / disappears /
  // de-highlights as appropriate. The overlay sits above so the user
  // won't see flicker; the change is visible the moment they close.
  render(true);
  // If reverting cleared every pending change, the overlay has nothing
  // to confirm. Drop back to the (now clean) table.
  if (!state.edits.size && !state.removed.size && hasNoRealAdds()) {
    hideConfirm();
    return;
  }
  // Otherwise refresh the overlay's diff content in place.
  const body = qs('#tableModalConfirmBody');
  if (body) body.innerHTML = renderDiffSummary(collectDiffs());
}

/** state.added may contain origIdx values whose originalData slot has
 *  been tombstoned (purged). Count only the live ones. */
function hasNoRealAdds() {
  for (const i of state.added) if (state.originalData[i]) return false;
  return true;
}

/** "Back to Edit" footer action. Just hides the overlay; pending
 *  state stays intact so the user can keep editing. */
export function backToTableEdit() {
  hideConfirm();
}

function summariseRow(row) {
  if (!row) return '(unknown)';
  const top = state.columns.slice(0, 4).map(c => `${c.key}=${displayCell(row[c.key])}`).join('  ·  ');
  return top;
}

/* ── Esc + backdrop ──────────────────────────────────────── */
/* ── Bulletproof exit paths ───────────────────────────────────
 * Every way out of the table modal flows through one funnel:
 *   1. JSON editor open  → its own keydown handles Escape; clicks
 *      stay trapped because the editor sits inside the wrap.
 *   2. Multi-filter popover open → Esc / outside-click closes it
 *      first (does NOT advance to closing the modal).
 *   3. Confirm overlay open → Esc closes confirm; clicks anywhere
 *      else are absorbed (see capture-phase guard below).
 *   4. Modal close (× / backdrop / Esc) → ALWAYS routes through
 *      requestCloseTableModal, which surfaces the Review Changes
 *      overlay if edits/removals are pending.
 *
 * Dirty state cannot escape without confirmation: backdrop click,
 * Escape, and × all funnel into requestCloseTableModal.
 */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const m = qs('#tableModal');
  if (!m || m.classList.contains('hidden')) return;
  // Top of the stack first
  if (state.je.open) return;                                                   // JSON editor: own handler
  if (!qs('#tableMultiFilter').classList.contains('hidden')) return hideMultiFilter();
  if (!qs('#tableModalConfirm').classList.contains('hidden')) return hideConfirm();
  requestCloseTableModal();
});

document.addEventListener('click', e => {
  const m = qs('#tableModal');
  if (!m || m.classList.contains('hidden')) return;

  // While the confirm overlay is up, only its own buttons may act —
  // catch any stray click that escapes its z-index and route the user
  // back to confirming. Header buttons (×, Edit, Clear, Export) stay
  // clickable because they're outside .workflow-table-wrap, but if
  // somebody clicks × while confirm is open the answer is still
  // "you have pending changes" — re-show is a no-op.
  const confirmOpen = !qs('#tableModalConfirm').classList.contains('hidden');

  // Click on the modal backdrop itself
  if (e.target === m) {
    if (confirmOpen) return;          // ignore — let user use Apply/Discard
    requestCloseTableModal();
    return;
  }

  // Click outside multi-filter popover → close just the popover
  const pop = qs('#tableMultiFilter');
  if (pop && !pop.classList.contains('hidden')
      && !pop.contains(e.target)
      && !e.target.closest('.wt-filter-btn')) {
    hideMultiFilter();
  }
});
