/* ============================================================
 *  tabs/branch.js — Branch Sync (branch_product migrations).
 * ============================================================ */

import { ICONS, exposeGlobals } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { showNotesModal } from '../lib/modal.js';
import { setLoading, activeButton } from '../lib/feedback.js';
import { validateFields, validateJSON, normalizeInput, registerInputs } from '../lib/data.js';
import { flowRibbon, sectionHeader, offlineCallout, outputCard, finalSqlBox, jsonGroup, renderPullResult } from '../components/sections.js';
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
