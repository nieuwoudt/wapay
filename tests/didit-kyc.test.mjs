/**
 * Didit KYC integration — crypto, state machine, and route wiring.
 *
 * Locks:
 * - FAIL CLOSED: no envs → no session creation, no webhook acceptance;
 * - webhook signature = HMAC-SHA256 hex over the EXACT raw bytes, with the
 *   5-minute timestamp replay window and constant-time compare;
 * - status map: Approved→VERIFIED, Declined→DECLINED, In Review→
 *   PENDING_REVIEW, Expired family→EXPIRED, in-flight→PENDING, unknown→null
 *   (never changes our state);
 * - profile.kyc is MERGED — verification never clobbers language/deposit
 *   prefs/acquisitionSource;
 * - PRIVACY: the full document/personal number is NEVER stored (masked
 *   only) and extracted person data is never logged;
 * - webhook route: bodyParser off, signature before parse, process-then-ACK
 *   (no fire-and-forget — BUGLOG #7), 5xx on sync failure so Didit retries,
 *   customer notification gated on notifiedStatus;
 * - admin KYC route: auth gate first; the verification link is sent ONLY to
 *   the account's registered waId, never a caller-supplied destination.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  diditConfigured, mapDiditStatus, startKycSession,
  verifyDiditSignature, syncKycFromDecision, DIDIT_REPLAY_WINDOW_S,
} from '../lib/didit-kyc.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const kycLib = read('../lib/didit-kyc.js');
const webhookRoute = read('../pages/api/webhooks/didit.js');
const adminKycRoute = read('../pages/api/admin/kyc.js');

const SECRET = 'didit-test-secret';
function armEnv() {
  process.env.DIDIT_API_KEY = 'test-api-key';
  process.env.DIDIT_WORKFLOW_ID = '11111111-2222-3333-4444-555555555555';
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
}
function disarmEnv() {
  delete process.env.DIDIT_API_KEY;
  delete process.env.DIDIT_WORKFLOW_ID;
  delete process.env.DIDIT_WEBHOOK_SECRET;
}

function stubPrisma(profile = {}) {
  const account = { id: 'acc1', waId: '27731234567', msisdn: '0731234567', profile };
  return {
    _account: account,
    account: {
      async findUnique() { return { ...account, profile: JSON.parse(JSON.stringify(account.profile)) }; },
      async update({ data }) { account.profile = data.profile; return { ...account }; },
    },
    // Model the atomic jsonb merges (lib/profile-merge.js). Distinguish the
    // two shapes by their interpolated values: subkey merge passes
    // ['{key}', key, json, accountId]; top merge passes [json, accountId].
    async $executeRaw(_strings, ...vals) {
      if (vals.length === 4) {
        const key = vals[1];
        const patch = JSON.parse(vals[2]);
        account.profile = account.profile && typeof account.profile === 'object' ? account.profile : {};
        account.profile[key] = { ...(account.profile[key] || {}), ...patch };
      } else if (vals.length === 2) {
        const patch = JSON.parse(vals[0]);
        account.profile = { ...(account.profile || {}), ...patch };
      }
      return 1;
    },
  };
}

test('fail closed without envs', async () => {
  disarmEnv();
  assert.equal(diditConfigured(), false);
  const out = await startKycSession({ prisma: stubPrisma(), account: { id: 'a', waId: 'w', profile: {} } });
  assert.deepEqual(out, { ok: false, error: 'DIDIT_NOT_CONFIGURED' });
  assert.equal(verifyDiditSignature({ rawBody: Buffer.from('x'), signature: 'y', timestamp: Date.now() / 1000 }), false);
});

test('status map is exact and unknown-safe', () => {
  assert.equal(mapDiditStatus('Approved'), 'VERIFIED');
  assert.equal(mapDiditStatus('Declined'), 'DECLINED');
  assert.equal(mapDiditStatus('In Review'), 'PENDING_REVIEW');
  for (const s of ['Expired', 'Kyc Expired', 'Abandoned']) assert.equal(mapDiditStatus(s), 'EXPIRED');
  for (const s of ['Not Started', 'In Progress', 'Awaiting User', 'Resubmitted']) assert.equal(mapDiditStatus(s), 'PENDING');
  assert.equal(mapDiditStatus('SomethingNew'), null, 'unknown statuses never move our state');
  assert.equal(mapDiditStatus('approved'), null, 'case matters — Didit is Title Case');
});

test('startKycSession: correct wire call, PENDING recorded, profile merged', async () => {
  armEnv();
  const prisma = stubPrisma({ language: 'xh', acquisitionSource: 'paylink' });
  let wire;
  const fetchFn = async (url, opts) => {
    wire = { url, opts };
    return { ok: true, json: async () => ({ session_id: 'sess-1', url: 'https://verify.didit.me/session/tok123', status: 'Not Started' }) };
  };
  const out = await startKycSession({ prisma, account: { ...prisma._account }, fetchFn });
  assert.equal(out.ok, true);
  assert.equal(out.url, 'https://verify.didit.me/session/tok123');
  assert.equal(wire.url, 'https://verification.didit.me/v3/session/');
  assert.equal(wire.opts.headers['x-api-key'], 'test-api-key');
  const body = JSON.parse(wire.opts.body);
  assert.equal(body.workflow_id, process.env.DIDIT_WORKFLOW_ID);
  assert.equal(body.vendor_data, 'acc1', 'vendor_data = account id (Didit-side idempotency)');
  assert.equal(body.language, 'en', 'unsupported profile languages fall back to en');
  assert.equal(prisma._account.profile.kyc.status, 'PENDING');
  assert.equal(prisma._account.profile.kyc.sessionId, 'sess-1');
  assert.equal(prisma._account.profile.language, 'xh', 'profile MERGE keeps other keys');
  assert.equal(prisma._account.profile.acquisitionSource, 'paylink');
});

test('webhook signature: valid passes, tamper/stale/length-mismatch fail', () => {
  armEnv();
  const body = Buffer.from(JSON.stringify({ session_id: 's', status: 'Approved' }));
  const now = Date.now();
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(verifyDiditSignature({ rawBody: body, signature: sig, timestamp: now / 1000, nowMs: now }), true);
  const tampered = Buffer.from(JSON.stringify({ session_id: 's', status: 'Declined' }));
  assert.equal(verifyDiditSignature({ rawBody: tampered, signature: sig, timestamp: now / 1000, nowMs: now }), false);
  assert.equal(
    verifyDiditSignature({ rawBody: body, signature: sig, timestamp: now / 1000 - DIDIT_REPLAY_WINDOW_S - 10, nowMs: now }),
    false, 'stale timestamp = replay, rejected'
  );
  assert.equal(verifyDiditSignature({ rawBody: body, signature: 'deadbeef', timestamp: now / 1000, nowMs: now }), false);
  assert.equal(verifyDiditSignature({ rawBody: body, signature: '', timestamp: now / 1000, nowMs: now }), false);
});

test('syncKycFromDecision: VERIFIED extracts masked data only; DECLINED keeps reason', async () => {
  armEnv();
  const prisma = stubPrisma({ language: 'zu', kyc: { status: 'PENDING', sessionId: 'sess-1' } });
  const decision = {
    status: 'Approved',
    id_verifications: [{
      status: 'Approved', full_name: 'Nomsa Dlamini', document_type: 'Identity Card',
      personal_number: '9001015800083', document_number: 'SMARTID123',
    }],
  };
  const out = await syncKycFromDecision({
    prisma, accountId: 'acc1', sessionId: 'sess-1',
    fetchFn: async () => ({ ok: true, json: async () => decision }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  const kyc = prisma._account.profile.kyc;
  assert.equal(kyc.status, 'VERIFIED');
  assert.equal(kyc.fullName, 'Nomsa Dlamini');
  assert.ok(kyc.idNumberMasked.endsWith('083'));
  assert.ok(!kyc.idNumberMasked.includes('9001015800'), 'full SA ID number NEVER stored');
  assert.ok(!JSON.stringify(prisma._account.profile).includes('9001015800083'), 'nowhere in the profile');
  assert.equal(prisma._account.profile.language, 'zu', 'merge preserved');

  // Re-applying the same decision: idempotent, changed=false.
  const again = await syncKycFromDecision({
    prisma, accountId: 'acc1', sessionId: 'sess-1',
    fetchFn: async () => ({ ok: true, json: async () => decision }),
  });
  assert.equal(again.changed, false);

  // Declined path keeps a bounded reason.
  const prisma2 = stubPrisma({ kyc: { status: 'PENDING' } });
  await syncKycFromDecision({
    prisma: prisma2, accountId: 'acc1', sessionId: 's2',
    fetchFn: async () => ({ ok: true, json: async () => ({ status: 'Declined', reviews: [{ comment: 'Document expired' }] }) }),
  });
  assert.equal(prisma2._account.profile.kyc.status, 'DECLINED');
  assert.equal(prisma2._account.profile.kyc.declineReason, 'Document expired');
});

test('syncKycFromDecision: unknown status is a logged no-op', async () => {
  armEnv();
  const prisma = stubPrisma({ kyc: { status: 'PENDING' } });
  const out = await syncKycFromDecision({
    prisma, accountId: 'acc1', sessionId: 's',
    fetchFn: async () => ({ ok: true, json: async () => ({ status: 'Weird Future Status' }) }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
  assert.equal(prisma._account.profile.kyc.status, 'PENDING', 'state untouched');
});

// ---------------------------------------------------------------------------
// Statics
// ---------------------------------------------------------------------------

test('static: webhook — raw body, signature-first, process-then-ACK, retryable failures', () => {
  assert.match(webhookRoute, /bodyParser: false/, 'signature needs the exact raw bytes');
  const sigIdx = webhookRoute.indexOf('verifyDiditSignature');
  const parseIdx = webhookRoute.indexOf('JSON.parse');
  assert.ok(sigIdx > -1 && parseIdx > sigIdx, 'verify BEFORE parse');
  assert.match(webhookRoute, /status\(401\)/, 'bad signature is rejected');
  assert.match(webhookRoute, /status\(502\)|status\(500\)/, 'sync failure returns 5xx so Didit retries');
  assert.ok(!/\(async \(\) => \{/.test(webhookRoute), 'no fire-and-forget blocks (BUGLOG #7)');
  assert.match(webhookRoute, /notifiedStatus !== status/, 'notification dedupe gate');
  assert.match(webhookRoute, /sent\?\.ok/, 'send success checked on the resolved .ok (BUGLOG #24)');
});

test('static: webhook never trusts the embedded decision payload', () => {
  assert.match(webhookRoute, /syncKycFromDecision/, 'decision endpoint is the source of truth');
  assert.ok(!/event\.decision/.test(webhookRoute), 'the webhook decision blob is never read');
});

test('static: admin KYC route — gate first, link only to the registered waId', () => {
  const body = adminKycRoute.slice(adminKycRoute.indexOf('export default'));
  const gate = body.indexOf('requireAdmin(req)');
  const firstQuery = body.search(/prisma\.[a-z$]/);
  assert.ok(gate > -1 && (firstQuery === -1 || gate < firstQuery));
  assert.match(adminKycRoute, /to: account\.waId/, 'delivery destination is the account record');
  assert.ok(!/to: (req|msisdn|body)/.test(adminKycRoute), 'never a caller-supplied destination');
  assert.match(adminKycRoute, /localizeOutbound/, 'customer-facing copy is localized');
});

test('static: privacy — extracted person data never logged, masked storage documented', () => {
  assert.ok(!/console\.(log|error)\([^)]*(full_name|personal_number|document_number|idv)/.test(kycLib));
  assert.match(kycLib, /maskDocNumber/);
  assert.match(kycLib, /POPIA/, 'the privacy stance is documented in place');
});

test('policy: no betting words, no cash-out promises, no em dashes in customer copy', () => {
  for (const src of [kycLib, webhookRoute, adminKycRoute]) {
    assert.ok(!/\bbet(s|ting|tor)?\b|gambl|casino|wager|bookmak/i.test(src));
  }
  const customerCopy = [...adminKycRoute.matchAll(/`([^`]*)`/gs), ...webhookRoute.matchAll(/'(✅[^']*|❌[^']*)'/g)]
    .map((m) => m[1]).join(' ');
  assert.ok(!customerCopy.includes('—'), 'customer-facing copy is em-dash-free (founder rule)');
  assert.ok(!/cash\s?-?\s?out|withdraw/i.test(customerCopy), 'no cash-out promises before counsel clears it');
});

// ---------------------------------------------------------------------------
// Review 2026-08-28 — regression guards for the confirmed KYC findings
// ---------------------------------------------------------------------------

test('decision binding: a session whose vendor_data names ANOTHER account is refused', async () => {
  armEnv();
  const prisma = stubPrisma({ kyc: { status: 'PENDING', sessionId: 'sess-1' } });
  const out = await syncKycFromDecision({
    prisma, accountId: 'acc1', sessionId: 'sess-1',
    fetchFn: async () => ({ ok: true, json: async () => ({ status: 'Approved', vendor_data: 'someone-else' }) }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'DIDIT_VENDOR_MISMATCH');
  assert.equal(prisma._account.profile.kyc.status, 'PENDING', 'the other account never touched this one');
});

test('a stale foreign session cannot downgrade a VERIFIED account', async () => {
  armEnv();
  const prisma = stubPrisma({ kyc: { status: 'VERIFIED', sessionId: 'good-session' } });
  const out = await syncKycFromDecision({
    prisma, accountId: 'acc1', sessionId: 'other-old-session',
    fetchFn: async () => ({ ok: true, json: async () => ({ status: 'Expired', vendor_data: 'acc1' }) }),
  });
  assert.equal(out.changed, false);
  assert.equal(prisma._account.profile.kyc.status, 'VERIFIED', 'stays verified');
});

test('declineReason redacts long digit runs (POPIA)', async () => {
  armEnv();
  const prisma = stubPrisma({ kyc: { status: 'PENDING' } });
  await syncKycFromDecision({
    prisma, accountId: 'acc1', sessionId: 's',
    fetchFn: async () => ({ ok: true, json: async () => ({ status: 'Declined', reviews: [{ comment: 'ID 9001015800083 mismatch' }] }) }),
  });
  const reason = prisma._account.profile.kyc.declineReason;
  assert.ok(!reason.includes('9001015800083'), 'no raw ID number persisted');
  assert.ok(reason.includes('####'));
});

test('atomic KYC merge preserves sibling profile keys (no clobber)', async () => {
  armEnv();
  const prisma = stubPrisma({ language: 'zu', acquisitionSource: 'paylink', interests: ['data'] });
  await syncKycFromDecision({
    prisma, accountId: 'acc1', sessionId: 's',
    fetchFn: async () => ({ ok: true, json: async () => ({ status: 'In Review', vendor_data: 'acc1' }) }),
  });
  assert.equal(prisma._account.profile.language, 'zu');
  assert.equal(prisma._account.profile.acquisitionSource, 'paylink');
  assert.deepEqual(prisma._account.profile.interests, ['data']);
  assert.equal(prisma._account.profile.kyc.status, 'PENDING_REVIEW');
});
