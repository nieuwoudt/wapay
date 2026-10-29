// Lisa's evening of 28 October 2026 (BUGLOG #145 to #148) replayed through the REAL message processor.
// Spawned by tests/payout-incident-chat.test.mjs with --experimental-test-module-mocks; prints one RESULT line.
//
// Mocked exactly as tests/helpers/pay-links-chat-run.mjs: the WhatsApp transport (every send captured), the
// database (the web app's in-memory client, lib/app-dev-fixture.js createMemoryPrisma), the auth package and the
// model package (no model is ever called; the Pay agent's turn would throw). Everything else is production code.
import { mock } from 'node:test';

const root = process.env.WAPAY_ROOT;
const abs = (rel) => new URL(rel, `file://${root}/`).href;

const sends = [];
const holder = { client: null };
const agent = { calls: 0 };
let seq = 0;

mock.module('@wapay/whatsapp', {
  namedExports: {
    sendWhatsAppText: async ({ to, text }) => { sends.push({ to, text, kind: 'text' }); return { ok: true, data: { messages: [{ id: `wamid.out.${sends.length}` }] } }; },
    sendWhatsAppCtaUrl: async (a) => { sends.push({ to: a.to, text: `${a.bodyText || ''} [${a.buttonText || ''}]`, kind: 'cta' }); return { ok: true, data: { messages: [{ id: 'wamid.cta' }] } }; },
    sendWhatsAppReplyButtons: async (a) => { sends.push({ to: a.to, text: a.bodyText || a.text || '', kind: 'buttons' }); return { ok: true }; },
    sendWhatsAppTemplate: async (a) => { sends.push({ to: a.to, text: a.templateName, kind: 'template' }); return { ok: true }; },
    sendWhatsAppUtilityDirect: async (a) => { sends.push({ to: a.to, text: a.text, kind: 'direct' }); return { ok: true }; },
    directSendEnabled: () => false,
    outboundSendCount: () => sends.length,
    runWithSendScope: (fn) => fn(),
    sendTypingIndicator: async () => ({ ok: true }),
    buildReplyButtonsPayload: (a) => a,
    authTemplateComponents: () => [],
    buildCatalog: () => ({}),
    getAvailableTemplates: async () => [],
    seedWhatsappTemplates: async () => ({}),
    MARKETING_TEMPLATES: new Set(),
  },
});
mock.module(abs('lib/prisma.js'), { defaultExport: new Proxy({}, { get: (_, k) => holder.client[k] }) });
mock.module('@wapay/auth', {
  namedExports: {
    getOnboardingState: async (accountId) => holder.client._tables.account.find((a) => a.id === accountId)?.onboardingState || null,
    verifyPIN: async () => ({ ok: false, error: 'INVALID_PIN' }),
    hasPIN: async () => true,
    validatePINFormat: () => ({ valid: true }),
    setPIN: async () => ({ ok: true }),
    resetPIN: async () => ({ ok: true }),
    onboardingOtpDisabled: () => false,
    completeOneStepOnboarding: async () => ({ ok: true }),
    startOnboardingFromAd: async () => ({ ok: true }),
    handleS0Initial: async () => ({ ok: true }),
    handleS1WelcomeSent: async () => ({ ok: true }),
    handleS2OtpSent: async () => ({ ok: true }),
    handleS3OtpVerified: async () => ({ ok: true }),
    handleS4PinSet: async () => ({ ok: true }),
    handleResendOTP: async () => ({ ok: true }),
  },
});
mock.module('@wapay/ai', {
  namedExports: {
    orchestrate: async () => { throw new Error('NO_MODEL_IN_THIS_TEST'); },
    runAgentTurn: async () => { agent.calls += 1; throw new Error('NO_MODEL_IN_THIS_TEST'); },
    buildAgentSystemPrompt: () => 'SYSTEM',
    runWithPrivacy: (_names, fn) => fn(),
    addPrivacyNames: () => {},
    guardTranslation: (text) => ({ text, vault: { tokens: new Map() } }),
    restore: (t) => t,
    guardEmbeddingInput: (x) => x,
    guardEmbeddingBatch: (x) => x,
    callStructuredOnce: async () => { throw new Error('NO_MODEL_IN_THIS_TEST'); },
  },
});

const { createMemoryPrisma } = await import(abs('lib/app-dev-fixture.js'));
const MODELS = ['account', 'payoutIdentity', 'payoutDestination', 'wallet', 'hold', 'journalEntry', 'journalLine', 'processedMessage', 'providerRequest', 'authSession', 'limit', 'vasProduct', 'yoyoInstrument', 'whatsappTemplate', 'otpCode', 'authFactor', 'consent', 'auditLog', 'paymentRequest', 'business', 'businessCustomer', 'beneficiary', 'pendingGift', 'conversationTurn', 'agentJob', 'agentTurn', 'adInsightDaily', 'adCatalog', 'auditRun', 'auditFinding'];
const now = Date.now();
const MIN = 60 * 1000;
const person = (n, extra = {}) => ({
  id: `acc_lisa${n}`, waId: `2760002${String(n).padStart(4, '0')}`, msisdn: `060002${String(n).padStart(4, '0')}`, displayName: 'Lisa', status: 'ACTIVE',
  onboardingState: 'S5_COMPLETED', onboardingStatus: 'COMPLETED', profile: { language: 'en' }, conversationState: null, conversationData: {}, createdAt: new Date(now - 30 * 24 * 60 * MIN), ...extra,
});
const seed = Object.fromEntries(MODELS.map((m) => [m, []]));
const masked = { name: 'L M', mobile: null, account: '•••918', idDoc: 'PASSPORT/ZW' };
const row = (accountId, n, status, meta, ageMin) => ({
  id: `pr_${accountId}_${n}`, provider: 'OTT', route: 'ott-payout', idemKey: `payout-${accountId}-intent-${n}`, status, accountId, providerRef: null,
  requestTs: new Date(now - ageMin * MIN), metadata: { method: 'PAYSHAP', recipient: masked, ...meta },
});

// 21:20 on the night: the R100 waits for approval with R116 set aside; R244 is available.
const L1 = person(1);
seed.wallet.push(
  { id: 'w_l1_spend', accountId: L1.id, balanceType: 'SPEND', availableCents: 24400, pendingCents: 0 },
  { id: 'w_l1_cash', accountId: L1.id, balanceType: 'CASH', availableCents: 0, pendingCents: 11600 },
);
seed.providerRequest.push(row(L1.id, 'r100', 'AWAITING_APPROVAL', { amountCents: 10000, feeCents: 1600, express: true, reference: 'WP161EF3F64B2374', approval: { requestedAt: new Date(now - 40 * MIN).toISOString() } }, 40));

// 22:13 on the night: the R100 failed at the bank at 21:40, the R325 was paid earlier, the R60 came in: R420.
const L2 = person(2);
seed.wallet.push({ id: 'w_l2_spend', accountId: L2.id, balanceType: 'SPEND', availableCents: 42000, pendingCents: 0 });
seed.providerRequest.push(
  row(L2.id, 'r325', 'SUCCESS', { amountCents: 32500, feeCents: 800, reference: 'WPED6D478285A1E9', outcome: 'SUCCESS', finalisedAt: new Date(now - 26 * 60 * MIN).toISOString() }, 26 * 60 + 1),
  row(L2.id, 'r100', 'FAILED', { amountCents: 10000, feeCents: 1600, express: true, reference: 'WP161EF3F64B2374', outcome: 'PROVIDER_97', lastMessage: 'Fail at Provider', finalisedAt: new Date(now - 33 * MIN).toISOString() }, 75),
);

// A Pay agent pilot number with no withdrawal: the complaint is answered before the agent, from the record.
const L3 = person(3);
seed.wallet.push({ id: 'w_l3_spend', accountId: L3.id, balanceType: 'SPEND', availableCents: 5000, pendingCents: 0 });

seed.account.push(L1, L2, L3);
holder.client = createMemoryPrisma(seed);
const db = holder.client._tables;

process.env.WAPAY_AGENT_V3_MSISDNS = L3.waId;
const { processMessage } = await import(abs('pages/api/webhooks/message-processor-v2.js'));

async function say(who, text) {
  const before = sends.length;
  seq += 1;
  await processMessage({ from: who.waId, text, messageId: `wamid.in.${seq}`, profile: { name: who.displayName } });
  return sends.slice(before).map((s) => ({ to: s.to, kind: s.kind, text: s.text }));
}
const stateOf = (who) => db.account.find((a) => a.id === who.id)?.conversationState || null;
const payoutsOf = (who) => db.providerRequest.filter((r) => r.accountId === who.id && r.route === 'ott-payout').map((r) => ({ status: r.status, amountCents: r.metadata?.amountCents }));

const out = {};
try {
  // 21:18: a second withdrawal while the R100 waits.
  out.second = { turn: await say(L1, 'withdraw R228 to my capitec account'), state: stateOf(L1), payouts: payoutsOf(L1) };
  out.status1 = { turn: await say(L1, 'did my withdrawal go through'), state: stateOf(L1) };
  // 22:13: the complaint.
  out.complaint = { turn: await say(L2, 'Nothing is coming in to my bank account'), state: stateOf(L2) };
  out.why = { turn: await say(L2, 'why did my withdrawal fail'), state: stateOf(L2) };
  out.person = { turn: await say(L2, 'person'), state: stateOf(L2) };
  // A real withdraw ask still starts the flow once nothing is open.
  out.fresh = { turn: await say(L2, 'withdraw R100'), state: stateOf(L2) };
  // The pilot number: answered before the agent.
  out.agent = { turn: await say(L3, 'Nothing is coming in to my bank account'), state: stateOf(L3), agentCalls: agent.calls };
} catch (error) {
  out.error = String(error?.stack || error);
}
console.log(`RESULT ${JSON.stringify(out)}`);
