/* ============================================================
 *  group-remap.js — "Remap Workflow Groups" prompt.
 *
 *  Extracted from tabs/workflow.js so the Tenant Export tab can reuse
 *  the same dialog and the same semantics instead of growing a second
 *  copy. Both tabs drive the #workflowRemapModal markup in index.html.
 *
 *  Every distinct non-empty value found in from_group / to_groups must be
 *  given a replacement — even when it stays the same. That is deliberate:
 *  silently carrying group names into another environment is the mistake
 *  this prompt exists to prevent.
 *
 *  Public API:
 *    collectGroupNames(rows)        — sorted distinct group values
 *    openGroupRemapModal(groups)    — Promise<{old: new} | null>
 *    applyGroupRemap(rows, remap)   — rewrite from_group / to_groups
 *    remapGroupsInText(text, remap) — rewrite group names inside a string
 *    exposeRemapGlobals()           — wire the modal's inline onclick hooks
 * ============================================================ */

import { escapeHtml, exposeGlobals } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';

let remapResolver = null;

/** Distinct non-empty group names across from_group and to_groups. */
export function collectGroupNames(rows) {
  const set = new Set();
  (rows || []).forEach(row => {
    const fg = typeof row?.from_group === 'string' ? row.from_group.trim() : '';
    if (fg) set.add(fg);
    toGroupArray(row?.to_groups).forEach(g => {
      if (typeof g === 'string') { const t = g.trim(); if (t) set.add(t); }
    });
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** to_groups may arrive as a real array or as a JSON string, depending on
 *  whether the DB client expanded the JSON column. Accept both. */
export function toGroupArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  return [];
}

/** Rewrite from_group / to_groups through the remap, preserving the original
 *  container type so a JSON-string column stays a JSON string. */
export function applyGroupRemap(rows, remap) {
  return (rows || []).map(row => {
    const next = { ...row };

    if (typeof row?.from_group === 'string' && row.from_group.trim()) {
      next.from_group = remap[row.from_group.trim()] ?? row.from_group;
    }

    const groups = toGroupArray(row?.to_groups);
    if (groups.length) {
      const mapped = groups.map(g =>
        (typeof g !== 'string' ? g : (g.trim() ? (remap[g.trim()] ?? g) : g)));
      next.to_groups = Array.isArray(row.to_groups) ? mapped : JSON.stringify(mapped);
    }
    return next;
  });
}

/** Replace group names inside a free-text field such as workflow_name.
 *  Longest names first, so a name that is a prefix of another cannot
 *  partially clobber it. */
export function remapGroupsInText(text, remap) {
  if (typeof text !== 'string' || !text) return text;
  let result = text;
  Object.keys(remap)
    .sort((a, b) => b.length - a.length)
    .forEach(old => {
      if (old && remap[old] !== old) result = result.split(old).join(remap[old]);
    });
  return result;
}

export function openGroupRemapModal(groups) {
  const modal = document.getElementById('workflowRemapModal');
  const content = document.getElementById('workflowRemapContent');
  // Bulk-action header — quick path for "most/all keys stay the same"
  content.innerHTML = `
    <div class="workflow-remap-bulk">
      <div class="workflow-remap-bulk-text">
        <strong>${groups.length}</strong> distinct group${groups.length === 1 ? '' : 's'} found.
        Each needs a replacement value — even if it stays the same.
      </div>
      <button type="button" class="workflow-remap-bulk-btn" onclick="copyAllRemapKeys()" title="Fill every blank row with its current value">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14m-7-7l7 7-7 7"/></svg>
        Keep all unchanged
      </button>
    </div>
  ` + groups.map(group => `
    <div class="workflow-remap-row">
      <div class="workflow-remap-source">
        <span class="workflow-remap-label">Current Group</span>
        <div class="workflow-remap-value">${escapeHtml(group)}</div>
      </div>
      <button type="button" class="workflow-remap-copy" onclick="copyOneRemapKey(this)"
              data-group="${escapeHtml(group)}"
              title="Copy current → new (use the same value)">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14m-7-7l7 7-7 7"/></svg>
      </button>
      <div class="workflow-remap-input">
        <label class="workflow-remap-label" for="workflow-remap-${escapeHtml(group)}">New Group Name</label>
        <input id="workflow-remap-${escapeHtml(group)}" class="workflow-remap-field"
               data-group="${escapeHtml(group)}" placeholder="Enter replacement group name">
        <span class="workflow-remap-error hidden">Replacement value is required.</span>
      </div>
    </div>
  `).join('');
  modal.classList.remove('hidden');
  const firstInput = content.querySelector('input');
  if (firstInput) firstInput.focus();
  return new Promise(resolve => { remapResolver = resolve; });
}

/* Per-row helper — copies the source value to the input on the same row. */
function copyOneRemapKey(btn) {
  const row = btn.closest('.workflow-remap-row');
  if (!row) return;
  const input = row.querySelector('.workflow-remap-field');
  const src = btn.dataset.group || '';
  if (!input) return;
  input.value = src;
  input.classList.remove('error');
  row.querySelector('.workflow-remap-error')?.classList.add('hidden');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  btn.classList.add('is-flash');
  setTimeout(() => btn.classList.remove('is-flash'), 700);
}

/* Bulk helper — fills every blank input with its source value. Doesn't
 * overwrite rows the user already filled differently. */
function copyAllRemapKeys() {
  let filled = 0;
  document.querySelectorAll('#workflowRemapContent .workflow-remap-row').forEach(row => {
    const src = row.querySelector('.workflow-remap-value')?.textContent.trim();
    const input = row.querySelector('.workflow-remap-field');
    if (!input || !src) return;
    if (input.value.trim()) return;        // skip rows the user has already touched
    input.value = src;
    input.classList.remove('error');
    row.querySelector('.workflow-remap-error')?.classList.add('hidden');
    filled++;
  });
  if (filled) showToast('Filled', `${filled} blank row${filled === 1 ? '' : 's'} set to the current value.`, 'info');
  else        showToast('Nothing to Fill', 'All rows already have a value.', 'warning');
}

function closeGroupRemap(result) {
  document.getElementById('workflowRemapModal').classList.add('hidden');
  document.getElementById('workflowRemapContent').innerHTML = '';
  if (remapResolver) { remapResolver(result); remapResolver = null; }
}

function cancelWorkflowGroupRemap() { closeGroupRemap(null); }

function submitWorkflowGroupRemap() {
  const fields = Array.from(document.querySelectorAll('#workflowRemapContent .workflow-remap-field'));
  const remap = {};
  let bad = false;
  fields.forEach(f => {
    const v = f.value.trim();
    const err = f.parentElement.querySelector('.workflow-remap-error');
    if (!v) { f.classList.add('error'); err.classList.remove('hidden'); bad = true; return; }
    f.classList.remove('error'); err.classList.add('hidden');
    remap[f.dataset.group] = v;
  });
  if (bad) { showToast('Validation Error', 'Note: Group remapping is mandatory for all listed values.', 'error'); return; }
  closeGroupRemap(remap);
}

/** Wire the modal's inline onclick handlers. Idempotent — both tabs may call it. */
export function exposeRemapGlobals() {
  exposeGlobals({
    copyOneRemapKey,
    copyAllRemapKeys,
    cancelWorkflowGroupRemap,
    submitWorkflowGroupRemap,
  });
}
