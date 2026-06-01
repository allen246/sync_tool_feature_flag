/* ============================================================
 *  tabs/branch.js — Branch Sync (branch_product migrations).
 * ============================================================ */

import { ICONS, exposeGlobals } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { showNotesModal } from '../lib/modal.js';
import { setLoading, activeButton } from '../lib/feedback.js';
import { validateFields, validateJSON, normalizeInput, registerInputs, extractJsonArray } from '../lib/data.js';
import { flowRibbon, sectionHeader, offlineCallout, outputCard, finalSqlBox, jsonGroup, renderPullResult } from '../components/sections.js';
import { registerJsonGroupAction } from '../components/json-group.js';
import { openTableModal } from '../components/table-modal.js';
import { defaultGateFields } from '../state/flow-state.js';

registerInputs({
  plain: ['bTenant'],
  csv:   ['bBranches', 'bProducts'],
});

const FLOW = [
  { key: 'configure', glyph: '◐', label: 'Configure' },
  { key: 'emit',      glyph: '⇆', label: 'Pull Queries' },
  { key: 'run',       glyph: '↗', label: 'Run on DBs', external: true },
  { key: 'paste',     glyph: '⇋', label: 'Paste JSON' },
  { key: 'final',     glyph: '▣', label: 'Migration SQL' },
];

function render(host) {
  host.innerHTML = `
${flowRibbon('branch', FLOW)}

${sectionHeader(1, 'Configure & Emit Pull Queries',
  'Provide tenant, branches and products. The console emits Source & Destination queries you will run to capture the current state.')}

<div class="form-row">
  <div class="form-group">
    <label>Tenant Code <span class="required">*</span></label>
    <input id="bTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">Organization / tenant identifier</span>
  </div>
  <div class="form-group">
    <label>Branch Codes <span class="required">*</span></label>
    <input id="bBranches" placeholder="e.g. BR001, BR002">
    <span class="field-hint">Comma-separated branch codes</span>
  </div>
  <div class="form-group">
    <label>Product Codes <span class="required">*</span></label>
    <input id="bProducts" placeholder="e.g. PROD1, PROD2">
    <span class="field-hint">Comma-separated product codes</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="branchPull()">${ICONS.generate} Generate Pull SQL</button>
</div>
<div id="bPullResult"></div>

${offlineCallout('Run each query on the database it targets',
  'Copy the Source query to your Source DB tool, run it, save the JSON result. Repeat for the Destination query. Return below with both result-sets.')}

${sectionHeader(2, 'Paste Result-sets', 'Drop the JSON output of each pull query into the matching slot below.')}

<div class="json-grid">
  ${jsonGroup({ id: 'bJson1', label: 'Source Branch & Product Snapshot',     side: 'source' })}
  ${jsonGroup({ id: 'bJson2', label: 'Destination Branch & Product State',   side: 'dest' })}
</div>
<div class="btn-row">
  <button class="primary" onclick="branchFinal()">${ICONS.finish} Generate Final SQL</button>
</div>

${outputCard('Migration SQL', 'Generated migration. Review every statement before executing on Destination.', finalSqlBox('bFinal'))}`;
}

function branchPull() {
  const bTenant   = document.getElementById('bTenant');
  const bBranches = document.getElementById('bBranches');
  const bProducts = document.getElementById('bProducts');
  [bTenant, bBranches, bProducts].forEach(normalizeInput);
  if (!validateFields([
    { el: bTenant,   label: 'Tenant Code' },
    { el: bBranches, label: 'Branch Codes' },
    { el: bProducts, label: 'Product Codes' },
  ])) return;
  const btn = activeButton(); setLoading(btn, true, 'generating pull queries · branch / product');

  fetch('/branch/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: bTenant.value, branches: bBranches.value, products: bProducts.value }) })
  .then(r => r.json()).then(data => {
    renderPullResult('bPullResult', data);
    const hasSrc  = data.source_query && data.source_query.trim();
    const hasDest = data.destination_query && data.destination_query.trim();
    const parts = [hasSrc && 'Source DB', hasDest && 'Destination DB'].filter(Boolean);
    showToast('Pull SQL Generated',
      `Note: ${parts.join(' & ')} quer${parts.length > 1 ? 'ies' : 'y'} ready. Run on the respective database${parts.length > 1 ? 's' : ''}.`,
      'success');
  }).catch(() => showToast('Server Error', 'Note: Failed to generate Pull SQL. Check server logs.', 'error'))
   .finally(() => setLoading(btn, false));
}

function branchFinal() {
  normalizeInput(document.getElementById('bTenant'));
  const bJson1 = document.getElementById('bJson1');
  const bJson2 = document.getElementById('bJson2');
  if (!validateJSON([
    { el: bJson1, label: 'Source Branch & Product Snapshot' },
    { el: bJson2, label: 'Destination Branch & Product State' },
  ])) return;
  const btn = activeButton(); setLoading(btn, true, 'building migration sql · branch / product');

  fetch('/branch/final', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: document.getElementById('bTenant').value, source_json: bJson1.value, existing_json: bJson2.value }) })
  .then(r => r.json()).then(d => {
    const finalEl = document.getElementById('bFinal');
    finalEl.value = d.result;
    finalEl.dispatchEvent(new Event('input', { bubbles: true }));
    if (d.notes && d.notes.length) showNotesModal(d.notes);
    const hasSQL = d.result && d.result.trim();
    showToast(
      hasSQL ? 'Final SQL Generated' : 'No Changes Detected',
      hasSQL ? 'Note: Review all statements before executing on Destination DB.'
             : 'Note: Source and Destination configurations are identical.',
      hasSQL ? 'success' : 'info'
    );
  }).catch(() => showToast('Server Error', 'Note: Failed to generate Final SQL. Check server logs.', 'error'))
   .finally(() => setLoading(btn, false));
}

/* ── Table view (Source Branch & Product Snapshot) ─────────
 * Rows from the Source DB pull are nested:
 *   { product_configurations, module_configurations,
 *     transaction_type_configuration, branch_configuration }
 * We project read-only scalar columns (Branch / Product / Module /
 * Transaction Type) for filter/sort, and keep the four nested objects
 * as editable JSON cells. On apply, only the four object columns are
 * persisted back (scalars are flat projections; they are not
 * round-tripped to the DB). */
const BRANCH_TABLE_COLUMNS = [
  { key: 'branch_code',                label: 'Branch',          width: 90,  editable: false },
  { key: 'branch_name',                label: 'Branch Name',     width: 160, editable: false },
  { key: 'product_code',               label: 'Product',         width: 110, editable: false },
  { key: 'product_name',               label: 'Product Name',    width: 160, editable: false },
  { key: 'product_tag',                label: 'Product Tag',     width: 110, editable: false },
  { key: 'module_code',                label: 'Module',          width: 100, editable: false },
  { key: 'module_name',                label: 'Module Name',     width: 140, editable: false },
  { key: 'transaction_type_code',      label: 'Txn Type',        width: 110, editable: false },
  { key: 'transaction_type_name',      label: 'Txn Type Name',   width: 160, editable: false },
  { key: 'product_configurations',         label: 'Product (JSON)',     width: 220 },
  { key: 'module_configurations',          label: 'Module (JSON)',      width: 200 },
  { key: 'transaction_type_configuration', label: 'Txn Type (JSON)',    width: 220 },
  { key: 'branch_configuration',           label: 'Branch (JSON)',      width: 200 },
];

const BRANCH_TABLE_DEFAULT_SORT = [
  { col: 'branch_code',  dir: 1 },
  { col: 'product_code', dir: 1 },
  { col: 'module_code',  dir: 1 },
];

const pick = (o, k) => (o && typeof o === 'object' && o[k] != null) ? o[k] : '';

function flattenBranchRow(row) {
  const p = row?.product_configurations || {};
  const m = row?.module_configurations  || {};
  const t = row?.transaction_type_configuration || null;
  const b = row?.branch_configuration   || {};
  return {
    branch_code:                     pick(b, 'code'),
    branch_name:                     pick(b, 'name'),
    product_code:                    pick(p, 'code'),
    product_name:                    pick(p, 'name'),
    product_tag:                     pick(p, 'tag'),
    module_code:                     pick(m, 'code'),
    module_name:                     pick(m, 'name'),
    transaction_type_code:           t ? pick(t, 'code') : '',
    transaction_type_name:           t ? pick(t, 'name') : '',
    product_configurations:          row?.product_configurations          ?? {},
    module_configurations:           row?.module_configurations           ?? {},
    transaction_type_configuration:  row?.transaction_type_configuration  ?? null,
    branch_configuration:            row?.branch_configuration            ?? {},
  };
}

function unflattenBranchRow(flat) {
  return {
    product_configurations:         flat?.product_configurations         ?? {},
    module_configurations:          flat?.module_configurations          ?? {},
    transaction_type_configuration: flat?.transaction_type_configuration ?? null,
    branch_configuration:           flat?.branch_configuration           ?? {},
  };
}

function openBranchTable(textarea) {
  if (!textarea || !textarea.value.trim()) {
    return showToast('Nothing to View', 'Note: Paste or upload the Source Branch & Product Snapshot first.', 'warning');
  }

  let result;
  try { result = extractJsonArray(textarea.value); }
  catch (e) {
    return showToast('Invalid JSON',
      'Note: Could not parse Source Branch & Product Snapshot — ' + e.message, 'error');
  }
  const rows = result.rows;

  if (result.unwrapped || result.fixes.length) {
    textarea.value = JSON.stringify(rows, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const note = result.unwrapped
      ? `Unwrapped to ${rows.length} row${rows.length === 1 ? '' : 's'}.`
      : `Cleaned (${result.fixes.join(', ')}).`;
    showToast('JSON Normalized', 'Note: ' + note, 'info');
  }

  const flatRows = rows.map(flattenBranchRow);

  openTableModal({
    title:       'Source Branch & Product — Table View',
    filename:    'branch_product',
    filenamePrefix: () => {
      const v = (document.getElementById('bTenant')?.value || '').trim();
      return v ? v.replace(/[^A-Za-z0-9_.-]+/g, '_') : '';
    },
    columns:     BRANCH_TABLE_COLUMNS,
    defaultSort: BRANCH_TABLE_DEFAULT_SORT,
    rows:        flatRows,
    onApply:     (modifiedRows) => {
      const t = document.getElementById('bJson1');
      if (!t) return;
      const nested = modifiedRows.map(unflattenBranchRow);
      t.value = JSON.stringify(nested, null, 2);
      t.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('Source Updated',
        `Note: ${nested.length} row${nested.length === 1 ? '' : 's'} written back. Click Generate Final SQL to process.`,
        'success');
    },
  });
}

registerJsonGroupAction('bJson1', {
  cls:   'json-table-btn',
  icon:  ICONS.table,
  label: 'Table View',
  title: 'Open as filterable table',
  onClick: openBranchTable,
});

exposeGlobals({ branchPull, branchFinal });

export const branchTab = {
  key: 'branch',
  statusKey: 'BRANCH',
  endpoints: { src: 'DB', dst: 'DB' },
  render,
  syncStepper({ setState, gateFields }) {
    const pull  = document.getElementById('bPullResult');
    const final = document.getElementById('bFinal');
    const hasPull  = !!(pull && pull.children.length > 0);
    const hasFinal = !!(final && final.value && final.value.trim());
    setState('branch', {
      configure: hasPull ? 'done' : 'active',
      emit:      hasFinal ? 'done' : (hasPull ? 'done' : 'pending'),
      run:       hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      paste:     hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      final:     hasFinal ? 'active' : 'pending',
    });
    gateFields({ pullId: 'bPullResult', jsonIds: ['bJson1', 'bJson2'], submitFn: 'branchFinal', hasPull });
  },
};
