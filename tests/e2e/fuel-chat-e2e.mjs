/**
 * Chat-level E2E of the fuel flow (v1.3 Task 3): drives the REAL
 * processMessage through "buy fuel" → amount → YES → PIN → wiCode
 * delivered in-session, plus the coming-soon gate with the flag off.
 *
 * REQUIREMENTS:
 *  - DATABASE_URL on the scratch schema (…?schema=wapay_qa_e2e_v13)
 *  - tests/e2e/fuel-e2e.mjs run first (seeds account 27600000902, PIN 1934)
 *  - WaPay dev server on localhost:3400 with the same scratch env
 *  - UniFuel dev server on localhost:3300 (Yoyo TEST)
 *  - --experimental-test-module-mocks (WhatsApp captured, nothing sent)
 */
import { mock } from 'node:test';

if (!/schema=wapay_qa_e2e_v13/.test(process.env.DATABASE_URL || '')) {
  console.error('FATAL: DATABASE_URL must point at the scratch schema');
  process.exit(2);
}
process.env.APP_BASE_URL = 'http://localhost:3400';
process.env.WAPAY_INTERNAL_API_KEY = 'e2e-internal-key';
process.env.WAPAY_WICODE_LIVE = 'true';
process.env.UNIFUEL_API_BASE_URL = 'http://localhost:3300';
process.env.UNIFUEL_PARTNER_SECRET = 'wapay-e2e-secret-491a1a32';

const outbox = [];
mock.module('@wapay/whatsapp', {
  namedExports: {
    sendWhatsAppText: async ({ to, text }) => { outbox.push({ to, text }); return { ok: true }; },
    sendWhatsAppTemplate: async ({ to, name }) => { outbox.push({ to, text: `[template:${name}]` }); return { ok: true }; },
    sendWhatsAppCtaUrl: async ({ to, bodyText, url }) => { outbox.push({ to, text: `${bodyText}\n[button -> ${url}]` }); return { ok: true }; },
    seedWhatsappTemplates: async () => ({}),
    buildCatalog: async () => ({}),
  },
});

const { default: prisma } = await import('../../lib/prisma.js');
const { processMessage } = await import('../../pages/api/webhooks/message-processor-v2.js');

const MSISDN = '27600000902';
const PIN = '1934';
let pass = 0, fail = 0, turn = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ✅ ${what}`); } else { fail++; console.log(`  ❌ ${what}`); } };

async function say(text) {
  const before = outbox.length;
  await processMessage({ from: MSISDN, text, messageId: `fuelchat-${process.pid}-${++turn}` });
  const replies = outbox.slice(before).filter((m) => m.to === MSISDN);
  const replyText = replies.map((m) => m.text).join('\n···\n');
  console.log(`   [user] ${text}\n   [bot]  ${replyText.split('\n')[0].slice(0, 90)}…`);
  return replyText;
}

const wallet = async () => {
  const acct = await prisma.account.findFirst({ where: { waId: MSISDN } });
  return prisma.wallet.findFirst({ where: { accountId: acct.id, balanceType: 'SPEND' } });
};

// --- leg A: coming-soon while the flag is off (in-process flip) ---
console.log('LEG A: coming-soon gate');
process.env.WAPAY_WICODE_LIVE = 'false';
{
  // Both the raw flag map AND the derived config are computed at import
  // time — flip both for this in-process leg (prod flips via env+deploy).
  const { VAS_LIVE, VAS_CATEGORY_CONFIG } = await import('../../lib/vas-config.js');
  VAS_LIVE.FUEL = false;
  VAS_CATEGORY_CONFIG.FUEL.enabled = false;
  const a = await say('buy fuel');
  ok(/coming/i.test(a), 'flag off: "buy fuel" gets the coming-soon reply');
  const home = await say('hi');
  ok(/Fuel vouchers\*?: coming soon/i.test(home), 'home screen teases fuel as coming soon');
  // The same turn may legitimately deliver a leftover claimable wiCode from
  // the money E2E — only the purchase FLOW must not start.
  ok(!/Confirm Fuel Voucher|Enter Your PIN|How much fuel/i.test(a), 'flag off: no purchase flow starts');
  VAS_LIVE.FUEL = true;
  VAS_CATEGORY_CONFIG.FUEL.enabled = true;
}
process.env.WAPAY_WICODE_LIVE = 'true';

// --- leg A2: pilot allowlist narrows liveness per user ---
console.log('LEG A2: pilot allowlist');
{
  process.env.VAS_ALLOWLIST_FUEL = '27999999999'; // someone else
  const a = await say('buy fuel');
  ok(/coming/i.test(a), 'flag on but not allowlisted: coming-soon');
  process.env.VAS_ALLOWLIST_FUEL = MSISDN; // the pilot user
  const b = await say('hi');
  ok(/⛽ \*Fuel\*/.test(b), 'home screen shows the live fuel line for the pilot');
  const c = await say('buy fuel');
  ok(/how much fuel/i.test(c), 'allowlisted: the flow opens');
  await say('cancel');
  delete process.env.VAS_ALLOWLIST_FUEL; // open for the rest of the run
}

// --- leg B: the full purchase in chat ---
console.log('LEG B: buy fuel end-to-end in chat');
const w0 = await wallet();
const a = await say('buy fuel');
ok(/how much fuel/i.test(a), 'amount ask opens');
const b = await say('R50');
ok(/confirm fuel voucher/i.test(b), 'confirm step reached');
ok(/participating shell and engen/i.test(b), 'confirm names participating stations');
const c = await say('yes');
ok(/enter your pin/i.test(c), 'PIN gate reached');
const d = await say(PIN);
ok(/fuel voucher purchased/i.test(d), 'receipt sent');
ok(/UniFuel voucher code:\s*\d{6,}/i.test(d), 'UniFuel voucher code delivered in-session');
ok(/participating station/i.test(d), 'redemption guide travels with the code');
const w1 = await wallet();
ok(w1.availableCents === w0.availableCents - 5000, `wallet debited R50 (${w0.availableCents} -> ${w1.availableCents})`);

// --- leg C: escape + cancel hygiene ---
console.log('LEG C: flow hygiene');
const e = await say('buy fuel');
ok(/how much fuel/i.test(e), 'amount ask again');
const f = await say('cancel');
ok(/cancelled/i.test(f), 'cancel exits cleanly');

// --- leg D: "my vouchers" lists the fuel voucher ---
const g = await say('my vouchers');
ok(/R\s?50|50\.00/.test(g), 'voucher history shows the purchase');

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
