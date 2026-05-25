/* ============================================================
 *  sections.js — Pure HTML-string builders for the four reusable
 *  section primitives used by every tab.
 *
 *    flowRibbon(steps)           — top stepper
 *    sectionHeader(num, title)   — [01] CONFIGURE & EMIT …
 *    offlineCallout(title, body) — "External Operation" block
 *    outputCard(title, hint, inner)
 *    pullResultBox / finalSqlBox / pullResultEmpty
 *
 *  All return strings — no DOM is mutated here. Composable.
 * ============================================================ */

import { ICONS, escapeHtml } from '../lib/dom.js';

/* ── Flow ribbon ──────────────────────────────────────────── */
/**
 * @typedef {Object} FlowStep
 * @property {string} key       — unique step key (e.g. 'configure')
 * @property {string} glyph     — single-char glyph (◐ ⇆ ↗ ⇋ ▣ …)
 * @property {string} label     — display label
 * @property {boolean} [external] — render as "OFFLINE" external step
 */

/** @param {string} flowKey @param {FlowStep[]} steps */
export function flowRibbon(flowKey, steps) {
  const items = steps.map((s, i) => `
    <li class="flow-step${s.external ? ' is-external' : ''}" data-step="${s.key}" data-state="${i === 0 ? 'active' : 'pending'}">
      <span class="flow-step-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="flow-step-glyph" aria-hidden="true">${s.glyph}</span>
      <span class="flow-step-label">${s.label}</span>
      ${s.external ? '<span class="flow-step-meta">offline</span>' : ''}
    </li>
  `).join('<li class="flow-link" aria-hidden="true"></li>');
  return `
    <nav class="flow-ribbon" data-flow="${flowKey}" aria-label="${flowKey} sync flow">
      <ol class="flow-steps">${items}</ol>
    </nav>`;
}

/* ── Section header (numbered "[01] TITLE") ──────────────── */
export function sectionHeader(num, title, hint) {
  return `
    <div class="section-header"><div class="section-badge">${num}</div><h3>${title}</h3></div>
    ${hint ? `<p class="section-hint">${hint}</p>` : ''}`;
}

/* ── Offline-operation callout ───────────────────────────── */
export function offlineCallout(title, body) {
  return `
    <div class="offline-callout" role="note">
      <div class="offline-callout-rule" aria-hidden="true"></div>
      <div class="offline-callout-content">
        <span class="offline-callout-tag">
          <span class="offline-callout-icon" aria-hidden="true">↗</span>
          External Operation
        </span>
        <h4 class="offline-callout-title">${title}</h4>
        <p class="offline-callout-text">${body}</p>
      </div>
      <div class="offline-callout-rule" aria-hidden="true"></div>
    </div>`;
}

/* ── Output card ─────────────────────────────────────────── */
export function outputCard(title, hint, innerHTML) {
  return `
    <div class="output-card">
      <div class="output-card-head">
        <span class="output-card-tag">— Final Output —</span>
        <h4 class="output-card-title">${title}</h4>
        ${hint ? `<p class="output-card-hint">${hint}</p>` : ''}
      </div>
      <div class="output-card-body">${innerHTML}</div>
    </div>`;
}

/* ── SQL textarea with copy / download icon row ──────────── */
const copySvgFor = id => `<svg onclick="copyText('${id}')" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Copy all"><rect x="9" y="9" width="13" height="13" rx="2" stroke-width="1.5"/><rect x="2" y="2" width="13" height="13" rx="2" stroke-width="1.5"/></svg>`;
const dlSvgFor   = id => `<svg onclick="downloadSqlFromTextarea('${id}')" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Download"><path stroke-width="1.5" d="M12 3v12m0 0l-4-4m4 4l4-4"/><path stroke-width="1.5" d="M5 21h14"/></svg>`;
// Preview opens the SQL Preview modal — statement-segmented, syntax-highlighted,
// issue-flagged. Doesn't replace the textarea — opens on top of it.
const previewSvgFor = id => `<svg onclick="openSqlPreview('${id}')" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Open SQL Preview"><path stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1 1 0 010-.644C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178a1 1 0 010 .644C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><circle cx="12" cy="12" r="3" stroke-width="1.5"/></svg>`;

/* Final-output block:
 *   · plain textarea (canonical value)
 *   · toolbar: open-preview, copy-all, download
 *   · clicking preview opens the SQL Preview modal (see sql-preview.js)
 */
export function finalSqlBox(id) {
  return `
  <div class="query-section-label" style="margin-top:14px;">
    <span class="db-pill dest">Destination DB</span> Execute on Destination Database
  </div>
  <div class="sql-wrapper">
    <div class="sql-icons">${previewSvgFor(id)}${copySvgFor(id)}${dlSvgFor(id)}</div>
    <textarea id="${id}" class="sql-final-output" readonly placeholder="Generated migration SQL will appear here…"></textarea>
  </div>`;
}

/* ── Pull-query result renderer ──────────────────────────── */
/** Render Source / Destination query boxes into the given container. */
export function renderPullResult(containerId, data) {
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
        <div class="sql-icons">${copySvgFor('srcQ_' + containerId)}${dlSvgFor('srcQ_' + containerId)}</div>
        <textarea id="srcQ_${containerId}" readonly>${escapeHtml(hasSrc)}</textarea>
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
        <div class="sql-icons">${copySvgFor('destQ_' + containerId)}${dlSvgFor('destQ_' + containerId)}</div>
        <textarea id="destQ_${containerId}" readonly>${escapeHtml(hasDest)}</textarea>
      </div>
    </div>`;
  }

  html += `</div>`;
  document.getElementById(containerId).innerHTML = html;
}

/* ── JSON paste group ────────────────────────────────────── */
/**
 * @param {Object} o
 * @param {string} o.id      — textarea id (e.g. 'bJson1')
 * @param {string} o.label   — human label
 * @param {'source'|'dest'} o.side
 * @param {string} [o.placeholder]
 */
export function jsonGroup({ id, label, side, placeholder }) {
  const sideLabel = side === 'dest' ? 'DESTINATION' : 'SOURCE';
  return `
    <div class="json-group">
      <div class="json-label-row">
        <label>${label} <span class="required">*</span></label>
        <span class="db-pill ${side}">${sideLabel}</span>
      </div>
      <textarea id="${id}" placeholder="${placeholder || `Paste the JSON returned by the ${sideLabel === 'SOURCE' ? 'Source' : 'Destination'} DB pull query…`}"></textarea>
    </div>`;
}
