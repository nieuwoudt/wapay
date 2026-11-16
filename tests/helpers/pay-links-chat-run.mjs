// The real message processor, run end to end for the payment-link turns (2026-10-24).
// Spawned by tests/pay-links-chat.test.mjs with --experimental-test-module-mocks; prints one RESULT line.
//
// Mocked: the WhatsApp transport (every send captured), the database (the web app's in-memory client,
// lib/app-dev-fixture.js createMemoryPrisma), the auth package (it reads its own database client) and the
// model package (no model is ever called; the Pay agent's one turn returns a scripted proposal). Everything
// else is the code that runs in production: the processor, user-manager, say(), the link libraries.
import { mock } from 'node:test';

const root = process.env.WAPAY_ROOT;
const abs = (rel) => new URL(rel, `file://${root}/`).href;

const sends = [];
const holder = { client: null };
const agent = { result: null, calls: 0 };
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
    runAgentTurn: async () => { agent.calls += 1; return agent.result; },
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
const H = 3600 * 1000;
const person = (n, name, extra = {}) => ({
  id: `acc_${n}`, waId: `2760001${String(n).padStart(4, '0')}`, msisdn: `060001${String(n).padStart(4, '0')}`, displayName: name, status: 'ACTIVE',
  onboardingState: 'S5_COMPLETED', onboardingStatus: 'COMPLETED', profile: { language: 'en' }, conversationState: null, conversationData: {}, createdAt: new Date(now - 30 * 24 * H), ...extra,
});
const seed = Object.fromEntries(MODELS.map((m) => [m, []]));
const R = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => [n, person(n, 'Thandi Nkosi')]));
// An ad arrival who has just finished onboarding and was asked for the first link (docs/AD_CHAT_FLOW.md section 8).
R[12] = person(12, 'Lerato Dube', { profile: { language: 'en', acquisitionSource: 'ad' }, conversationState: 'AD_FIRST_LINK', conversationData: { stateSetAt: new Date(now - 60 * 1000).toISOString() } });
R[13] = person(13, 'Lerato Dube', { profile: { language: 'en', acquisitionSource: 'ad' }, conversationState: 'AD_FIRST_LINK', conversationData: { stateSetAt: new Date(now - 60 * 1000).toISOString() } });
seed.account.push(...Object.values(R));
// Two WaPay members the requesters 6 and 7 have sent money to: one wrote an hour ago, one not for 30 hours.
const P_OPEN = person(91, 'Payer Open', { msisdn: '0821230091', waId: '27821230091' });
const P_CLOSED = person(92, 'Payer Closed', { msisdn: '0821230092', waId: '27821230092' });
seed.account.push(P_OPEN, P_CLOSED);
seed.pendingGift.push(
  { id: 'gift_6', idemKey: 'gift_6', senderAccountId: R[6].id, recipientMsisdn: P_OPEN.msisdn, amountCents: 1000, status: 'DELIVERED', rail: 'WAPAY', createdAt: new Date(now - 48 * H) },
  { id: 'gift_7', idemKey: 'gift_7', senderAccountId: R[7].id, recipientMsisdn: P_CLOSED.msisdn, amountCents: 1000, status: 'DELIVERED', rail: 'WAPAY', createdAt: new Date(now - 48 * H) },
);
seed.conversationTurn.push(
  { id: 'turn_open', accountId: P_OPEN.id, role: 'user', text: 'hi', createdAt: new Date(now - 1 * H) },
  { id: 'turn_closed', accountId: P_CLOSED.id, role: 'user', text: 'hi', createdAt: new Date(now - 30 * H) },
);
holder.client = createMemoryPrisma(seed);
const db = holder.client._tables;

process.env.WAPAY_AGENT_V3_MSISDNS = R[10].waId;
const { processMessage } = await import(abs('pages/api/webhooks/message-processor-v2.js'));

/** One customer message through the real processor; what was sent in that turn. */
async function say(who, text) {
  const before = sends.length;
  seq += 1;
  await processMessage({ from: who.waId, text, messageId: `wamid.in.${seq}`, profile: { name: who.displayName } });
  return sends.slice(before);
}
const linksOf = (who) => db.paymentRequest.filter((r) => r.accountId === who.id).map((r) => ({ id: r.id, amountCents: r.amountCents, note: r.note, status: r.status }));
const stateOf = (who) => db.account.find((a) => a.id === who.id)?.conversationState || null;

const out = {};
try {
  // 1. Free band, what it is for in the same message: one message, the card.
  out.s1 = { turn: await say(R[1], 'please pay me R40 for lunch'), links: linksOf(R[1]), state: stateOf(R[1]) };

  // 2. No description: one question; the answer makes the link in one message.
  const q2 = await say(R[2], 'please pay me R40');
  const s2state = stateOf(R[2]);
  const linksBefore2 = linksOf(R[2]).length;
  out.s2 = { question: q2, stateAfterQuestion: s2state, linksAfterQuestion: linksBefore2, answer: await say(R[2], 'lunch'), links: linksOf(R[2]), state: stateOf(R[2]) };

  // 3. Refused descriptions are said plainly; "cancel" always gets out; no link.
  out.s3 = { link: await say(R[3], 'please pay me R40 for www.evil.com'), impersonation: await say(R[3], 'WaPay fee'), cancel: await say(R[3], 'cancel'), links: linksOf(R[3]), state: stateOf(R[3]) };

  // 4. Fee band: the fee choice names what it is for, then "1" makes the link in one message.
  out.s4 = { choice: await say(R[4], 'please pay me R150 for braids'), made: await say(R[4], '1'), links: linksOf(R[4]) };

  // 5. A number the requester typed: the one message carries the tap-to-send link; nothing goes to that number.
  out.s5 = { turn: await say(R[5], 'request R40 from 082 123 4567 for plumbing'), links: linksOf(R[5]) };

  // 6 and 7. A member the requester has sent money to: WaPay's note only inside the member's window.
  out.s6 = { turn: await say(R[6], `please pay me R40 for lunch from ${P_OPEN.msisdn}`), links: linksOf(R[6]) };
  out.s7 = { turn: await say(R[7], `please pay me R40 for lunch from ${P_CLOSED.msisdn}`), links: linksOf(R[7]) };

  // 8. my links, remind, cancel, my links again.
  const m1 = await say(R[8], 'please pay me R40 for lunch');
  const m2 = await say(R[8], 'please pay me R30 for taxi');
  out.s8 = { m1, m2, list: await say(R[8], 'my links'), remind: await say(R[8], 'remind 2'), cancel: await say(R[8], 'cancel 1'), list2: await say(R[8], 'my links'), links: linksOf(R[8]), bad: await say(R[8], 'remind 7') };

  // 9. The ad-free change of amount: one message per turn, the new link keeps what the old was for and says it replaces it.
  await say(R[9], 'please pay me R40 for lunch');
  out.s9 = { change: await say(R[9], 'change my amount to R45'), links: linksOf(R[9]) };

  // 10. The Pay agent (pilot list): the tool's description makes the link; without one the flow asks; link commands never reach the model.
  const base = { outcome: 'proposal', toolCalls: [{ name: 'start_pay_link' }], usage: {}, timings: {}, model: 'test' };
  const slots = (amountCents, description) => ({ amountCents, description, msisdn: null, recipientName: null, self: null, meterNumber: null, productQuery: null, category: null, method: null });
  agent.result = { ...base, proposal: { action: 'REQUEST_MONEY', slots: slots(4000, 'school trip') } };
  const a1 = await say(R[10], "can you make me a link of R40, it's my son's school trip");
  const callsAfterFirst = agent.calls;
  agent.result = { ...base, proposal: { action: 'REQUEST_MONEY', slots: slots(3500, null) } };
  const a2 = await say(R[10], 'make a link of R35');
  const a2state = stateOf(R[10]);
  const a3 = await say(R[10], 'bus fare');
  const callsBeforeList = agent.calls;
  const a4 = await say(R[10], 'my links');
  out.s10 = { a1, a2, a2state, a3, a4, callsAfterFirst, callsBeforeList, callsAfterList: agent.calls, links: linksOf(R[10]) };

  // 11. The description step never traps: a question leaves it and is answered as anywhere else; "my links" too.
  const n1 = await say(R[11], 'please pay me R40');
  const n2 = await say(R[11], 'how much does it cost?');
  const n2state = stateOf(R[11]);
  await say(R[11], 'please pay me R40');
  const n3 = await say(R[11], 'my links');
  out.s11 = { n1, n2, n2state, n3, n3state: stateOf(R[11]), links: linksOf(R[11]) };

  // 12 and 13. The ad first link: amount and what it is for in one answer makes the link; an amount alone gets the question.
  out.s12 = { turn: await say(R[12], 'R40 braids'), links: linksOf(R[12]), state: stateOf(R[12]) };
  const q13 = await say(R[13], '40');
  out.s13 = { question: q13, state: stateOf(R[13]), answer: await say(R[13], 'hair'), links: linksOf(R[13]) };

  out.everyone = { requesters: Object.values(R).map((p) => p.waId), payers: [P_OPEN.waId, P_CLOSED.waId], ctaSends: sends.filter((s) => s.kind === 'cta').length };
} catch (error) {
  out.error = String(error?.stack || error);
}
console.log(`RESULT ${JSON.stringify(out)}`);
