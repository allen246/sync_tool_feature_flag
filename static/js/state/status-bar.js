/* ============================================================
 *  status-bar.js — Reactive bottom status bar.
 *
 *  Reads the active tab from the TabRegistry to drive:
 *    · MODE   (active tab's statusKey)
 *    · SRC    (db-pill, or hidden if tab declares src: null)
 *    · DST    (db-pill, or hidden if tab declares dst: null)
 *    · CLOCK  (browser local time, ticks once per second)
 *    · TZ     (locale-resolved short name or GMT offset)
 *    · UPTIME (since page load)
 * ============================================================ */

import { TabRegistry } from './registry.js';
import { pad2 } from '../lib/dom.js';

export function startStatusBar() {
  const modeEl   = document.getElementById('statusbarMode');
  const clockEl  = document.getElementById('statusbarClock');
  const tzEl     = document.getElementById('statusbarTz');
  const clockSeg = document.getElementById('statusbarClockSegment');
  const uptimeEl = document.getElementById('statusbarUptime');

  /** Resolve the user's IANA + short TZ on load. */
  function resolveTz() {
    let ianaTz = '';
    try { ianaTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    let shortTz = '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
      const tzPart = parts.find(p => p.type === 'timeZoneName');
      if (tzPart) shortTz = tzPart.value;
    } catch (_) {}
    if (!shortTz) {
      const off = -new Date().getTimezoneOffset();
      const sign = off >= 0 ? '+' : '-';
      const h = Math.abs(Math.trunc(off / 60));
      const m = Math.abs(off % 60);
      shortTz = 'GMT' + sign + h + (m ? ':' + pad2(m) : '');
    }
    return { ianaTz, shortTz };
  }

  const tz = resolveTz();
  if (tzEl) tzEl.textContent = tz.shortTz;
  if (clockSeg) clockSeg.title = tz.ianaTz ? (tz.ianaTz + ' · ' + tz.shortTz) : tz.shortTz;

  /** Pulled from the active tab via the registry — no hard-coded map. */
  function updateMode() {
    const tab = TabRegistry.activeTab();
    const key = tab ? tab.statusKey : 'BRANCH';
    if (modeEl) modeEl.textContent = key;

    const ep = tab && tab.endpoints || { src: 'DB', dst: 'DB' };
    const srcEl = document.getElementById('statusbarSrc');
    const dstEl = document.getElementById('statusbarDst');
    const sepEl = document.getElementById('statusbarEndpointsSep');
    if (srcEl) renderEndpoint(srcEl, 'SRC', 'source', ep.src);
    if (dstEl) renderEndpoint(dstEl, 'DST', 'dest',   ep.dst);
    if (sepEl) sepEl.style.display = (ep.src || ep.dst) ? '' : 'none';
  }

  function renderEndpoint(el, label, sideCls, value) {
    if (value) {
      el.style.display = '';
      el.innerHTML = `${label} <span class="db-pill ${sideCls}">${value}</span>`;
    } else el.style.display = 'none';
  }

  // Hook each tab button so the bar refreshes after switch.
  document.querySelectorAll('.tabs button').forEach(b => {
    b.addEventListener('click', () => setTimeout(updateMode, 0));
  });
  updateMode();

  // Clock tick
  const start = Date.now();
  function tick() {
    const d = new Date();
    if (clockEl)  clockEl.textContent  = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    if (uptimeEl) {
      const s = Math.floor((Date.now() - start) / 1000);
      uptimeEl.textContent = pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60);
    }
  }
  tick();
  setInterval(tick, 1000);
}
