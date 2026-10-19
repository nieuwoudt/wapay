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

test('the processor remembers both button cards and explains an out-of-range request amount', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /import \{ rememberSent \} from '\.\.\/\.\.\/\.\.\/lib\/say\.js';/);
  assert.match(p, /buttonText: 'View my payment page',\s*url,\s*\}\);\s*if \(interactive\?\.ok\) \{\s*\/\/[^\n]*\n\s*await rememberSent\(\{ to: from, text: `🙏 \*\$\{randsShort\(amountCents\)\} requested\*/);
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
  assert.match(page, /function PathChart\(\{ daily, t \}\)/); assert.match(page, /Math\.log10/, 'the path is on a log scale');
  assert.match(page, /function ValuationPath\(\{ t \}\)/); assert.match(page, /simulate\(preset\('plan'\), budgetFn\(BUDGET_DEFAULT\)\)\.rows\.slice\(0, 13\)/);
  assert.match(page, /<PathChart daily=\{g\.daily\} t=\{t\} \/>/); assert.match(page, /<ValuationPath t=\{t\} \/>/);
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
