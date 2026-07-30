/* ============================================================
 *  tabs/workflow.js — Workflow Sync (with group-remap modal +
 *  table view button on the source JSON).
 * ============================================================ */

import { ICONS, exposeGlobals, formatBytes } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { setLoading, activeButton } from '../lib/feedback.js';
import { validateFields, validateJSON, normalizeInput, registerInputs, extractJsonArray, parseCSV } from '../lib/data.js';
import { flowRibbon, sectionHeader, offlineCallout, outputCard, finalSqlBox, jsonGroup, renderPullResult } from '../components/sections.js';
import { registerJsonGroupAction, registerUploadVariant } from '../components/json-group.js';
import { openTableModal } from '../components/table-modal.js';
import { collectGroupNames, applyGroupRemap, openGroupRemapModal,
         exposeRemapGlobals } from '../components/group-remap.js';

registerInputs({
  plain: ['wTenant'],
  csv:   ['wBranches', 'wProducts'],
});

const FLOW = [
  { key: 'configure', glyph: '◐', label: 'Configure' },
  { key: 'emit',      glyph: '⇆', label: 'Pull Query' },
  { key: 'run',       glyph: '↗', label: 'Run on Source', external: true },
  { key: 'paste',     glyph: '⇋', label: 'Paste & Remap' },
  { key: 'final',     glyph: '▣', label: 'Migration SQL' },
];

/* ── Workflow source JSON columns.
 *  · `formatted_condition_string` is in the CSV template but is NOT
 *    in the JSON returned by /workflow/pull — so it's omitted.
 *  · The JSON has `product_name` (p.tag) for the display name and
 *    `product` (p.code) for the internal code — what the CSV calls
 *    `sub_product`. We map the Sub-Product column off `product`. */
const TABLE_COLUMNS = [
  { key: 'branch',        label: 'Branch',     width: 80  },
  { key: 'product_name',  label: 'Product',    width: 130 },
  { key: 'product',       label: 'Sub-Product',width: 110 },
  { key: 'module',        label: 'Module',     width: 90  },
  { key: 'transition_id', label: 'Transition', width: 100, numeric: true },
  { key: 'from_group',    label: 'From Group', width: 160 },
  { key: 'to_groups',     label: 'To Groups',  width: 200 },
  { key: 'condition',     label: 'Condition (JSON)', width: 280 },
  { key: 'trigger',       label: 'Trigger',    width: 100 },
  { key: 'priority',      label: 'Priority',   width: 90,  numeric: true },
  { key: 'workflow_id',   label: 'Workflow ID',width: 100, numeric: true },
];

/* Initial natural order: branch → product_name → module. Click a
 * header to stack it as the next sort priority, Shift+click to
 * collapse to a single-column sort on that column. */
const TABLE_DEFAULT_SORT = [
  { col: 'branch',       dir: 1 },
  { col: 'product_name', dir: 1 },
  { col: 'module',       dir: 1 },
];

function render(host) {
  host.innerHTML = `
${flowRibbon('workflow', FLOW)}

${sectionHeader(1, 'Configure & Emit Pull Query',
  'Tenant is required. Branches and Products narrow the scope — leave blank to capture everything for the tenant.')}

<div class="form-row">
  <div class="form-group">
    <label>Tenant Code <span class="required">*</span></label>
    <input id="wTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">Organization / tenant identifier</span>
  </div>
  <div class="form-group">
    <label>Branch Codes</label>
    <input id="wBranches" placeholder="e.g. BR001, BR002 (optional)">
    <span class="field-hint">Optional — leave blank for all branches</span>
  </div>
  <div class="form-group">
    <label>Product Codes</label>
    <input id="wProducts" placeholder="e.g. PROD_A, PROD_B (optional)">
    <span class="field-hint">Optional — leave blank for all products</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="workflowPull()">${ICONS.generate} Generate Pull SQL</button>
</div>
<div id="wPullResult"></div>

${offlineCallout('Run the pull query on the Source database',
  'Copy the Source query above, execute it in your DB tool, and return below with the JSON output. A group-remapping prompt will appear before the migration SQL is built.')}

${sectionHeader(2, 'Paste Source Result-set', 'Drop the JSON output from the Source DB pull below.')}

<div class="json-grid single">
  ${jsonGroup({ id: 'wJson', label: 'Source Workflow Configuration', side: 'source' })}
</div>
<div class="btn-row">
  <button class="primary" onclick="workflowFinal()">${ICONS.finish} Generate Final SQL</button>
</div>

${outputCard('Migration SQL', 'Generated migration. Review every statement before executing on Destination.', finalSqlBox('wFinal'))}`;
}

function workflowPull() {
  const wTenant   = document.getElementById('wTenant');
  const wBranches = document.getElementById('wBranches');
  const wProducts = document.getElementById('wProducts');
  [wTenant, wBranches, wProducts].forEach(normalizeInput);
  if (!validateFields([{ el: wTenant, label: 'Tenant Code' }])) return;
  const btn = activeButton(); setLoading(btn, true, 'generating pull query · workflow');

  fetch('/workflow/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant: wTenant.value, branches: wBranches.value, products: wProducts.value,
    }) })
  .then(r => r.json()).then(data => {
    renderPullResult('wPullResult', data);
    const hasSrc = data.source_query && data.source_query.trim();
    showToast('Pull SQL Generated',
      `Note: ${hasSrc ? 'Source DB query ready. Run on Source DB.' : 'No query generated.'}`,
      'success');
  }).catch(() => showToast('Server Error', 'Note: Failed to generate Pull SQL. Check server logs.', 'error'))
   .finally(() => setLoading(btn, false));
}

async function workflowFinal() {
  ['wTenant','wBranches','wProducts'].forEach(id => normalizeInput(document.getElementById(id)));
  const wJson = document.getElementById('wJson');
  if (!validateJSON([{ el: wJson, label: 'Source Workflow Configuration' }])) return;

  let rows;
  try { rows = JSON.parse(wJson.value); }
  catch (e) { return showToast('Invalid JSON', 'Note: Fix the Source Workflow Configuration.', 'error'); }
  if (!Array.isArray(rows)) {
    return showToast('Invalid JSON', 'Note: Source Workflow Configuration must be a JSON array.', 'error');
  }

  const groups = collectGroupNames(rows);
  let payloadRows = rows;
  if (groups.length) {
    const remap = await openGroupRemapModal(groups);
    if (!remap) return showToast('Cancelled', 'Note: Final SQL generation was cancelled.', 'info');
    payloadRows = applyGroupRemap(rows, remap);
  }

  const btn = activeButton(); setLoading(btn, true, 'building migration sql · workflow');
  fetch('/workflow/final', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant: document.getElementById('wTenant').value,
      branches: document.getElementById('wBranches').value,
      source_json: JSON.stringify(payloadRows),
    }) })
  .then(r => r.json()).then(d => {
    const finalEl = document.getElementById('wFinal');
    finalEl.value = d.result;
    finalEl.dispatchEvent(new Event('input', { bubbles: true }));
    showToast('Final SQL Generated', 'Note: Review and execute on Destination DB.', 'success');
  }).catch(() => showToast('Server Error', 'Note: Failed to generate Final SQL. Check server logs.', 'error'))
   .finally(() => setLoading(btn, false));
}

/* ── Table view (uses generic table modal) ───────────────── */
function openWorkflowTable(textarea) {
  if (!textarea || !textarea.value.trim()) {
    return showToast('Nothing to View', 'Note: Paste or upload the Source Workflow Configuration first.', 'warning');
  }

  // Use the unwrap-aware extractor. Handles JSON_ARRAYAGG wrappers,
  // double-stringified payloads, smart quotes, BOM, etc.
  let result;
  try { result = extractJsonArray(textarea.value); }
  catch (e) {
    return showToast('Invalid JSON',
      'Note: Could not parse Source Workflow Configuration — ' + e.message, 'error');
  }
  const rows = result.rows;

  // If the source was wrapped or repaired, write the canonical
  // (unwrapped, repaired) form back so subsequent operations
  // (Generate Final SQL, re-open Table View) skip the same work.
  if (result.unwrapped || result.fixes.length) {
    textarea.value = JSON.stringify(rows, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const note = result.unwrapped
      ? `Unwrapped to ${rows.length} row${rows.length === 1 ? '' : 's'}.`
      : `Cleaned (${result.fixes.join(', ')}).`;
    showToast('JSON Normalized', 'Note: ' + note, 'info');
  }

  openTableModal({
    title:       'Source Workflow — Table View',
    filename:    'workflow',
    // Evaluated at export click time so the *current* Tenant Code is
    // baked into the CSV filename — even if the user edits the field
    // after opening the table view. Falls back silently to no-prefix
    // if blank, so the filename stays clean.
    filenamePrefix: () => {
      const v = (document.getElementById('wTenant')?.value || '').trim();
      return v ? v.replace(/[^A-Za-z0-9_.-]+/g, '_') : '';
    },
    columns:     TABLE_COLUMNS,
    defaultSort: TABLE_DEFAULT_SORT,
    rows,
    onApply:     (modifiedRows) => {
      // Persist the post-edit rows back to the source textarea as
      // pretty JSON so the user can see the change reflected and
      // the existing /workflow/final flow picks it up unchanged.
      const t = document.getElementById('wJson');
      if (!t) return;
      t.value = JSON.stringify(modifiedRows, null, 2);
      t.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('Source Updated',
        `Note: ${modifiedRows.length} row${modifiedRows.length === 1 ? '' : 's'} written back. Click Generate Final SQL to process.`,
        'success');
    },
  });
}

// Register the Table View button on wJson with the json-group decorator.
registerJsonGroupAction('wJson', {
  cls:   'json-table-btn',
  icon:  ICONS.table,
  label: 'Table View',
  title: 'Open as filterable table',
  onClick: openWorkflowTable,
});

/* ── CSV → workflow-JSON conversion ────────────────────────
 * Maps the workflow CSV export schema (canonical column names) onto
 * the JSON shape /workflow/final expects. Accepts both the original
 * CSV ("sub_product" column) and our exported CSV ("product" column).
 * `to_groups` parses back from "VAL1, VAL2" → array; `condition`
 * parses back from JSON string → object. Empty strings become
 * sensible defaults per column type.
 */
const CSV_NUMERIC_COLS = new Set(['transition_id', 'priority', 'workflow_id']);
const CSV_ARRAY_COLS   = new Set(['to_groups']);
const CSV_JSON_COLS    = new Set(['condition']);
const CSV_SKIP_COLS    = new Set(['formatted_condition_string']);
const CSV_REQUIRED_COLS = ['branch', 'module', 'transition_id'];   // sanity check

/** @returns {Object[]}  Array of workflow rows ready to drop into wJson */
function csvToWorkflowJson(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) throw new Error('CSV is empty');
  const header = rows[0].map(h => h.trim());
  if (header.length < 3) throw new Error('CSV header looks malformed');

  // Sanity-check: at least one known workflow column must be present
  const hasKnown = CSV_REQUIRED_COLS.some(c => header.includes(c));
  if (!hasKnown) throw new Error(`CSV header missing required workflow columns (${CSV_REQUIRED_COLS.join(', ')})`);

  // Build column index → JSON key map. Aliases:
  //   · sub_product → product (matches DB JSON shape)
  const keyForIdx = header.map(h => {
    if (h === 'sub_product') return 'product';
    return h;
  });

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue;   // blank line
    const obj = {};
    for (let c = 0; c < cells.length; c++) {
      const key = keyForIdx[c];
      if (!key || CSV_SKIP_COLS.has(key)) continue;
      const raw = cells[c];

      if (raw === '' || raw == null) {
        if (CSV_ARRAY_COLS.has(key))      obj[key] = [];
        else if (CSV_NUMERIC_COLS.has(key)) /* omit */ ;
        else                              obj[key] = '';
        continue;
      }

      if (CSV_ARRAY_COLS.has(key)) {
        obj[key] = raw.split(',').map(s => s.trim()).filter(Boolean);
      } else if (CSV_NUMERIC_COLS.has(key)) {
        const n = Number(raw);
        obj[key] = Number.isNaN(n) ? raw : n;
      } else if (CSV_JSON_COLS.has(key)) {
        try { obj[key] = JSON.parse(raw); }
        catch (_) { obj[key] = raw; }
      } else {
        obj[key] = raw;
      }
    }
    out.push(obj);
  }
  if (!out.length) throw new Error('No data rows found in CSV');
  return out;
}

function uploadWorkflowCSV(textarea) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', function () {
    const file = this.files && this.files[0];
    document.body.removeChild(input);
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      return showToast('File Too Large', 'Note: CSV must be under 50 MB.', 'error');
    }
    const reader = new FileReader();
    reader.onload = () => {
      let rows;
      try { rows = csvToWorkflowJson(String(reader.result || '')); }
      catch (e) {
        return showToast('CSV Parse Failed', 'Note: ' + e.message, 'error');
      }
      textarea.value = JSON.stringify(rows, null, 2);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('CSV Converted',
        `Note: ${file.name} · ${formatBytes(file.size)} → ${rows.length} workflow row${rows.length === 1 ? '' : 's'} loaded as JSON.`,
        'success');
    };
    reader.onerror = () => showToast('Read Failed', `Note: Could not read ${file.name}.`, 'error');
    reader.readAsText(file);
  });
  input.click();
}

// Register CSV as a second option in the Upload dropdown (alongside JSON).
// Strict accept — picker shows only .csv files; auto-converts on read.
registerUploadVariant('wJson', {
  key:    'csv',
  label:  'CSV',
  accept: '.csv,text/csv',
  icon:   ICONS.table,
  onPick: uploadWorkflowCSV,
});

exposeGlobals({ workflowPull, workflowFinal });
// The remap dialog's own inline handlers live with the shared component.
exposeRemapGlobals();

export const workflowTab = {
  key: 'workflow',
  statusKey: 'WORKFLOW',
  endpoints: { src: 'DB', dst: null },
  render,
  syncStepper({ setState, gateFields }) {
    const pull  = document.getElementById('wPullResult');
    const final = document.getElementById('wFinal');
    const hasPull  = !!(pull && pull.children.length > 0);
    const hasFinal = !!(final && final.value && final.value.trim());
    setState('workflow', {
      configure: hasPull ? 'done' : 'active',
      emit:      hasFinal ? 'done' : (hasPull ? 'done' : 'pending'),
      run:       hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      paste:     hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      final:     hasFinal ? 'active' : 'pending',
    });
    gateFields({ pullId: 'wPullResult', jsonIds: ['wJson'], submitFn: 'workflowFinal', hasPull });
  },
};
