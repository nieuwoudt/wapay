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

mock.module('@wapay/whatsapp', {
  namedExports: {
    sendWhatsAppText: async ({ to, text }) => {
      outbox.push({ kind: 'text', to, text });
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
  },
});

// Everything below imports AFTER the mock is installed.
const { processMessage } = await import('../../pages/api/webhooks/message-processor-v2.js');
const { default: prisma } = await import('../../lib/prisma.js');

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
  // The chat sign-up scenario registers a business and asks for a portal
  // code: both rows hang off the account and must go first.
  const businesses = await prisma.business.findMany({ where: { accountId: account.id }, select: { id: true } }).catch(() => []);
  if (businesses.length) {
    await prisma.businessCustomer.deleteMany({ where: { businessId: { in: businesses.map((b) => b.id) } } }).catch(() => {});
    await prisma.business.deleteMany({ where: { accountId: account.id } }).catch(() => {});
  }
  await prisma.otpCode.deleteMany({ where: { accountId: account.id } }).catch(() => {});
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
