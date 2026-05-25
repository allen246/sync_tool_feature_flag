/* ============================================================
 *  table-modal.js — Reusable Excel-grade table modal.
 *
 *  Features
 *  ────────
 *  · Substring text filter per column (existing)
 *  · NEW: Multi-select value filter per column (Excel AutoFilter)
 *  · 3-state column sort + multi-column defaultSort
 *  · NEW: Edit mode — toggleable; allows cell edits + row removal
 *  · NEW: Close-with-confirmation when there are pending edits;
 *         shows a diff summary and lets caller persist or discard
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
  sort:         { col: null, dir: 0 },

  editMode:     false,
  edits:        new Map(),     // origIndex → { colKey: newValue }
  removed:      new Set(),     // origIndex
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
    sort:         { col: null, dir: 0 },
    editMode:     false,
    edits:        new Map(),
    removed:      new Set(),
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
  if (state.edits.size || state.removed.size) {
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
  state.sort = { col: null, dir: 0 };
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
      if (state.removed.has(i)) return null;
      const patch = state.edits.get(i);
      return patch ? { ...row, ...patch } : row;
    })
    .filter(Boolean);
  if (typeof state.onApply === 'function') state.onApply(finalRows);
  const editCount = state.edits.size;
  const rmCount   = state.removed.size;
  showToast('Changes Applied',
    `${editCount} row${editCount === 1 ? '' : 's'} edited · ${rmCount} removed.`,
    'success');
  state.edits.clear();
  state.removed.clear();
  closeTableModal();
}

export function discardTableChanges() {
  state.edits.clear();
  state.removed.clear();
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
  const others = { ...state.multi };
  delete others[col];                       // ignore this column's own filter
  const filtersCopy = { ...state.filters };
  const fc = new Map();
  state.data.forEach((row, i) => {
    if (state.removed.has(state.origIndexes.get(row))) return;
    if (!passesTextFilters(row, filtersCopy)) return;
    if (!passesMultiFilters(row, others)) return;
    const v = String(rawCell(effectiveValue(row, col)));
    fc.set(v, (fc.get(v) || 0) + 1);
  });
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
    return passesTextFilters(r, state.filters) && passesMultiFilters(r, state.multi);
  });
  const s = state.sort;
  if (s.col && s.dir) {
    const col = state.columns.find(c => c.key === s.col);
    return rows.slice().sort((a, b) => {
      let av = rawCell(effectiveValue(a, s.col));
      let bv = rawCell(effectiveValue(b, s.col));
      if (col && col.numeric) {
        const an = Number(av), bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) { av = an; bv = bn; }
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return s.dir > 0 ? cmp : -cmp;
    });
  }
  return rows;
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
                 || state.sort.col;
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
          const sorted = sort.col === c.key;
          const arrow = sorted ? (sort.dir > 0 ? '▲' : '▼') : '↕';
          const styleW = c.width ? `style="min-width:${c.width}px;max-width:${c.width * 2}px"` : '';
          const hasMulti = !!multi[c.key];
          return `<th data-col="${c.key}" ${styleW} class="${c.numeric ? 'is-numeric' : ''}">
            <div class="wt-th-inner">
              <button type="button" class="wt-sort-btn" data-col="${c.key}">
                <span class="wt-th-label">${c.label}</span>
                <span class="wt-th-arrow ${sorted ? 'is-active' : ''}">${arrow}</span>
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
      btn.addEventListener('click', () => cycleSort(btn.dataset.col));
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
      const arrow = th.querySelector('.wt-th-arrow');
      if (arrow) {
        if (sort.col === key) { arrow.textContent = sort.dir > 0 ? '▲' : '▼'; arrow.classList.add('is-active'); }
        else                  { arrow.textContent = '↕'; arrow.classList.remove('is-active'); }
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
      return `
        <tr class="${i % 2 ? 'wt-row-alt' : ''} ${dirty ? 'wt-row-dirty' : ''}" data-orig="${orig}">
          ${editMode ? `<td class="wt-actions-col">
            <button type="button" class="wt-row-delete" data-orig="${orig}" title="Remove row" aria-label="Remove row">×</button>
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

  const anyFilter = Object.values(state.filters).some(v => (v || '').trim())
                 || Object.keys(state.multi).length > 0
                 || state.sort.col;
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
  tbody.querySelectorAll('.wt-row-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const orig = +btn.dataset.orig;
      if (Number.isNaN(orig)) return;
      state.removed.add(orig);

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
      showToast('Row Removed', 'Note: Removed from the working copy. Apply on close to persist.', 'info');
    });
  });
}

function cycleSort(col) {
  const s = state.sort;
  if (s.col === col) {
    s.dir = s.dir === 0 ? 1 : s.dir === 1 ? -1 : 0;
    if (s.dir === 0) s.col = null;
  } else { s.col = col; s.dir = 1; }
  render(false);
}

/* ── Diff summary ────────────────────────────────────────── */
function collectDiffs() {
  const edits = [];
  state.edits.forEach((patch, origIdx) => {
    const row = state.originalData[origIdx];
    const changed = Object.keys(patch).map(col => ({
      col,
      from: row ? row[col] : undefined,
      to:   patch[col],
    }));
    edits.push({ origIdx, row, changed });
  });
  const removed = Array.from(state.removed).map(i => ({ origIdx: i, row: state.originalData[i] }));
  return { edits, removed };
}

/** Pretty-print a cell value for the diff view. Objects/arrays use
 *  2-space indentation so multi-line content is human-readable. */
function displayForDiff(v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v))      return v.length ? JSON.stringify(v, null, 2) : '';
  if (typeof v === 'object') { try { return JSON.stringify(v, null, 2); } catch (_) { return '<unserialisable>'; } }
  return String(v);
}

function renderDiffSummary({ edits, removed }) {
  const totalEdits = edits.reduce((n, e) => n + e.changed.length, 0);
  let html = `
    <div class="wt-confirm-stats">
      <div class="wt-confirm-stat"><strong>${edits.length}</strong><span>rows edited</span></div>
      <div class="wt-confirm-stat"><strong>${totalEdits}</strong><span>cell edits</span></div>
      <div class="wt-confirm-stat warn"><strong>${removed.length}</strong><span>rows removed</span></div>
    </div>
    <p class="wt-confirm-note">Applying will write the modified rows back to the Source Workflow Configuration and proceed to migration SQL generation.</p>`;

  if (edits.length) {
    html += `<details class="wt-confirm-section" open>
      <summary>Cell edits <span>${totalEdits}</span></summary>
      <div class="wt-confirm-list">
        ${edits.slice(0, 50).map(e => `
          <div class="wt-diff-row">
            <div class="wt-diff-row-head">
              <span class="wt-diff-idx">row ${e.origIdx + 1}</span>
              <span class="wt-diff-row-count">${e.changed.length} change${e.changed.length === 1 ? '' : 's'}</span>
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
          </div>
        `).join('')}
        ${removed.length > 30 ? `<div class="wt-diff-more">… and ${removed.length - 30} more</div>` : ''}
      </div>
    </details>`;
  }
  return html;
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
