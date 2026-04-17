/* ═══════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════ */

/* ── Toast ──────────────────────────────────────────────────────── */
const ICONS = {
  success: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
  error:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  warning: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
  info:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
};

function showToast(title, msg, type) {
  const t = document.getElementById("toast");
  const msgHtml = msg ? `<div class="toast-msg">${msg}</div>` : '';
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.innerHTML = `<div class="toast-inner"><div class="toast-icon">${ICONS[type]||ICONS.info}</div><div class="toast-text"><div class="toast-title">${title}</div>${msgHtml}</div></div>`;
  t.className = "toast " + type;
  t.style.display = "block";
  clearTimeout(t._t);
  t._t = setTimeout(() => t.style.display = "none", 4800);
}

/* ── Modal ──────────────────────────────────────────────────────── */
function showModal(notes) {
  const ul = notes.map(n => `<li>${n.replace(/^Note:\s*/i, '')}</li>`).join('');
  document.getElementById('noteContent').innerHTML = `<ul>${ul}</ul>`;
  document.getElementById('noteModal').classList.remove('hidden');
}
function closeModal() { document.getElementById('noteModal').classList.add('hidden'); }

let workflowGroupRemapResolver = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function getWorkflowGroupCandidates(rows) {
  const groups = new Set();
  rows.forEach(row => {
    const fromGroup = typeof row?.from_group === 'string' ? row.from_group.trim() : '';
    if (fromGroup) groups.add(fromGroup);

    const toGroups = Array.isArray(row?.to_groups) ? row.to_groups : [];
    toGroups.forEach(group => {
      if (typeof group !== 'string') return;
      const normalized = group.trim();
      if (normalized) groups.add(normalized);
    });
  });
  return Array.from(groups).sort((a, b) => a.localeCompare(b));
}

function applyWorkflowGroupRemap(rows, remap) {
  return rows.map(row => ({
    ...row,
    from_group: typeof row?.from_group === 'string' && row.from_group.trim()
      ? remap[row.from_group.trim()]
      : row.from_group,
    to_groups: Array.isArray(row?.to_groups)
      ? row.to_groups.map(group => {
          if (typeof group !== 'string') return group;
          const normalized = group.trim();
          return normalized ? remap[normalized] : group;
        })
      : row.to_groups,
  }));
}

function openWorkflowGroupRemapModal(groups) {
  const modal = document.getElementById('workflowRemapModal');
  const content = document.getElementById('workflowRemapContent');
  content.innerHTML = groups.map(group => `
    <div class="workflow-remap-row">
      <div class="workflow-remap-source">
        <span class="workflow-remap-label">Current Group</span>
        <div class="workflow-remap-value">${escapeHtml(group)}</div>
      </div>
      <div class="workflow-remap-input">
        <label class="workflow-remap-label" for="workflow-remap-${escapeHtml(group)}">New Group Name</label>
        <input
          id="workflow-remap-${escapeHtml(group)}"
          class="workflow-remap-field"
          data-group="${escapeHtml(group)}"
          placeholder="Enter replacement group name"
        >
        <span class="workflow-remap-error hidden">Replacement value is required.</span>
      </div>
    </div>
  `).join('');
  modal.classList.remove('hidden');

  const firstInput = content.querySelector('input');
  if (firstInput) firstInput.focus();

  return new Promise(resolve => {
    workflowGroupRemapResolver = resolve;
  });
}

function closeWorkflowGroupRemap(result) {
  const modal = document.getElementById('workflowRemapModal');
  modal.classList.add('hidden');
  document.getElementById('workflowRemapContent').innerHTML = '';
  if (workflowGroupRemapResolver) {
    workflowGroupRemapResolver(result);
    workflowGroupRemapResolver = null;
  }
}

function cancelWorkflowGroupRemap() {
  closeWorkflowGroupRemap(null);
}

function submitWorkflowGroupRemap() {
  const fields = Array.from(document.querySelectorAll('#workflowRemapContent .workflow-remap-field'));
  const remap = {};
  let hasErrors = false;

  fields.forEach(field => {
    const value = field.value.trim();
    const error = field.parentElement.querySelector('.workflow-remap-error');
    if (!value) {
      field.classList.add('error');
      error.classList.remove('hidden');
      hasErrors = true;
      return;
    }
    field.classList.remove('error');
    error.classList.add('hidden');
    remap[field.dataset.group] = value;
  });

  if (hasErrors) {
    showToast("Validation Error", "Note: Group remapping is mandatory for all listed values.", "error");
    return;
  }

  closeWorkflowGroupRemap(remap);
}

/* ── Copy / Download ────────────────────────────────────────────── */
function copyText(id) {
  const el = document.getElementById(id);
  if (!el || !el.value.trim()) return showToast("Nothing to Copy", "No SQL has been generated yet.", "warning");
  navigator.clipboard.writeText(el.value);
  showToast("Copied!", "SQL copied to clipboard.", "success");
}

function downloadSQL(id) {
  const el = document.getElementById(id);
  if (!el || !el.value.trim()) return showToast("Nothing to Download", "No SQL has been generated yet.", "warning");
  fetch("/download", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({sql: el.value}) })
    .then(r => r.blob()).then(blob => {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "generated.sql" });
      a.click();
      showToast("Downloaded!", "SQL file saved.", "success");
    });
}

/* ── Validation ─────────────────────────────────────────────────── */
function validateFields(fields) {
  let ok = true; const missing = [];
  fields.forEach(({el, label}) => {
    if (!el.value.trim()) { el.classList.add('error'); missing.push(label); ok = false; }
    else el.classList.remove('error');
  });
  if (!ok) showToast("Validation Error", `Note: Required — ${missing.join(', ')}.`, "error");
  return ok;
}

function validateJSON(fields) {
  const bad = [];
  fields.forEach(({el, label}) => {
    if (!el.value.trim()) { el.classList.add('error'); bad.push(label); return; }
    try { JSON.parse(el.value); el.classList.remove('error'); }
    catch(e) { el.classList.add('error'); bad.push(label); }
  });
  if (bad.length) { showToast("Invalid JSON", `Note: Fix JSON in — ${bad.join(', ')}.`, "error"); return false; }
  return true;
}

/* ── SVG Builders ───────────────────────────────────────────────── */
const COPY_SVG = id => `<svg onclick="copyText('${id}')" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Copy"><rect x="9" y="9" width="13" height="13" rx="2" stroke-width="1.5"/><rect x="2" y="2" width="13" height="13" rx="2" stroke-width="1.5"/></svg>`;
const DL_SVG   = id => `<svg onclick="downloadSQL('${id}')" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Download"><path stroke-width="1.5" d="M12 3v12m0 0l-4-4m4 4l4-4"/><path stroke-width="1.5" d="M5 21h14"/></svg>`;

/* ── Pull Result Renderer (shared by all 3 tabs) ────────────────── */
/**
 * Render Source/Destination query boxes into a container element.
 * data = { source_query: string, destination_query: string }
 * Boxes that are empty are omitted entirely.
 */
function renderPullResult(containerId, data) {
  const hasSrc  = data.source_query && data.source_query.trim();
  const hasDest = data.destination_query && data.destination_query.trim();

  if (!hasSrc && !hasDest) {
    document.getElementById(containerId).innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:120px;
                  border:1.5px dashed var(--border);border-radius:var(--radius);
                  color:var(--text-muted);font-size:0.85rem;gap:8px;margin-top:14px;">
        No query was generated.
      </div>`;
    return;
  }

  const gridClass = (hasSrc && hasDest) ? 'pull-result-grid' : 'pull-result-grid single';

  let html = `<div class="${gridClass}">`;

  if (hasSrc) {
    html += `
    <div class="pull-result-box">
      <div class="query-section-label">
        <span class="db-pill source">Source DB</span> Run on Source Database
      </div>
      <div class="sql-wrapper">
        <div class="sql-icons">${COPY_SVG('srcQ_'+containerId)}${DL_SVG('srcQ_'+containerId)}</div>
        <textarea id="srcQ_${containerId}" readonly>${hasSrc}</textarea>
      </div>
    </div>`;
  }

  if (hasDest) {
    html += `
    <div class="pull-result-box">
      <div class="query-section-label">
        <span class="db-pill dest">Destination DB</span> Run on Destination Database
      </div>
      <div class="sql-wrapper">
        <div class="sql-icons">${COPY_SVG('destQ_'+containerId)}${DL_SVG('destQ_'+containerId)}</div>
        <textarea id="destQ_${containerId}" readonly>${hasDest}</textarea>
      </div>
    </div>`;
  }

  html += `</div>`;
  document.getElementById(containerId).innerHTML = html;
}

/* ── Final SQL Box ──────────────────────────────────────────────── */
function finalSQLBox(id) {
  return `
  <div class="query-section-label" style="margin-top:14px;">
    <span class="db-pill dest">Destination DB</span> Execute on Destination Database
  </div>
  <div class="sql-wrapper">
    <div class="sql-icons">${COPY_SVG(id)}${DL_SVG(id)}</div>
    <textarea id="${id}" readonly placeholder="Generated migration SQL will appear here…"></textarea>
  </div>`;
}

/* ── Generate / Run icons ───────────────────────────────────────── */
const GEN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>`;
const FIN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>`;

/* ── Tab Switcher ───────────────────────────────────────────────── */
function switchTab(t) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  if (t === 'branch') loadBranch();
  else if (t === 'workflow') loadWorkflow();
  else if (t === 'feature') loadFeatureFlag();
  else if (t === 'mq') loadMqComparison();
}

/* ═══════════════════════════════════════════════════════════════════
   BRANCH SYNC
═══════════════════════════════════════════════════════════════════ */
function loadBranch() {
  document.getElementById('content').innerHTML = `
<div class="section-header"><div class="section-badge">1</div><h3>Pull Data SQL</h3></div>
<p class="section-hint">Generates Source &amp; Destination queries to extract current branch/product configuration.</p>

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
  <button class="primary" onclick="branchPull()">${GEN_ICON} Generate Pull SQL</button>
</div>
<div id="bPullResult"></div>

<hr class="section-divider">

<div class="section-header"><div class="section-badge">2</div><h3>Generate Final SQL</h3></div>
<p class="section-hint">Paste JSON results from the Pull queries above, then generate the migration SQL.</p>

<div class="json-grid">
  <div class="json-group">
    <div class="json-label-row">
      <label>branch_product_backup.json <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="bJson1" placeholder="Paste JSON from Source DB query result…"></textarea>
  </div>
  <div class="json-group">
    <div class="json-label-row">
      <label>existing_config.json <span class="required">*</span></label>
      <span class="db-pill dest">DESTINATION</span>
    </div>
    <textarea id="bJson2" placeholder="Paste JSON from Destination DB query result…"></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="branchFinal()">${FIN_ICON} Generate Final SQL</button>
</div>
${finalSQLBox('bFinal')}`;
}

function branchPull() {
  const bTenant = document.getElementById('bTenant');
  const bBranches = document.getElementById('bBranches');
  const bProducts = document.getElementById('bProducts');
  if (!validateFields([
    {el: bTenant,   label: 'Tenant Code'},
    {el: bBranches, label: 'Branch Codes'},
    {el: bProducts, label: 'Product Codes'},
  ])) return;

  fetch("/branch/pull", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: bTenant.value, branches: bBranches.value, products: bProducts.value}) })
  .then(r => r.json()).then(data => {
    renderPullResult('bPullResult', data);
    const hasSrc  = data.source_query && data.source_query.trim();
    const hasDest = data.destination_query && data.destination_query.trim();
    const parts = [hasSrc && "Source DB", hasDest && "Destination DB"].filter(Boolean);
    showToast("Pull SQL Generated",
      `Note: ${parts.join(' & ')} quer${parts.length > 1 ? 'ies' : 'y'} ready. Run on the respective database${parts.length > 1 ? 's' : ''}.`,
      "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Pull SQL. Check server logs.", "error"));
}

function branchFinal() {
  const bJson1 = document.getElementById('bJson1');
  const bJson2 = document.getElementById('bJson2');
  if (!validateJSON([
    {el: bJson1, label: 'branch_product_backup.json'},
    {el: bJson2, label: 'existing_config.json'},
  ])) return;

  fetch("/branch/final", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: document.getElementById('bTenant').value, source_json: bJson1.value, existing_json: bJson2.value}) })
  .then(r => r.json()).then(d => {
    document.getElementById('bFinal').value = d.result;
    if (d.notes && d.notes.length) showModal(d.notes);
    const hasSQL = d.result && d.result.trim();
    showToast(
      hasSQL ? "Final SQL Generated" : "No Changes Detected",
      hasSQL ? "Note: Review all statements before executing on Destination DB."
             : "Note: Source and Destination configurations are identical.",
      hasSQL ? "success" : "info"
    );
  }).catch(() => showToast("Server Error", "Note: Failed to generate Final SQL. Check server logs.", "error"));
}

/* ═══════════════════════════════════════════════════════════════════
   WORKFLOW SYNC
═══════════════════════════════════════════════════════════════════ */
function loadWorkflow() {
  document.getElementById('content').innerHTML = `
<div class="section-header"><div class="section-badge">1</div><h3>Pull Data SQL</h3></div>
<p class="section-hint">Generates the Source DB query to extract current workflow configuration.</p>

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
  <button class="primary" onclick="workflowPull()">${GEN_ICON} Generate Pull SQL</button>
</div>
<div id="wPullResult"></div>

<hr class="section-divider">

<div class="section-header"><div class="section-badge">2</div><h3>Generate Final SQL</h3></div>
<p class="section-hint">Paste JSON from the Source DB Pull query result to generate migration SQL.</p>

<div class="json-grid single">
  <div class="json-group">
    <div class="json-label-row">
      <label>workflow_backup.json <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="wJson" placeholder="Paste JSON from Source DB query result…"></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="workflowFinal()">${FIN_ICON} Generate Final SQL</button>
</div>
${finalSQLBox('wFinal')}`;
}

function workflowPull() {
  const wTenant = document.getElementById('wTenant');
  if (!validateFields([{el: wTenant, label: 'Tenant Code'}])) return;

  fetch("/workflow/pull", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      tenant: wTenant.value,
      branches: document.getElementById('wBranches').value,
      products: document.getElementById('wProducts').value
    }) })
  .then(r => r.json()).then(data => {
    renderPullResult('wPullResult', data);
    const hasSrc = data.source_query && data.source_query.trim();
    showToast("Pull SQL Generated",
      `Note: ${hasSrc ? 'Source DB query ready. Run on Source DB.' : 'No query generated.'}`,
      "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Pull SQL. Check server logs.", "error"));
}

async function workflowFinal() {
  const wJson = document.getElementById('wJson');
  if (!validateJSON([{el: wJson, label: 'workflow_backup.json'}])) return;

  let rows;
  try {
    rows = JSON.parse(wJson.value);
  } catch (e) {
    showToast("Invalid JSON", "Note: Fix JSON in workflow_backup.json.", "error");
    return;
  }

  if (!Array.isArray(rows)) {
    showToast("Invalid JSON", "Note: workflow_backup.json must contain a JSON array.", "error");
    return;
  }

  const groups = getWorkflowGroupCandidates(rows);
  let payloadRows = rows;

  if (groups.length) {
    const remap = await openWorkflowGroupRemapModal(groups);
    if (!remap) {
      showToast("Cancelled", "Note: Final SQL generation was cancelled.", "info");
      return;
    }
    payloadRows = applyWorkflowGroupRemap(rows, remap);
  }

  fetch("/workflow/final", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      tenant: document.getElementById('wTenant').value,
      branches: document.getElementById('wBranches').value,
      source_json: JSON.stringify(payloadRows)
    }) })
  .then(r => r.json()).then(d => {
    document.getElementById('wFinal').value = d.result;
    showToast("Final SQL Generated", "Note: Review and execute on Destination DB.", "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Final SQL. Check server logs.", "error"));
}

/* ═══════════════════════════════════════════════════════════════════
   FEATURE FLAG SYNC
═══════════════════════════════════════════════════════════════════ */
function loadFeatureFlag() {
  document.getElementById('content').innerHTML = `
<div class="section-header"><div class="section-badge">1</div><h3>Pull Data SQL</h3></div>
<p class="section-hint">Generates both Source and Destination queries to extract feature flag configuration.</p>

<div class="form-row">
  <div class="form-group">
    <label>Tenant Code <span class="required">*</span></label>
    <input id="ffTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">Organization / tenant identifier</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="featureFlagPull()">${GEN_ICON} Generate Pull SQL</button>
</div>
<div id="ffPullResult"></div>

<hr class="section-divider">

<div class="section-header"><div class="section-badge">2</div><h3>Generate Final SQL</h3></div>
<p class="section-hint">Paste JSON results from the Pull queries above to generate the migration SQL.</p>

<div class="json-grid">
  <div class="json-group">
    <div class="json-label-row">
      <label>feature_flag_backup.json <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="ffJson1" placeholder="Paste JSON from Source DB query result…"></textarea>
  </div>
  <div class="json-group">
    <div class="json-label-row">
      <label>feature_flag_existing_config.json <span class="required">*</span></label>
      <span class="db-pill dest">DESTINATION</span>
    </div>
    <textarea id="ffJson2" placeholder="Paste JSON from Destination DB query result…"></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="featureFlagFinal()">${FIN_ICON} Generate Final SQL</button>
</div>
${finalSQLBox('ffFinal')}`;
}

function featureFlagPull() {
  const ffTenant = document.getElementById('ffTenant');
  if (!validateFields([{el: ffTenant, label: 'Tenant Code'}])) return;

  fetch("/feature-flag/pull", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: ffTenant.value}) })
  .then(r => r.json()).then(data => {
    renderPullResult('ffPullResult', data);
    const hasSrc  = data.source_query && data.source_query.trim();
    const hasDest = data.destination_query && data.destination_query.trim();
    const parts = [hasSrc && "Source DB", hasDest && "Destination DB"].filter(Boolean);
    showToast("Pull SQL Generated",
      `Note: ${parts.join(' & ')} quer${parts.length > 1 ? 'ies' : 'y'} ready. Copy each and run on the respective database.`,
      "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Pull SQL. Check server logs.", "error"));
}

function featureFlagFinal() {
  const ffJson1 = document.getElementById('ffJson1');
  const ffJson2 = document.getElementById('ffJson2');
  if (!validateJSON([
    {el: ffJson1, label: 'feature_flag_backup.json (Source)'},
    {el: ffJson2, label: 'feature_flag_existing_config.json (Destination)'},
  ])) return;

  fetch("/feature-flag/final", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: document.getElementById('ffTenant').value, source_json: ffJson1.value, existing_json: ffJson2.value}) })
  .then(r => r.json()).then(d => {
    document.getElementById('ffFinal').value = d.result;
    if (d.notes && d.notes.length) showModal(d.notes);
    const hasSQL = d.result && d.result.trim();
    showToast(
      hasSQL ? "Final SQL Generated" : "No Changes Detected",
      hasSQL ? "Note: Review all statements before executing on Destination DB."
             : "Note: Source and Destination configurations are identical — no SQL generated.",
      hasSQL ? "success" : "info"
    );
  }).catch(() => showToast("Server Error", "Note: Failed to generate Final SQL. Check server logs.", "error"));
}

/* ═══════════════════════════════════════════════════════════════════
   MQ COMPARISON
═══════════════════════════════════════════════════════════════════ */
function loadMqComparison() {
  document.getElementById('content').innerHTML = `
<div class="section-header"><div class="section-badge">1</div><h3>Compare MQ Definitions</h3></div>
<p class="section-hint">Paste RabbitMQ definition exports from Source and Destination to identify missing queues, exchanges and bindings.</p>

<div class="json-grid">
  <div class="json-group">
    <div class="json-label-row">
      <label>source_mq_definition.json <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="mqSourceJson" class="mq-json-input" placeholder="Paste Source RabbitMQ definition JSON export..."></textarea>
  </div>
  <div class="json-group">
    <div class="json-label-row">
      <label>destination_mq_definition.json <span class="required">*</span></label>
      <span class="db-pill dest">DESTINATION</span>
    </div>
    <textarea id="mqDestinationJson" class="mq-json-input" placeholder="Paste Destination RabbitMQ definition JSON export..."></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="mqCompare()">${FIN_ICON} Compare MQ JSON</button>
</div>

<hr class="section-divider">

<div class="section-header"><div class="section-badge">2</div><h3>Comparison Result</h3></div>
<p class="section-hint">Queues are grouped with their related exchange details and queue bindings.</p>
<div id="mqResult" class="mq-result-empty">Run a comparison to view MQ differences.</div>`;
}

function mqText(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function mqValue(value) {
  return escapeHtml(mqText(value));
}

function mqCode(value) {
  return `<code class="mq-code">${mqValue(value)}</code>`;
}

function mqCopy(value, label, extraClass = '') {
  const text = mqText(value);
  return `
    <button
      type="button"
      class="mq-copy ${extraClass}"
      data-copy="${escapeHtml(text)}"
      data-copy-label="${escapeHtml(label)}"
      onclick="copyMqText(this, event)"
      aria-label="Copy ${escapeHtml(label)}"
    >${mqValue(value)}</button>`;
}

function mqCopyCode(value, label) {
  return mqCopy(value, label, 'mq-code');
}

function copyMqText(el, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const text = el.dataset.copy || '';
  const label = el.dataset.copyLabel || 'Value';
  if (!text || text === '-') {
    showToast("Nothing to Copy", `No ${label.toLowerCase()} available.`, "warning");
    return;
  }

  const done = () => {
    el.classList.add('copied');
    clearTimeout(el._copiedTimer);
    el._copiedTimer = setTimeout(() => el.classList.remove('copied'), 1100);
    showToast("Copied!", `${label} copied to clipboard.`, "success");
  };
  const fallbackCopy = () => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    done();
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

function mqQueueKey(vhost, name) {
  return `${vhost || '/'}::${name || ''}`;
}

function renderMqCountCard(label, counts, tone) {
  return `
    <div class="mq-count-card ${tone || ''}">
      <div class="mq-count-label">${escapeHtml(label)}</div>
      <div class="mq-count-row"><span>Queues</span><strong>${counts.queues || 0}</strong></div>
      <div class="mq-count-row"><span>Exchanges</span><strong>${counts.exchanges || 0}</strong></div>
      <div class="mq-count-row"><span>Bindings</span><strong>${counts.bindings || 0}</strong></div>
    </div>`;
}

function renderMqSummary(summary) {
  return `
    <div class="mq-summary-grid">
      ${renderMqCountCard('Source Export', summary.source || {}, 'source')}
      ${renderMqCountCard('Destination Export', summary.destination || {}, 'dest')}
      ${renderMqCountCard('Missing in Destination', summary.missing_in_destination || {}, 'warning')}
      ${renderMqCountCard('Only in Destination', summary.only_in_destination || {}, 'muted')}
    </div>`;
}

function renderMqExchangeChips(exchanges) {
  if (!exchanges || !exchanges.length) {
    return `<span class="mq-empty-line">No exchange definition found for these bindings.</span>`;
  }
  return exchanges.map(exchange => `
    <span class="mq-chip">
      ${mqCopy(exchange.name, 'Exchange name', 'mq-chip-name')}
      <small>${mqValue(exchange.type)}</small>
    </span>
  `).join('');
}

function renderMqBindingTable(bindings) {
  if (!bindings || !bindings.length) {
    return `<div class="mq-empty-line">No queue bindings found.</div>`;
  }
  const rows = bindings.map(binding => `
    <tr>
      <td>${mqCopyCode(binding.source, 'Exchange name')}</td>
      <td>${mqCopyCode(binding.routing_key, 'Routing key')}</td>
      <td>${mqCopyCode(binding.destination, 'Queue name')}</td>
      <td>${mqCode(binding.arguments)}</td>
    </tr>
  `).join('');
  return `
    <div class="mq-table-wrap">
      <table class="mq-table">
        <thead>
          <tr>
            <th>Exchange</th>
            <th>Routing Key</th>
            <th>Queue</th>
            <th>Arguments</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderMqQueueReports(title, reports, emptyText) {
  if (!reports || !reports.length) {
    return `
      <details class="mq-panel">
        <summary class="mq-panel-header">
          <h4>${escapeHtml(title)}</h4>
          <span>0</span>
        </summary>
        <div class="mq-empty-line">${escapeHtml(emptyText || 'No queues found.')}</div>
      </details>`;
  }

  const items = reports.map(report => {
    const queue = report.queue || {};
    return `
      <article class="mq-queue-item">
        <div class="mq-queue-head">
          <div>
            ${mqCopy(queue.name, 'Queue name', 'mq-queue-name')}
            <div class="mq-queue-vhost">vhost ${mqValue(queue.vhost || '/')}</div>
          </div>
          <div class="mq-queue-flags">
            <span>durable: ${mqValue(queue.durable)}</span>
            <span>auto delete: ${mqValue(queue.auto_delete)}</span>
          </div>
        </div>
        <dl class="mq-definition-list">
          <div>
            <dt>Queue Arguments</dt>
            <dd>${mqCode(queue.arguments)}</dd>
          </div>
          <div>
            <dt>Exchange</dt>
            <dd><div class="mq-chip-row">${renderMqExchangeChips(report.exchanges || [])}</div></dd>
          </div>
        </dl>
        <div class="mq-subtitle">Bindings</div>
        ${renderMqBindingTable(report.bindings || [])}
      </article>`;
  }).join('');

  return `
    <details class="mq-panel">
      <summary class="mq-panel-header">
        <h4>${escapeHtml(title)}</h4>
        <span>${reports.length}</span>
      </summary>
      <div class="mq-queue-list">${items}</div>
    </details>`;
}

function renderMqResourceTable(title, resources, type, emptyText) {
  const count = resources ? resources.length : 0;
  if (!count) {
    return `
      <details class="mq-panel">
        <summary class="mq-panel-header">
          <h4>${escapeHtml(title)}</h4>
          <span>0</span>
        </summary>
        <div class="mq-empty-line">${escapeHtml(emptyText || 'No items found.')}</div>
      </details>`;
  }

  const rows = resources.map(resource => {
    if (type === 'binding') {
      return `
        <tr>
          <td>${mqCode(resource.vhost || '/')}</td>
          <td>${mqCopyCode(resource.source, 'Exchange name')}</td>
          <td>${mqCopyCode(resource.destination, 'Queue name')}</td>
          <td>${mqCopyCode(resource.routing_key, 'Routing key')}</td>
          <td>${mqCode(resource.arguments)}</td>
        </tr>`;
    }
    return `
      <tr>
        <td>${mqCode(resource.vhost || '/')}</td>
        <td>${mqCopyCode(resource.name, 'Exchange name')}</td>
        <td>${mqCode(resource.type || '-')}</td>
        <td>${mqCode(resource.durable)}</td>
        <td>${mqCode(resource.arguments)}</td>
      </tr>`;
  }).join('');
  const header = type === 'binding'
    ? `<tr><th>Vhost</th><th>Exchange</th><th>Queue</th><th>Routing Key</th><th>Arguments</th></tr>`
    : `<tr><th>Vhost</th><th>Name</th><th>Type</th><th>Durable</th><th>Arguments</th></tr>`;
  return `
    <details class="mq-panel">
      <summary class="mq-panel-header">
        <h4>${escapeHtml(title)}</h4>
        <span>${count}</span>
      </summary>
      <div class="mq-table-wrap">
        <table class="mq-table">
          <thead>${header}</thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

function filterBindingsOutsideQueues(bindings, queueReports) {
  const queueKeys = new Set((queueReports || []).map(report => {
    const queue = report.queue || {};
    return mqQueueKey(queue.vhost, queue.name);
  }));
  return (bindings || []).filter(binding => !queueKeys.has(mqQueueKey(binding.vhost, binding.destination)));
}

function renderMqComparisonGroup(title, group, options = {}) {
  const queues = group.queues || [];
  const standaloneBindings = filterBindingsOutsideQueues(group.bindings || [], queues);
  return `
    <div class="mq-group">
      <div class="mq-group-header">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(options.hint || '')}</p>
      </div>
      ${renderMqQueueReports(options.queueTitle || 'Queues', queues, options.queueEmpty)}
      ${renderMqResourceTable(options.exchangeTitle || 'Exchange Definitions', group.exchanges || [], 'exchange', options.exchangeEmpty)}
      ${renderMqResourceTable(options.bindingTitle || 'Standalone Binding Differences', standaloneBindings, 'binding', options.bindingEmpty)}
    </div>`;
}

function renderMqComparison(data) {
  const result = document.getElementById('mqResult');
  const missing = data.missing_in_destination || {};
  const destinationOnly = data.only_in_destination || {};

  result.className = 'mq-result';
  let html = renderMqSummary(data.summary || {});

  if (!data.has_differences) {
    result.innerHTML = html + `<div class="mq-no-diff">Source and Destination MQ definitions are identical for queues, exchanges and bindings.</div>`;
    return;
  }

  html += renderMqComparisonGroup('Source Items Missing in Destination', missing, {
    hint: 'Create or align these items in Destination to match Source.',
    queueTitle: 'Queues with Exchange and Binding Details',
    queueEmpty: 'No source queues are missing in Destination.',
    exchangeTitle: 'Exchange Definitions Missing in Destination',
    exchangeEmpty: 'No exchange definitions are missing in Destination.',
    bindingTitle: 'Bindings Missing for Existing Queues',
    bindingEmpty: 'No standalone binding differences. Queue bindings are shown under each missing queue.',
  });

  const hasDestinationOnly = (destinationOnly.queues || []).length
    || (destinationOnly.exchanges || []).length
    || (destinationOnly.bindings || []).length;
  if (hasDestinationOnly) {
    html += `
      <details class="mq-details">
        <summary>Review destination-only items</summary>
        ${renderMqComparisonGroup('Destination-only Items', destinationOnly, {
          hint: 'These exist in Destination but not in Source.',
          queueTitle: 'Queues Only in Destination',
          queueEmpty: 'No destination-only queues found.',
          exchangeTitle: 'Exchange Definitions Only in Destination',
          exchangeEmpty: 'No destination-only exchange definitions found.',
          bindingTitle: 'Bindings Only in Destination for Existing Queues',
          bindingEmpty: 'No standalone destination-only binding differences.',
        })}
      </details>`;
  }

  result.innerHTML = html;
}

function mqCompare() {
  const sourceJson = document.getElementById('mqSourceJson');
  const destinationJson = document.getElementById('mqDestinationJson');
  if (!validateJSON([
    {el: sourceJson, label: 'source_mq_definition.json'},
    {el: destinationJson, label: 'destination_mq_definition.json'},
  ])) return;

  fetch("/mq/compare", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({source_json: sourceJson.value, destination_json: destinationJson.value}) })
  .then(r => r.json()).then(data => {
    renderMqComparison(data);
    const missing = data.summary?.missing_in_destination || {};
    const missingCount = (missing.queues || 0) + (missing.exchanges || 0) + (missing.bindings || 0);
    showToast(
      missingCount ? "MQ Differences Found" : "No Source Gaps",
      missingCount ? `Note: ${missingCount} source item${missingCount > 1 ? 's are' : ' is'} missing in Destination.`
                   : "Note: Destination has all Source queues, exchanges and bindings.",
      missingCount ? "warning" : "success"
    );
  }).catch(() => showToast("Server Error", "Note: Failed to compare MQ JSON. Check server logs.", "error"));
}

/* ── Init ───────────────────────────────────────────────────────── */
loadBranch();
