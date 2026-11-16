/**
 * CHANGELOG 97 (2026-10-19): payment links as the key figure and the viral loop,
 * the path and valuation charts, the ten-minute refresh, the reply box, the flags
 * readout, and the two fixes from the first conversation audit (BUGLOG #120, #121).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rememberSent, configureSay } from '../lib/say.js';
import { grossedUpRequestCents, paymentRequestFeeCents } from '../lib/deposits.js';
import { isFirstLinkExample, looksLikeNobodyOwesMe, EXAMPLE_ECHO_REPLY, NOBODY_OWES_ME_REPLY, copyViolations } from '../lib/ad-flow.js';
import { matchCloseAccountAsk, closeAccountReply, closeAccountAlert } from '../lib/account-closure.js';
import { sendToSelfText, SEND_TO_SELF_TEXT } from '../lib/payout-gate.js';
import { addMoneyLinkLabel } from '../lib/money-situation.js';
import { businessQuestionEnabled } from '../lib/business-chat.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

function stubPrisma() {
  const calls = { create: [] };
  return {
    calls,
    account: { findFirst: async () => ({ id: 'acc_1' }), findUnique: async () => ({ id: 'acc_1' }) },
    conversationTurn: { create: async ({ data }) => { calls.create.push({ data }); return { id: 't1', ...data }; } },
  };
}

test('BUGLOG #120: a button message the chat sent is remembered as the assistant turn; nothing recorded without text or an account', async () => {
  const prisma = stubPrisma();
  configureSay({ transport: async () => ({ ok: true }), prisma });
  assert.equal(await rememberSent({ to: '27821234567', text: '💳 Add money to WaPay\n\nR100 deposit + R6.50 payment fee = *R106.50*\n\n[button: Pay R106.50 now]', waMessageId: 'wamid.cta.1', refs: { deposit: 'dep_1' } }), true);
  assert.equal(prisma.calls.create.length, 1);
  const d = prisma.calls.create[0].data;
  assert.equal(d.accountId, 'acc_1'); assert.equal(d.role, 'assistant'); assert.equal(d.kind, 'flow'); assert.equal(d.waMessageId, 'wamid.cta.1'); assert.match(d.text, /\[button: Pay R106\.50 now\]/);
  assert.equal(await rememberSent({ to: '27821234567', text: '' }), false);
  const none = stubPrisma(); none.account.findFirst = async () => null; none.account.findUnique = async () => null;
  configureSay({ transport: async () => ({ ok: true }), prisma: none });
  assert.equal(await rememberSent({ to: '27800000000', text: 'x' }), false);
  assert.equal(none.calls.create.length, 0);
  configureSay({ transport: null, prisma: null });
});

test('the processor remembers the deposit button card and the link message, and explains an out-of-range request amount', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /import \{ rememberSent \} from '\.\.\/\.\.\/\.\.\/lib\/say\.js';/);
  // 2026-10-24 (founder: one message the customer can forward): a new link is ONE plain text through say(), which
  // remembers it with the link as its reference by construction (BUGLOG #120); no button card, so no rememberSent.
  const created = p.slice(p.indexOf('async function handleCreatePaymentRequest('), p.indexOf('async function tapToSendTarget('));
  assert.ok(!/sendWhatsAppCtaUrl|buttonText|rememberSent/.test(created), 'no button card for a link');
  assert.match(created, /await sendCreatedLink\(\{\s*send: sendWhatsAppText,/);
  assert.match(p, /import \{ sendWhatsAppText, recordInbound \} from '\.\.\/\.\.\/\.\.\/lib\/say\.js';/, 'the remembering transport');
  assert.match(read('../lib/pay-links.js'), /await deps\.send\(\{ to, text: msg\.text, kind, refs: \{ request: request\.id \}/);
  assert.match(p, /url: checkoutUrl,\s*\}\);\s*\/\/[^\n]*\n\s*if \(interactive\?\.ok\) await rememberSent\(\{ to: from, text: `💳 Add money to WaPay[^\n]*\n\s*if \(interactive\?\.ok\) return interactive;/);
  // BUGLOG #121
  assert.match(p, /is more than one payment link can carry\. A link can be for R5 up to \$\{randsShort\(MAX_REQUEST_CENTS\)\}\. Ask for \$\{randsShort\(MAX_REQUEST_CENTS\)\} now and make another link for the rest, or tell me a smaller amount\./);
  assert.match(p, /A payment link starts at R5\. \$\{randsShort\(amountCents\)\} is below that/);
  assert.match(p, /reason\s*\? `🙏 \$\{reason\}\\n\\nReply with the amount, for example "R150", or "cancel" to stop\.`/);
});

test('metrics: payment links as the key figure and the viral loop, with the rail costs of record', () => {
  const m = read('../pages/api/admin/metrics.js');
  assert.match(m, /const PAYSHAP_FEE_CENTS = cashoutFeeCents\('PAYSHAP', 10000\);/);
  assert.match(m, /const PAYSHAP_RAIL_COST_CENTS = 288;/);
  assert.match(m, /const cardCost = \(c\) => Math\.round\(\(Number\(c\) \* 0\.032 \+ 200\) \* 1\.15\);/);
  for (const k of ['created:', 'createdInRange:', 'paid: { n: paid.length', 'open: { n: open.length', 'lapsed:', 'feeRealisedCents:', 'ifOpenPaidByCard:', 'ifThenPaidOut:', 'paidRatePct:']) assert.ok(m.includes(k), k);
  assert.match(m, /"profile"->>'acquisitionSource' = 'paylink'/);
  assert.match(m, /links,\s*viral: viral \? \{ \.\.\.viral, payersCapturedNotYetOnWaPay: capturedPayers \?\? null, shareOfAccountsPct:/);
  assert.match(m, /String\(r\.payerRef \|\| ''\)\.startsWith\('WAPAY:'\)/, 'paid from a balance is a WAPAY: payer reference');
});

test('Mission Control: the links card, the path and valuation charts, the ten-minute refresh, the reply box', () => {
  const page = read('../pages/admin/index.js');
  assert.match(page, /const REFRESH_MS = 10 \* 60 \* 1000;/);
  assert.match(page, /useEffect\(\(\) => \{ const id = setInterval\(\(\) => setTick\(\(t\) => t \+ 1\), REFRESH_MS\); return \(\) => clearInterval\(id\); \}, \[\]\);/);
  assert.match(page, /useEffect\(\(\) => \{ const id = setInterval\(\(\) => load\(true\), REFRESH_MS\); return \(\) => clearInterval\(id\); \}, \[load\]\);/);
  assert.match(page, /<LinksAndLoop links=\{m\.links\} viral=\{m\.viral\} generatedAt=\{m\.generatedAt\} \/>/);
  assert.match(page, /\['Payment links created', R\(l\.created\.cents\)/);
  assert.match(page, /\['If every open link is paid by card', R\(l\.ifOpenPaidByCard\.feeCents\)/);
  assert.match(page, /\['If each is then paid out by PayShap', R\(l\.ifThenPaidOut\.feeCents\)/);
  assert.match(page, /\['Accounts from payment links', n0\(vl\.accountsFromLinks\)/);
  // 2026-10-20: the charts moved to lib/admin-charts.js as interactive recharts components; the page imports them.
  const charts = read('../lib/admin-charts.js');
  assert.match(page, /import \{ Bars, WeeklyFlows, TakeRate, StackBars, DailyBars, DailyLines, PathChart, ValuationPath \} from '\.\.\/\.\.\/lib\/admin-charts\.js';/);
  assert.match(charts, /export function PathChart\(\{ series, t, h = \d+ \}\)/); assert.ok(!/Math\.log10/.test(charts), 'the path is linear and all time now');
  assert.match(charts, /export function ValuationPath\(\{ t, v, h = \d+ \}\)/); assert.match(charts, /simulate\(preset\('plan'\), budgetFn\(BUDGET_DEFAULT\)\)\.rows\.slice\(0, 13\)/); assert.match(charts, /simulate\(\{ \.\.\.preset\('plan'\), \.\.\.measuredInputs \}, budgetFn\(BUDGET_DEFAULT\)\)/, 'the measured-inputs curve runs the same model');
  assert.match(charts, /<Tooltip /); assert.match(charts, /ResponsiveContainer/); assert.match(page, /@media\(max-width:700px\)/, 'phone-width rules');
  assert.match(page, /<PathChart series=\{g\.pathSeries\} t=\{t\} \/>/); assert.match(page, /<ValuationPath t=\{t\} v=\{v\} \/>/); assert.match(page, /<InsightBox v=\{v\} t=\{t\} \/>/);
  assert.match(page, /function ReplyBox\(\{ accountId, name \}\)/); assert.match(page, /fetch\('\/api\/admin\/ops-reply', \{ method: 'POST'/);
  assert.match(page, /<ReplyBox accountId=\{c\.account\.id\} name=\{c\.account\.displayName\} \/>/);
  assert.match(page, /slice\(0, 1500\)/, 'the box caps at the route limit');
});

test('the admin reply route and the flags readout are guarded and read the same code as the chat', () => {
  const r = read('../pages/api/admin/ops-reply.js');
  assert.match(r, /const auth = requireAdmin\(req\);\s*if \(!auth\.ok\) return res\.status\(401\)/);
  assert.match(r, /opsReply\(\{ prisma, send: sendWhatsAppText, accountId: req\.body\?\.accountId, text: req\.body\?\.text, force: String\(req\.query\?\.force\) === '1' \}\)/);
  const f = read('../pages/api/internal/flags.js');
  assert.match(f, /if \(!requireInternalAuth\(req, res\)\) return;/);
  assert.match(f, /businessQuestion: \{ enabled: businessQuestionEnabled\(\)/);
  assert.match(f, /launchHold: launchHold\(\)/); assert.match(f, /withdrawLive: payoutLive\(\)/); assert.match(f, /opsAlertRecipients: opsAlertRecipients\(\)\.length/);
  assert.ok(!/process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)/.test(f), 'never a secret in the readout');
});

// ---------------------------------------------------------------- the first conversation audit (2026-10-19)

test('BUGLOG #123: the gross-up always nets what was asked; at the link ceiling the caller gets a number above it, never a short one', () => {
  for (const want of [15000, 25000, 50000, 100000, 299000, 300000]) {
    const ask = grossedUpRequestCents(want);
    assert.ok(ask - paymentRequestFeeCents(ask) >= want, `R${want / 100}: R${ask / 100} nets R${(ask - paymentRequestFeeCents(ask)) / 100}`);
  }
  assert.ok(grossedUpRequestCents(300000) > 300000, 'R3000 cannot be grossed up inside the R3000 maximum');
  assert.equal(grossedUpRequestCents(15000), 15900);
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /const askCents = grossCents <= MAX_REQUEST_CENTS \? grossCents : null;/);
  assert.match(p, /The most a link can carry is \$\{randsShort\(MAX_REQUEST_CENTS\)\}, so the card fee cannot be added on top at this amount\./);
  assert.match(p, /const two = !!data\.askCents && \(/);
});

test('BUGLOG #124: a link made minutes ago is not minted twice, and its grossed-up amount replaces it instead of compounding', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /const recent = await latestPendingLink\(\{ accountId: account\.id \}\)\.catch\(\(\) => null\);/);
  assert.match(p, /if \(recent\.amountCents === amountCents\) \{[\s\S]{0,400}That link is already live for/);
  assert.match(p, /grossedUpRequestCents\(recent\.amountCents\) === amountCents\) \{\s*const cancelled = await cancelPendingLink\(\{ code: recent\.id, accountId: account\.id \}\)/);
  // One message (2026-10-24): the replacement is made in the same turn and says it replaces the old link; no separate cancel line.
  assert.match(p, /confirmed: true, adPayerName, note: describedAs \|\| recent\.note \|\| null, payer: payerTarget, replacedCents: cancelled \? recent\.amountCents : null, replacedNow: cancelled \}\);/);
  assert.ok(!/I cancelled your \$\{randsShort\(recent\.amountCents\)\} link and made/.test(p), 'the old second message is gone');
  const f = p.slice(p.indexOf('async function handleCreatePaymentRequest('));
  assert.ok(f.indexOf('const recent = await latestPendingLink') < f.indexOf('EVERY LINK SAYS WHAT IT IS FOR'), 'the recent link is checked before the description is asked for');
  assert.ok(f.indexOf('EVERY LINK SAYS WHAT IT IS FOR') < f.indexOf('// CONFIRM BEFORE CREATE'), 'the description is settled before the fee choice');
});

test('BUGLOG #125: "close my account" is matched plainly, answered once without a fake step, and raises the person alert', () => {
  for (const t of ['Close account', 'close my account', 'please delete my WaPay account', 'I want to deactivate my account', 'cancel my account', 'account closure', 'delete my profile']) assert.equal(matchCloseAccountAsk(t), true, t);
  for (const t of ['open my account', 'cancel', 'cancel link', 'my account balance', 'close', 'account', 'how do I close a link', 'create account']) assert.equal(matchCloseAccountAsk(t), false, t);
  for (const r of [closeAccountReply({ alerted: true }), closeAccountReply({ alerted: false })]) {
    assert.ok(!/secure|final step|button|form|link below/i.test(r), r);
    assert.match(r, /a person from the WaPay team does it/); assert.match(r, /Your balance stays yours/); assert.ok(!/[—–]/.test(r));
  }
  assert.match(closeAccountReply({ alerted: true }), /they have been asked now/); assert.ok(!/have been asked/.test(closeAccountReply({ alerted: false })), 'no claim when no alert went');
  const a = closeAccountAlert({ account: { id: 'acc_9', waId: '27601879361', displayName: 'Lisa' }, balanceCents: 1250 });
  assert.match(a.text, /^🗂️ Lisa asked to close their WaPay account\.\nAccount acc_9, WhatsApp •••9361, display name Lisa\. Balance: R12\.50\./); assert.ok(!/27601879361/.test(a.text));
  assert.match(a.subject, /^Lisa asked to close their account$/);
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /if \(matchCloseAccountAsk\(text\)\) return await handleCloseAccountAsk\(\{ from, account \}\);/);
  assert.match(p, /opsPersonAlert\(\{ text: alert\.text, key: `close:\$\{account\.id\}:\$\{day\}` \}\)/);
  assert.match(read('../packages/ai/src/orchestrator.ts'), /Closing an account: a person from the WaPay team does it after the customer asks in chat; never describe a step, a form or a "secure final step"\./);
});

test('BUGLOG #126: the example typed back and "nobody owes me" get answers, not a link or the same prompt', () => {
  for (const t of ['R250 from Thandi for the birthday gift', 'r250 from thandi for the birthday gift', 'R250 from Thandi for the birthday gift.', ' R250  from Thandi for the birthday gift ']) assert.equal(isFirstLinkExample(t), true, t);
  for (const t of ['R250 from Thandi', 'R120 from Sipho for the taxi', 'R250 from Thandi for the birthday gift and the cake', '']) assert.equal(isFirstLinkExample(t), false, t);
  for (const t of ['Nobody owes me', 'no one owes me money', 'But I dont know who owes me', 'who must pay me this', 'You put money first or?', 'I need money now', 'do you give me money', 'where does the money come from']) assert.equal(looksLikeNobodyOwesMe(t), true, t);
  for (const t of ['R250 from Thandi', 'please pay me R50', 'my mother owes me R200', 'how much does it cost', 'withdraw R50', 'yes']) assert.equal(looksLikeNobodyOwesMe(t), false, t);
  for (const r of [EXAMPLE_ECHO_REPLY, NOBODY_OWES_ME_REPLY]) { assert.deepEqual(copyViolations(r), [], r); assert.ok(r.length <= 460); }
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /if \(isFirstLinkExample\(text\)\) return await sendWhatsAppText\(\{ to: from, text: EXAMPLE_ECHO_REPLY, kind: 'ad' \}\);/);
  assert.match(p, /if \(isFirstLinkExample\(rawText\)\) \{/);
  assert.equal((p.match(/looksLikeNobodyOwesMe\(text\)/g) || []).length, 2, 'the first-link state and the amount step');
  assert.match(p, /if \(faq === 'FAQ_PAY_SOMEONE' && !adLooksLikeQuestion\(text\)\) \{\s*\/\/[^\n]*\n\s*await updateConversationState\(from, null\);\s*return await handlePostOnboarding\(\{ account, from, text \}\);/, 'a tapped Send Money starts the flow');
});

test('BUGLOG #122 and #127: the send flow speaks balance, the own-number refusal follows the voucher switch, an add-money link is named as one', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.ok(!/They'll get a WaPay voucher they can spend online|Confirm WaPay Voucher|WaPay Voucher\*\\n\\nWhich number/.test(p), 'no voucher wording on the send path');
  assert.match(p, /💸 \*Confirm send\*/); assert.match(p, /A send must be between R10 and R1000\./);
  assert.equal((p.match(/sendToSelfText\(\{ voucherLive: isRailLiveFor\('OTT_VOUCHER', from\) \}\)/g) || []).length, 2);
  assert.equal(sendToSelfText({ voucherLive: true }), SEND_TO_SELF_TEXT);
  assert.ok(!/buy a voucher/.test(sendToSelfText({ voucherLive: false }))); assert.match(sendToSelfText({ voucherLive: false }), /say \*withdraw\*\.$/);
  assert.equal(addMoneyLinkLabel({ amountCents: 35000, grossCents: 36700 }), 'R350 add-money link (R367 with the card fee)');
  assert.equal(addMoneyLinkLabel({ amountCents: 5000, grossCents: 5000 }), 'R50 add-money link');
  assert.equal(addMoneyLinkLabel({ grossCents: 21100 }), 'R211 add-money link');
});

test('the business question asks only on the unambiguous value; the flags readout shows what production reads', () => {
  assert.equal(businessQuestionEnabled({ WAPAY_ONBOARDING_BUSINESS_QUESTION: 'on' }), false, '"on" was set to mean the removal is on');
  assert.equal(businessQuestionEnabled({ WAPAY_ONBOARDING_BUSINESS_QUESTION: 'ask' }), true);
  assert.match(read('../pages/api/internal/flags.js'), /raw: env\.WAPAY_ONBOARDING_BUSINESS_QUESTION == null \? null : String\(env\.WAPAY_ONBOARDING_BUSINESS_QUESTION\)/);
});
