/* ============================================================
 *  tabs/mq.js — MQ Comparison (RabbitMQ broker definitions diff).
 *  Differs from the other tabs: no pull/final flow, just diff +
 *  rich rendering of the comparison result + Export Report toolbar.
 * ============================================================ */

import { ICONS, exposeGlobals, escapeHtml } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { setLoading, activeButton } from '../lib/feedback.js';
import { validateJSON, downloadBlob } from '../lib/data.js';
import { flowRibbon, sectionHeader, outputCard, jsonGroup } from '../components/sections.js';

const FLOW = [
  { key: 'paste',  glyph: '⇋', label: 'Paste Source' },
  { key: 'paste2', glyph: '⇋', label: 'Paste Destination' },
  { key: 'run',    glyph: '⚙', label: 'Run Diff' },
  { key: 'review', glyph: '▣', label: 'Review Output' },
];

function render(host) {
  host.innerHTML = `
${flowRibbon('mq', FLOW)}

${sectionHeader(1, 'Paste MQ Definition Exports',
  'Drop the RabbitMQ <code class="inline-code">definitions.json</code> export from each broker. The console identifies missing queues, exchanges and bindings.')}

<div class="json-grid">
  ${jsonGroup({ id: 'mqSourceJson',      label: 'Source Broker Definitions',      side: 'source',
    placeholder: 'Paste the RabbitMQ definitions.json export from the Source broker…' })}
  ${jsonGroup({ id: 'mqDestinationJson', label: 'Destination Broker Definitions', side: 'dest',
    placeholder: 'Paste the RabbitMQ definitions.json export from the Destination broker…' })}
</div>
<div class="btn-row">
  <button class="primary" onclick="mqCompare()">${ICONS.finish} Compare MQ JSON</button>
</div>

${outputCard('Comparison Output', 'Queues are grouped with their related exchange details and queue bindings.',
  '<div id="mqResult" class="mq-result-empty">Run a comparison to view MQ differences.</div>')}`;
  // MQ uses plain textareas, not .json-group inputs registered for normalization.
}

function mqCompare() {
  const sourceJson = document.getElementById('mqSourceJson');
  const destinationJson = document.getElementById('mqDestinationJson');
  if (!validateJSON([
    { el: sourceJson, label: 'Source Broker Definitions' },
    { el: destinationJson, label: 'Destination Broker Definitions' },
  ])) return;
  const btn = activeButton(); setLoading(btn, true, 'diffing broker definitions · mq');

  fetch('/mq/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_json: sourceJson.value, destination_json: destinationJson.value }) })
  .then(r => r.json()).then(data => {
    window.__lastMqComparison = data;
    renderMqComparison(data);
    const missing = data.summary?.missing_in_destination || {};
    const missingCount = (missing.queues || 0) + (missing.exchanges || 0) + (missing.bindings || 0);
    showToast(
      missingCount ? 'MQ Differences Found' : 'No Source Gaps',
      missingCount ? `Note: ${missingCount} source item${missingCount > 1 ? 's are' : ' is'} missing in Destination.`
                   : 'Note: Destination has all Source queues, exchanges and bindings.',
      missingCount ? 'warning' : 'success'
    );
  }).catch(() => showToast('Server Error', 'Note: Failed to compare MQ JSON. Check server logs.', 'error'))
   .finally(() => setLoading(btn, false));
}

/* ── Render helpers (preserved from original; presentation-only) ── */
function mqText(v) {
  if (v === undefined || v === null || v === '') return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function mqValue(v) { return escapeHtml(mqText(v)); }
function mqCode(v)  { return `<code class="mq-code">${mqValue(v)}</code>`; }
function mqCopy(v, label, extraClass = '') {
  const text = mqText(v);
  return `<button type="button" class="mq-copy ${extraClass}"
    data-copy="${escapeHtml(text)}" data-copy-label="${escapeHtml(label)}"
    onclick="copyMqText(this, event)" aria-label="Copy ${escapeHtml(label)}">${mqValue(v)}</button>`;
}
function mqCopyCode(v, label) { return mqCopy(v, label, 'mq-code'); }
function mqQueueKey(vhost, name) { return `${vhost || '/'}::${name || ''}`; }

function copyMqText(el, event) {
  if (event) { event.preventDefault(); event.stopPropagation(); }
  const text = el.dataset.copy || '';
  const label = el.dataset.copyLabel || 'Value';
  if (!text || text === '-') return showToast('Nothing to Copy', `No ${label.toLowerCase()} available.`, 'warning');
  const done = () => {
    el.classList.add('copied');
    clearTimeout(el._copiedTimer);
    el._copiedTimer = setTimeout(() => el.classList.remove('copied'), 1100);
    showToast('Copied!', `${label} copied to clipboard.`, 'success');
  };
  const fallback = () => {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    done();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
  else fallback();
}

function renderMqActions() {
  return `
    <div class="mq-actions">
      <span class="mq-actions-label">Export Report</span>
      <div class="mq-actions-row">
        <button type="button" class="mq-action" onclick="copyMqReport('text')">${ICONS.copy} Copy as Text</button>
        <button type="button" class="mq-action" onclick="copyMqReport('json')">${ICONS.copy} Copy as JSON</button>
        <button type="button" class="mq-action" onclick="downloadMqReport('text')">${ICONS.download} Download .txt</button>
        <button type="button" class="mq-action" onclick="downloadMqReport('json')">${ICONS.download} Download .json</button>
      </div>
    </div>`;
}

function buildMqTextReport(data) {
  const lines = [];
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  MQ COMPARISON REPORT');
  lines.push('  Generated: ' + new Date().toISOString());
  lines.push('═══════════════════════════════════════════════════════════════', '');
  const s = data.summary || {};
  const counts = (label, c) => { c = c || {}; lines.push(`  ${label.padEnd(28)}  queues=${c.queues || 0}  exchanges=${c.exchanges || 0}  bindings=${c.bindings || 0}`); };
  lines.push('SUMMARY', '---------------------------------------------------------------');
  counts('Source export',          s.source);
  counts('Destination export',     s.destination);
  counts('Missing in Destination', s.missing_in_destination);
  counts('Only in Destination',    s.only_in_destination);
  lines.push('');
  if (!data.has_differences) { lines.push('RESULT  ✓  Source and Destination definitions are identical.'); return lines.join('\n'); }
  const block = (title, grp) => {
    lines.push(title, '---------------------------------------------------------------');
    const queues = (grp || {}).queues || []; const exchanges = (grp || {}).exchanges || []; const bindings = (grp || {}).bindings || [];
    if (!queues.length && !exchanges.length && !bindings.length) { lines.push('  (none)', ''); return; }
    if (queues.length) { lines.push('  · Queues (' + queues.length + ')');
      queues.forEach(r => { const q = r.queue || {};
        lines.push(`      - ${q.vhost || '/'}::${q.name || '?'}  durable=${q.durable}  auto_delete=${q.auto_delete}`);
        (r.bindings || []).forEach(b => lines.push(`          binding: ${b.source || '?'} -[${b.routing_key || ''}]-> ${b.destination || '?'}`));
      }); }
    if (exchanges.length) { lines.push('  · Exchanges (' + exchanges.length + ')'); exchanges.forEach(e => lines.push(`      - ${e.vhost || '/'}::${e.name || '?'} (${e.type || '-'})  durable=${e.durable}`)); }
    if (bindings.length)  { lines.push('  · Standalone Bindings (' + bindings.length + ')'); bindings.forEach(b => lines.push(`      - ${b.vhost || '/'}: ${b.source || '?'} -[${b.routing_key || ''}]-> ${b.destination || '?'}`)); }
    lines.push('');
  };
  block('SOURCE ITEMS MISSING IN DESTINATION', data.missing_in_destination);
  block('DESTINATION-ONLY ITEMS',              data.only_in_destination);
  return lines.join('\n');
}

function copyMqReport(format) {
  const data = window.__lastMqComparison;
  if (!data) return showToast('Nothing to Copy', 'Note: Run a comparison first.', 'warning');
  const text = format === 'json' ? JSON.stringify(data, null, 2) : buildMqTextReport(data);
  navigator.clipboard.writeText(text).then(
    () => showToast('Copied!', `Comparison report copied as ${format === 'json' ? 'JSON' : 'text'}.`, 'success'),
    () => showToast('Copy Failed', 'Note: Clipboard access denied.', 'error')
  );
}
function downloadMqReport(format) {
  const data = window.__lastMqComparison;
  if (!data) return showToast('Nothing to Download', 'Note: Run a comparison first.', 'warning');
  const isJson = format === 'json';
  const text = isJson ? JSON.stringify(data, null, 2) : buildMqTextReport(data);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(text, `mq-comparison-${ts}.${isJson ? 'json' : 'txt'}`,
    isJson ? 'application/json' : 'text/plain;charset=utf-8');
  showToast('Downloaded!', 'Report file saved.', 'success');
}

function renderMqCountCard(label, counts, tone) {
  return `<div class="mq-count-card ${tone || ''}">
    <div class="mq-count-label">${escapeHtml(label)}</div>
    <div class="mq-count-row"><span>Queues</span><strong>${counts.queues || 0}</strong></div>
    <div class="mq-count-row"><span>Exchanges</span><strong>${counts.exchanges || 0}</strong></div>
    <div class="mq-count-row"><span>Bindings</span><strong>${counts.bindings || 0}</strong></div>
  </div>`;
}
function renderMqSummary(summary) {
  return `<div class="mq-summary-grid">
    ${renderMqCountCard('Source Export', summary.source || {}, 'source')}
    ${renderMqCountCard('Destination Export', summary.destination || {}, 'dest')}
    ${renderMqCountCard('Missing in Destination', summary.missing_in_destination || {}, 'warning')}
    ${renderMqCountCard('Only in Destination', summary.only_in_destination || {}, 'muted')}
  </div>`;
}
function renderMqExchangeChips(exchanges) {
  if (!exchanges || !exchanges.length) return `<span class="mq-empty-line">No exchange definition found for these bindings.</span>`;
  return exchanges.map(e => `<span class="mq-chip">${mqCopy(e.name, 'Exchange name', 'mq-chip-name')}<small>${mqValue(e.type)}</small></span>`).join('');
}
function renderMqBindingTable(bindings) {
  if (!bindings || !bindings.length) return `<div class="mq-empty-line">No queue bindings found.</div>`;
  const rows = bindings.map(b => `<tr>
    <td>${mqCopyCode(b.source, 'Exchange name')}</td>
    <td>${mqCopyCode(b.routing_key, 'Routing key')}</td>
    <td>${mqCopyCode(b.destination, 'Queue name')}</td>
    <td>${mqCode(b.arguments)}</td>
  </tr>`).join('');
  return `<div class="mq-table-wrap"><table class="mq-table">
    <thead><tr><th>Exchange</th><th>Routing Key</th><th>Queue</th><th>Arguments</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function renderMqQueueReports(title, reports, emptyText) {
  if (!reports || !reports.length) return `<details class="mq-panel"><summary class="mq-panel-header"><h4>${escapeHtml(title)}</h4><span>0</span></summary><div class="mq-empty-line">${escapeHtml(emptyText || 'No queues found.')}</div></details>`;
  const items = reports.map(report => {
    const q = report.queue || {};
    return `<article class="mq-queue-item">
      <div class="mq-queue-head">
        <div>${mqCopy(q.name, 'Queue name', 'mq-queue-name')}<div class="mq-queue-vhost">vhost ${mqValue(q.vhost || '/')}</div></div>
        <div class="mq-queue-flags"><span>durable: ${mqValue(q.durable)}</span><span>auto delete: ${mqValue(q.auto_delete)}</span></div>
      </div>
      <dl class="mq-definition-list">
        <div><dt>Queue Arguments</dt><dd>${mqCode(q.arguments)}</dd></div>
        <div><dt>Exchange</dt><dd><div class="mq-chip-row">${renderMqExchangeChips(report.exchanges || [])}</div></dd></div>
      </dl>
      <div class="mq-subtitle">Bindings</div>
      ${renderMqBindingTable(report.bindings || [])}
    </article>`;
  }).join('');
  return `<details class="mq-panel"><summary class="mq-panel-header"><h4>${escapeHtml(title)}</h4><span>${reports.length}</span></summary><div class="mq-queue-list">${items}</div></details>`;
}
function renderMqResourceTable(title, resources, type, emptyText) {
  const count = resources ? resources.length : 0;
  if (!count) return `<details class="mq-panel"><summary class="mq-panel-header"><h4>${escapeHtml(title)}</h4><span>0</span></summary><div class="mq-empty-line">${escapeHtml(emptyText || 'No items found.')}</div></details>`;
  const rows = resources.map(r => type === 'binding'
    ? `<tr><td>${mqCode(r.vhost || '/')}</td><td>${mqCopyCode(r.source, 'Exchange name')}</td><td>${mqCopyCode(r.destination, 'Queue name')}</td><td>${mqCopyCode(r.routing_key, 'Routing key')}</td><td>${mqCode(r.arguments)}</td></tr>`
    : `<tr><td>${mqCode(r.vhost || '/')}</td><td>${mqCopyCode(r.name, 'Exchange name')}</td><td>${mqCode(r.type || '-')}</td><td>${mqCode(r.durable)}</td><td>${mqCode(r.arguments)}</td></tr>`).join('');
  const header = type === 'binding'
    ? `<tr><th>Vhost</th><th>Exchange</th><th>Queue</th><th>Routing Key</th><th>Arguments</th></tr>`
    : `<tr><th>Vhost</th><th>Name</th><th>Type</th><th>Durable</th><th>Arguments</th></tr>`;
  return `<details class="mq-panel"><summary class="mq-panel-header"><h4>${escapeHtml(title)}</h4><span>${count}</span></summary><div class="mq-table-wrap"><table class="mq-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div></details>`;
}
function filterBindingsOutsideQueues(bindings, queueReports) {
  const keys = new Set((queueReports || []).map(r => { const q = r.queue || {}; return mqQueueKey(q.vhost, q.name); }));
  return (bindings || []).filter(b => !keys.has(mqQueueKey(b.vhost, b.destination)));
}
function renderMqComparisonGroup(title, group, opts = {}) {
  const queues = group.queues || [];
  const standalone = filterBindingsOutsideQueues(group.bindings || [], queues);
  return `<div class="mq-group">
    <div class="mq-group-header"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(opts.hint || '')}</p></div>
    ${renderMqQueueReports(opts.queueTitle || 'Queues', queues, opts.queueEmpty)}
    ${renderMqResourceTable(opts.exchangeTitle || 'Exchange Definitions', group.exchanges || [], 'exchange', opts.exchangeEmpty)}
    ${renderMqResourceTable(opts.bindingTitle || 'Standalone Binding Differences', standalone, 'binding', opts.bindingEmpty)}
  </div>`;
}

function renderMqComparison(data) {
  const result = document.getElementById('mqResult');
  const missing = data.missing_in_destination || {};
  const destinationOnly = data.only_in_destination || {};
  result.className = 'mq-result';
  let html = renderMqActions();
  html += renderMqSummary(data.summary || {});
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
  const hasDestOnly = (destinationOnly.queues || []).length || (destinationOnly.exchanges || []).length || (destinationOnly.bindings || []).length;
  if (hasDestOnly) {
    html += `<details class="mq-details"><summary>Review destination-only items</summary>
      ${renderMqComparisonGroup('Destination-only Items', destinationOnly, {
        hint: 'These exist in Destination but not in Source.',
        queueTitle: 'Queues Only in Destination', queueEmpty: 'No destination-only queues found.',
        exchangeTitle: 'Exchange Definitions Only in Destination', exchangeEmpty: 'No destination-only exchange definitions found.',
        bindingTitle: 'Bindings Only in Destination for Existing Queues', bindingEmpty: 'No standalone destination-only binding differences.',
      })}</details>`;
  }
  result.innerHTML = html;
}

exposeGlobals({ mqCompare, copyMqReport, downloadMqReport, copyMqText });

export const mqTab = {
  key: 'mq',
  statusKey: 'MQ_COMPARE',
  endpoints: { src: 'BROKER', dst: 'BROKER' },
  render,
  syncStepper({ setState }) {
    const src = document.getElementById('mqSourceJson');
    const dst = document.getElementById('mqDestinationJson');
    const out = document.getElementById('mqResult');
    const hasSrc = !!(src && src.value && src.value.trim());
    const hasDst = !!(dst && dst.value && dst.value.trim());
    const hasOut = !!(out && out.classList && !out.classList.contains('mq-result-empty'));
    setState('mq', {
      paste:  hasSrc ? 'done' : 'active',
      paste2: hasDst ? 'done' : (hasSrc ? 'active' : 'pending'),
      run:    hasOut ? 'done' : ((hasSrc && hasDst) ? 'active' : 'pending'),
      review: hasOut ? 'active' : 'pending',
    });
    const cmpBtn = document.querySelector('button.primary[onclick="mqCompare()"]');
    if (cmpBtn) cmpBtn.disabled = !(hasSrc && hasDst);
  },
};
