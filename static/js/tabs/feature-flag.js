/* ============================================================
 *  tabs/feature-flag.js — Feature Flag Sync.
 * ============================================================ */

import { ICONS, exposeGlobals } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { showNotesModal } from '../lib/modal.js';
import { setLoading, activeButton } from '../lib/feedback.js';
import { validateFields, validateJSON, normalizeInput, registerInputs } from '../lib/data.js';
import { flowRibbon, sectionHeader, offlineCallout, outputCard, finalSqlBox, jsonGroup, renderPullResult } from '../components/sections.js';

registerInputs({ plain: ['ffTenant'] });

const FLOW = [
  { key: 'configure', glyph: '◐', label: 'Configure' },
  { key: 'emit',      glyph: '⇆', label: 'Pull Queries' },
  { key: 'run',       glyph: '↗', label: 'Run on DBs', external: true },
  { key: 'paste',     glyph: '⇋', label: 'Paste JSON' },
  { key: 'final',     glyph: '▣', label: 'Migration SQL' },
];

function render(host) {
  host.innerHTML = `
${flowRibbon('feature', FLOW)}

${sectionHeader(1, 'Configure & Emit Pull Queries',
  'A tenant code is enough — the console emits both Source and Destination queries to capture the current feature-flag state.')}

<div class="form-row">
  <div class="form-group">
    <label>Tenant Code <span class="required">*</span></label>
    <input id="ffTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">Organization / tenant identifier</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="featureFlagPull()">${ICONS.generate} Generate Pull SQL</button>
</div>
<div id="ffPullResult"></div>

${offlineCallout('Run each query on the database it targets',
  'Copy the Source query to your Source DB tool, run it, save the JSON result. Repeat for the Destination query. Return below with both result-sets.')}

${sectionHeader(2, 'Paste Result-sets', 'Drop the JSON output of each pull query into the matching slot below.')}

<div class="json-grid">
  ${jsonGroup({ id: 'ffJson1', label: 'Source Feature Flags',      side: 'source' })}
  ${jsonGroup({ id: 'ffJson2', label: 'Destination Feature Flags', side: 'dest' })}
</div>
<div class="btn-row">
  <button class="primary" onclick="featureFlagFinal()">${ICONS.finish} Generate Final SQL</button>
</div>

${outputCard('Migration SQL', 'Generated migration. Review every statement before executing on Destination.', finalSqlBox('ffFinal'))}`;
}

function featureFlagPull() {
  const ffTenant = document.getElementById('ffTenant');
  normalizeInput(ffTenant);
  if (!validateFields([{ el: ffTenant, label: 'Tenant Code' }])) return;
  const btn = activeButton(); setLoading(btn, true, 'generating pull queries · feature flag');

  fetch('/feature-flag/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: ffTenant.value }) })
  .then(r => r.json()).then(data => {
    renderPullResult('ffPullResult', data);
    const hasSrc  = data.source_query && data.source_query.trim();
    const hasDest = data.destination_query && data.destination_query.trim();
    const parts = [hasSrc && 'Source DB', hasDest && 'Destination DB'].filter(Boolean);
    showToast('Pull SQL Generated',
      `Note: ${parts.join(' & ')} quer${parts.length > 1 ? 'ies' : 'y'} ready. Copy each and run on the respective database.`,
      'success');
  }).catch(() => showToast('Server Error', 'Note: Failed to generate Pull SQL. Check server logs.', 'error'))
   .finally(() => setLoading(btn, false));
}

function featureFlagFinal() {
  normalizeInput(document.getElementById('ffTenant'));
  const ffJson1 = document.getElementById('ffJson1');
  const ffJson2 = document.getElementById('ffJson2');
  if (!validateJSON([
    { el: ffJson1, label: 'Source Feature Flags' },
    { el: ffJson2, label: 'Destination Feature Flags' },
  ])) return;
  const btn = activeButton(); setLoading(btn, true, 'building migration sql · feature flag');

  fetch('/feature-flag/final', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: document.getElementById('ffTenant').value, source_json: ffJson1.value, existing_json: ffJson2.value }) })
  .then(r => r.json()).then(d => {
    const finalEl = document.getElementById('ffFinal');
    finalEl.value = d.result;
    finalEl.dispatchEvent(new Event('input', { bubbles: true }));
    if (d.notes && d.notes.length) showNotesModal(d.notes);
    const hasSQL = d.result && d.result.trim();
    showToast(
      hasSQL ? 'Final SQL Generated' : 'No Changes Detected',
      hasSQL ? 'Note: Review all statements before executing on Destination DB.'
             : 'Note: Source and Destination configurations are identical — no SQL generated.',
      hasSQL ? 'success' : 'info'
    );
  }).catch(() => showToast('Server Error', 'Note: Failed to generate Final SQL. Check server logs.', 'error'))
   .finally(() => setLoading(btn, false));
}

exposeGlobals({ featureFlagPull, featureFlagFinal });

export const featureFlagTab = {
  key: 'feature',
  statusKey: 'FEATURE_FLAG',
  endpoints: { src: 'DB', dst: 'DB' },
  render,
  syncStepper({ setState, gateFields }) {
    const pull  = document.getElementById('ffPullResult');
    const final = document.getElementById('ffFinal');
    const hasPull  = !!(pull && pull.children.length > 0);
    const hasFinal = !!(final && final.value && final.value.trim());
    setState('feature', {
      configure: hasPull ? 'done' : 'active',
      emit:      hasFinal ? 'done' : (hasPull ? 'done' : 'pending'),
      run:       hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      paste:     hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      final:     hasFinal ? 'active' : 'pending',
    });
    gateFields({ pullId: 'ffPullResult', jsonIds: ['ffJson1', 'ffJson2'], submitFn: 'featureFlagFinal', hasPull });
  },
};
