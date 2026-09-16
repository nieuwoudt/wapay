/**
 * Live conversational harness for the WaPay WhatsApp brain.
 *
 * Drives the REAL processMessage() — real DB (via DATABASE_URL), real
 * deterministic routers, real OpenAI orchestrator/localizer when
 * OPENAI_API_KEY is set — with exactly ONE thing replaced: the outbound
 * WhatsApp transport. mock.module('@wapay/whatsapp') swaps the three send
 * functions for capture stubs, and because every importer (the processor,
 * @wapay/auth onboarding, lib/request-notify) resolves the same specifier,
 * NOTHING can leak a real send. Requires:
 *
 *   node --env-file=.env --experimental-test-module-mocks <runner>
 *
 * Safety invariants (this file is the only place they need holding):
 * - The QA account is run-scoped, seeded directly at S5_COMPLETED with a
 *   ZERO-cent wallet (no thin-air money on a ledgered DB) and torn down in
 *   a finally, payment requests included.
 * - No scenario may ever submit a wallet PIN or complete a VAS purchase —
 *   flows are entered and escaped/cancelled, never executed.
 * - If the QA waId already exists and was not created by this harness, we
 *   ABORT rather than adopt a stranger's account.
 */

import { mock } from 'node:test';

// The processor's self-HTTP (VAS previews) needs a base URL even though the
// harness scenarios never reach a preview; point at prod so IF one slips
// through it lands on the guarded internal API instead of throwing.
process.env.APP_BASE_URL ||= 'https://wapay.co.za';

export const outbox = [];

// 2026-09-16: the processor counts sends per turn (claim release on a
// silent throw) and the webhook scopes them; the mock keeps the same shape.
let qaSends = 0;

mock.module('@wapay/whatsapp', {
  namedExports: {
    sendWhatsAppText: async ({ to, text }) => {
      outbox.push({ kind: 'text', to, text });
      qaSends += 1;
      return { ok: true, data: { id: `qa-${outbox.length}`, messages: [{ id: `qa-${outbox.length}` }] } };
    },
    outboundSendCount: () => qaSends,
    runWithSendScope: (fn) => fn(),
    sendTypingIndicator: async () => ({ ok: true }),
    directSendEnabled: () => false,
    sendWhatsAppUtilityDirect: async ({ to, text }) => {
      outbox.push({ kind: 'text', to, text });
      qaSends += 1;
      return { ok: true, data: { id: `qa-${outbox.length}` } };
    },
    sendWhatsAppTemplate: async ({ to, templateName, language }) => {
      outbox.push({ kind: 'template', to, text: `[template:${templateName}:${language?.code || language || ''}]`, templateName });
      return { ok: true, data: { id: `qa-${outbox.length}` } };
    },
    sendWhatsAppCtaUrl: async ({ to, bodyText, buttonText, url }) => {
      outbox.push({ kind: 'cta', to, text: `${bodyText}\n[button:${buttonText} -> ${url}]`, url });
      return { ok: true, data: { id: `qa-${outbox.length}` } };
    },
    // Inert extras so any transitive import keeps resolving.
    seedWhatsappTemplates: async () => ({ ok: true, seeded: [] }),
    buildCatalog: async () => ({}),
    getAvailableTemplates: async () => [],
    getAvailableLanguages: async () => ['en'],
    resolveLanguage: () => ({ code: 'en' }),
    isApproved: () => true,
    buildCtaUrlPayload: (args) => args,
    // 2026-09-06: OTP pushes build body + copy-code button params through this.
    authTemplateComponents: (code) => [{ type: 'body', parameters: [{ type: 'text', text: code }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }],
  },
});

// The OTT payout rail is mocked too (2026-09-15): the real OTT test shape for providers and
// limits, and a PerformPayout that settles instantly. No network, no money at OTT; the
// WaPay ledger side (SPEND -> CASH, hold, settle) runs for real on the QA wallet and is
// torn down by idemKey prefix below.
export const OTT_TEST_LIMITS = { errorCode: 0, errorMessage: 'Success', requiredFields: [
  { providerCode: 1, providerName: 'FNB e-wallet', providerMinLimit: 0, providerMaxLimit: 0, requiredFields: [{ firstname: 'Required', surname: 'Required', id_number: 'Required', mobile: 'Required' }] },
  { providerCode: 4, providerName: 'Nedbank Cardless Withdrawal', providerMinLimit: 0, providerMaxLimit: 0, requiredFields: [{ firstname: 'Required', surname: 'Required', id_number: 'Required', mobile: 'Required' }] },
  { providerCode: 112, providerName: 'ABSA CashSend', providerMinLimit: 0, providerMaxLimit: 0, requiredFields: [{ firstname: 'Required', surname: 'Required', id_number: 'Required', mobile: 'Required' }] },
  { providerCode: 127, providerName: 'PayShap Account', providerMinLimit: 0, providerMaxLimit: 0, requiredFields: [{ firstname: 'Required', surname: 'Required', id_number: 'Required', mobile: 'Required', account_Number: 'Required', branch_Code: 'Required' }] },
] };
export const ottCalls = [];
mock.module(new URL('../../lib/ott-payout.js', import.meta.url).href, {
  namedExports: {
    OttPayoutClient: class {
      constructor() {}
      async getBalance() { return { status: 'Success', balance: 100000 }; }
      async getActiveProviders() { return { errorCode: 0, providers: OTT_TEST_LIMITS.requiredFields.map(({ providerCode, providerName }) => ({ providerCode, providerName })) }; }
      async getActiveProviderLimits() { return OTT_TEST_LIMITS; }
      async getActiveProvidersLimits() { return OTT_TEST_LIMITS; }
      async performPayout(args) { ottCalls.push({ ...args, recipient: { ...args.recipient, id_number: '***', account_number: '***' } }); return { httpStatus: 200, status: 1, outcome: 'SUCCESS', settlement: 'SETTLE', retriable: false, paymentReference: `QA-${args.yourUniqueReference}`, body: {} }; }
      async getPaymentStatus() { return { status: 100 }; }
    },
    verifyPayoutWebhook: () => true,
    classifyPayoutStatus: () => ({ outcome: 'SUCCESS', settlement: 'SETTLE', retriable: false }),
    centsToAmountString: (c) => (c / 100).toFixed(2),
    payoutAmountToCents: (r) => Math.round(Number(r) * 100),
    payoutHash: () => 'qa',
    basicAuthHeader: () => 'Basic qa',
  },
});

// Everything below imports AFTER the mocks are installed.
const { processMessage } = await import('../../pages/api/webhooks/message-processor-v2.js');
const { default: prisma } = await import('../../lib/prisma.js');
const { default: argon2 } = await import('argon2');
const { buildLoad, RAIL, BALANCE } = await import('../../lib/ledger-core.js');
const { postEntry, ensureWallet } = await import('../../lib/ledger-post.js');

export const QA_PIN = '1934';
// payoutConfigured() needs all four OTT_PAYOUT_* set; the local .env leaves the username blank.
// The client is mocked above, so these placeholders never reach OTT.
for (const [k, v] of Object.entries({ OTT_PAYOUT_BASE_URL: 'https://ott.invalid', OTT_PAYOUT_USERNAME: 'qa', OTT_PAYOUT_PASSWORD: 'qa', OTT_PAYOUT_API_KEY: 'qa' })) if (!process.env[k]) process.env[k] = v;

export const QA_WA_ID = process.env.CHAT_QA_WA_ID || '27600000901';
const QA_MARKER = 'WaPay QA Harness';

export async function seedQaAccount() {
  const existing = await prisma.account.findFirst({ where: { waId: QA_WA_ID } });
  if (existing && existing.displayName !== QA_MARKER) {
    throw new Error(`waId ${QA_WA_ID} already belongs to a non-harness account (${existing.id}) — refusing to touch it. Set CHAT_QA_WA_ID to a free number.`);
  }
  if (existing) await teardownQaAccount(); // stale run — clean slate
  const account = await prisma.account.create({
    data: {
      waId: QA_WA_ID,
      msisdn: QA_WA_ID,
      displayName: QA_MARKER,
      onboardingState: 'S5_COMPLETED',
      onboardingStatus: 'COMPLETE',
      status: 'ACTIVE',
      conversationState: null,
      conversationData: {},
      profile: {},
    },
  });
  await prisma.wallet.create({
    data: { accountId: account.id, balanceType: 'SPEND', currency: 'ZAR', availableCents: 0, pendingCents: 0 },
  });
  return account;
}

/**
 * Money and a PIN for the flows that need them (withdraw): R100 loaded THROUGH the ledger
 * (never a direct availableCents write), tagged by idemKey so teardown removes the whole
 * entry, and an argon2id PIN factor with the same recipe verifyPIN expects (setPIN's
 * argon2 interop breaks in plain-node ESM; see tests/e2e/fuel-e2e.mjs).
 */
export async function fundQaAccount({ cents = 10000 } = {}) {
  const account = await prisma.account.findFirst({ where: { waId: QA_WA_ID } });
  if (!account || account.displayName !== QA_MARKER) throw new Error('fundQaAccount: no harness account');
  await ensureWallet({ accountId: account.id, balanceType: BALANCE.SPEND });
  await postEntry(buildLoad({ accountId: account.id, rail: RAIL.PAYFAST, faceCents: cents, idemKey: `chatqa-load-${account.id}` }));
  const pepper = process.env.PIN_PEPPER || 'wapay_pin_pepper_2025_change_in_production';
  const secretHash = await argon2.hash(QA_PIN + pepper, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  await prisma.authFactor.deleteMany({ where: { accountId: account.id, type: 'PIN' } }).catch(() => {});
  await prisma.authFactor.create({ data: { id: `pin_chatqa_${account.id}`, accountId: account.id, type: 'PIN', secretHash, attempts: 0, setAt: new Date() } });
  return account;
}

/** Park the QA account in a flow as if it had been set `minutesAgo` minutes ago (idle-expiry scenarios). */
export async function parkQaState(state, data = {}, minutesAgo = 0) {
  const account = await prisma.account.findFirst({ where: { waId: QA_WA_ID } });
  const stateSetAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
  await prisma.account.update({ where: { id: account.id }, data: { conversationState: state, conversationData: { ...(account.conversationData || {}), ...data, stateSetAt } } });
}

export async function teardownQaAccount() {
  const account = await prisma.account.findFirst({ where: { waId: QA_WA_ID } });
  if (!account || account.displayName !== QA_MARKER) return;
  // Kill any links the scenarios minted BEFORE deleting rows, so no live
  // pay URL survives pointing at a deleted account.
  await prisma.paymentRequest.updateMany({
    where: { accountId: account.id, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  await prisma.paymentRequest.deleteMany({ where: { accountId: account.id } });
  await prisma.providerRequest.deleteMany({ where: { accountId: account.id } }).catch(() => {});
  await prisma.authFactor.deleteMany({ where: { accountId: account.id } }).catch(() => {});
  // 2026-09-16: both sides of every turn now live in conversation_turns.
  await prisma.conversationTurn.deleteMany({ where: { accountId: account.id } }).catch(() => {});
  await prisma.agentTurn.deleteMany({ where: { accountId: account.id } }).catch(() => {});
  // The chat sign-up scenario registers a business and asks for a portal
  // code: both rows hang off the account and must go first.
  const businesses = await prisma.business.findMany({ where: { accountId: account.id }, select: { id: true } }).catch(() => []);
  if (businesses.length) {
    await prisma.businessCustomer.deleteMany({ where: { businessId: { in: businesses.map((b) => b.id) } } }).catch(() => {});
    await prisma.business.deleteMany({ where: { accountId: account.id } }).catch(() => {});
  }
  await prisma.otpCode.deleteMany({ where: { accountId: account.id } }).catch(() => {});
  // Ledger rows the funded scenarios created: holds on the QA wallets, then every journal
  // entry tagged chatqa-* or payout-<accountId>* (with its CLEARING side), so no float drifts.
  await prisma.hold.deleteMany({ where: { wallet: { accountId: account.id } } }).catch(() => {});
  const tagged = { OR: [{ idemKey: { startsWith: 'chatqa-' } }, { idemKey: { startsWith: `payout-${account.id}` } }] };
  await prisma.journalLine.deleteMany({ where: { entry: tagged } }).catch(() => {});
  await prisma.journalEntry.deleteMany({ where: tagged }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { accountId: account.id } });
  await prisma.account.delete({ where: { id: account.id } });
}

let turn = 0;

export function createSession(waId = QA_WA_ID) {
  return {
    waId,
    transcript: [],
    /** Send one user message; resolve with the bot's replies for it. */
    async say(text, { messageId } = {}) {
      const before = outbox.length;
      const id = messageId || `chatqa-${process.pid}-${++turn}`;
      const res = await processMessage({ from: waId, text, messageId: id });
      const replies = outbox.slice(before).filter((m) => m.to === waId);
      const replyText = replies.map((r) => r.text).join('\n···\n');
      this.transcript.push({ user: text, bot: replyText || '(no reply)', meta: res });
      return { res, replies, replyText };
    },
  };
}

export { prisma };
