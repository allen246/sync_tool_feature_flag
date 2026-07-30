/* Self-check for lib/json-dump.js — run: node test_json_dump.mjs
 * Guards the two halves of the contract: real DB dumps get unwrapped,
 * real payloads pass through untouched. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { unwrapDbDump, unwrapDumpText } from './static/js/lib/json-dump.js';

const SQL = "SELECT JSON_OBJECT(\n    'tenant', (SELECT ...))\nFROM tenant t";

/* ── Dumps that must be unwrapped ─────────────────────────── */
assert.deepEqual(
  unwrapDbDump({ [SQL]: [{ result: '{"tenant":[{"organization_code":"RAK"}]}' }] }),
  { tenant: [{ organization_code: 'RAK' }] },
  'query-text column + stringified result');

assert.deepEqual(unwrapDbDump([{ result: '[{"a":1},{"a":2}]' }]), [{ a: 1 }, { a: 2 }],
  'single-row JSON_ARRAYAGG wrapper');
assert.deepEqual(unwrapDbDump({ data: { tenant: [] } }), { tenant: [] }, 'object wrapper');
assert.deepEqual(unwrapDbDump({ [SQL]: [] }), [], 'empty result set — tenant absent');
assert.deepEqual(unwrapDbDump({ [SQL]: [{ result: null }] }), null, 'null result set');

/* ── Payloads that must survive intact ────────────────────── */
const payload = { tenant: [{ a: 1 }], branch: [{ b: 2 }] };
assert.equal(unwrapDbDump(payload), payload, 'multi-key payload is not a wrapper');
// The one that bites: a single-row table export is data, not an envelope.
const oneRow = [{ code: 'BR1', name: 'Main' }];
assert.equal(unwrapDbDump(oneRow), oneRow, 'single-row array of a real row');
const rows = [{ a: 1 }, { a: 2 }];
assert.equal(unwrapDbDump(rows), rows, 'multi-row array');
assert.equal(unwrapDbDump('Active'), 'Active', 'plain string');
assert.equal(unwrapDumpText('{"tenant":[]}'), null, 'clean JSON reports nothing to do');
assert.equal(unwrapDumpText('not json'), null, 'unparsable reports nothing to do');

/* ── The real file, when it is around ─────────────────────── */
const sample = '/home/allen/huntington_qa_tenant_202607301034.json';
if (existsSync(sample)) {
  const out = JSON.parse(unwrapDumpText(readFileSync(sample, 'utf8')));
  assert.ok(Array.isArray(out.tenant) && out.tenant.length, 'real dump yields tenant rows');
  console.log(`real dump: ${Object.keys(out).length} tables, `
    + `${Object.values(out).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)} rows`);
} else {
  console.log(`skipped real-dump check (${sample} not present)`);
}

console.log('json-dump: OK');
