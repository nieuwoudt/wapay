// The nightly audit runs in its own invocation (2026-10-21): the cron hands it off and stops waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('the cron fires POST /api/internal/audit-run with the internal key, aborts the wait after four seconds, and keeps the in-process run as the fallback', () => {
  const cron = read('../pages/api/cron/daily-vas-sync.js');
  assert.match(cron, /fetch\(apiUrl\('\/api\/internal\/audit-run', req\), \{ method: 'POST', headers: \{ 'x-internal-api-key': key/);
  assert.match(cron, /setTimeout\(\(\) => controller\.abort\(\), 4000\)/);
  assert.match(cron, /e\?\.name === 'AbortError' \? \{ ok: true, handoff: true, status: 'RUNNING' \}/);
  assert.match(cron, /if \(!audit\) \{[\s\S]*runDailyAudit\(\{ prisma, deadlineMs: auditCapMs - 3 \* 1000 \}\)/, 'fallback stays');
  assert.match(cron, /handoff: audit\?\.handoff \|\| false/);
  const route = read('../pages/api/internal/audit-run.js');
  assert.match(route, /maxDuration: 60/); assert.match(route, /deadlineMs: 50_000/);
});
