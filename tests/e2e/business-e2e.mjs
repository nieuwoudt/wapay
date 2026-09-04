/**
 * WaPay for Business — end-to-end against a REAL Postgres schema, isolated.
 *
 * Runs the portal's domain logic through the real Prisma client (compound
 * uniques, JSON columns, insensitive search, the lazy walk-in linker) and
 * settles two links exactly the way production does (card = ITN-shaped
 * buildLoad with the shared `wapay-payreq-<code>` idemKey; balance =
 * buildSend), then checks every dashboard number that falls out.
 *
 * ZERO production pollution: refuses to run unless DATABASE_URL carries
 * `?schema=wapay_qa_biz_…`. Create the schema first, drop it after:
 *
 *   export SCRATCH="$(grep '^DATABASE_URL' .env | cut -d= -f2- | tr -d '"')?schema=wapay_qa_biz_0904"
 *   DATABASE_URL="$SCRATCH" pnpm exec prisma db push --schema=./packages/domain/prisma/schema.prisma --skip-generate
 *   DATABASE_URL="$SCRATCH" node tests/e2e/business-e2e.mjs            # seed + assert (data stays for browsing)
 *   DATABASE_URL="$SCRATCH" node tests/e2e/business-e2e.mjs --teardown # DROP SCHEMA … CASCADE
 *
 * Nothing reaches a phone: sends are captured stubs.
 */

import assert from 'node:assert/strict';

const RAW = process.env.DATABASE_URL || '';
const SCHEMA = RAW.match(/schema=(wapay_qa_biz_[a-z0-9_]+)/)?.[1];
if (!SCHEMA) {
  console.error('FATAL: DATABASE_URL must point at an isolated scratch schema (?schema=wapay_qa_biz_...)');
  process.exit(2);
}
process.env.WAPAY_BUSINESS_SESSION_SECRET = process.env.WAPAY_BUSINESS_SESSION_SECRET || 'e2e-business-secret-0123456789';
process.env.WAPAY_INTERNAL_API_KEY = process.env.WAPAY_INTERNAL_API_KEY || 'e2e-internal-key';

const prisma = (await import('../../lib/prisma.js')).default;
const { createBusiness, upsertCustomer, importCustomers, parseContactsImport, createBusinessLink, listCustomersWithStats, getCustomerProfile, businessOverview, linkWalkInPayers, exportLinksCsv, listBusinessLinks } = await import('../../lib/business.js');
const { hashBusinessPassword, verifyBusinessPassword, requestBusinessOtpInSession, verifyBusinessOtp, verifyBusinessToken } = await import('../../lib/business-auth.js');
const { markRequestPaid, getPaymentRequest } = await import('../../lib/payment-requests.js');
const { paymentRequestFeeCents } = await import('../../lib/deposits.js');
const { postEntry, ensureWallet } = await import('../../lib/ledger-post.js');
const { buildLoad, buildSend, RAIL } = await import('../../lib/ledger-core.js');
const { deliverRequestPaidNotifications } = await import('../../lib/request-notify.js');

const OWNER = { waId: '27600000911', msisdn: '0600000911', displayName: 'Lerato (QA owner)' };
const PAYER = { waId: '27600000912', msisdn: '0600000912', displayName: 'Thabo (QA payer)' };
const PASSWORD = 'laundry-portal-2026';
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.log(`✔ ${name}`); } catch (e) { results.push(['FAIL', name, e.message]); console.log(`✖ ${name}\n   ${e.message}`); }
};

if (process.argv.includes('--teardown')) {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  console.log(`dropped schema ${SCHEMA}`);
  await prisma.$disconnect();
  process.exit(0);
}

let owner, payer, business, thabo, links = {};

await step('seed: owner + payer accounts with SPEND wallets (idempotent)', async () => {
  owner = await prisma.account.upsert({ where: { waId: OWNER.waId }, update: {}, create: { ...OWNER, onboardingState: 'S5_COMPLETED', onboardingStatus: 'COMPLETED' } });
  payer = await prisma.account.upsert({ where: { waId: PAYER.waId }, update: {}, create: { ...PAYER, onboardingState: 'S5_COMPLETED', onboardingStatus: 'COMPLETED' } });
  await ensureWallet({ accountId: owner.id });
  await ensureWallet({ accountId: payer.id });
  // Fund the payer so the balance leg can settle: a QA Blu-style load.
  await postEntry(buildLoad({ accountId: payer.id, rail: RAIL.BLU, faceCents: 50000, idemKey: `wapay-e2e-biz-fund-${payer.id}` }));
});

await step('register: business created for the owner, password set and verified, OTP in-session path works', async () => {
  business = await prisma.business.findUnique({ where: { accountId: owner.id } });
  if (!business) business = await createBusiness({ accountId: owner.id, name: 'I Love My Laundry', category: 'Laundry', passwordHash: await hashBusinessPassword(PASSWORD) });
  else business = await prisma.business.update({ where: { id: business.id }, data: { passwordHash: await hashBusinessPassword(PASSWORD) } });
  const pw = await verifyBusinessPassword({ msisdn: OWNER.msisdn, password: PASSWORD });
  assert.equal(pw.ok, true, 'password login');
  assert.equal(verifyBusinessToken(pw.token).businessId, business.id);
  const code = await requestBusinessOtpInSession({ msisdn: OWNER.msisdn });
  assert.equal(code.ok, true); assert.equal(code.hasBusiness, true);
  const v = await verifyBusinessOtp({ msisdn: OWNER.msisdn, code: code.code });
  assert.equal(v.ok, true); assert.ok(v.token, 'OTP mints a session for an existing business');
  await assert.rejects(() => createBusiness({ accountId: owner.id, name: 'Second Shop' }), /unique|Unique/i, 'one business per account (DB unique)');
});

await step('customers: manual add, import (CSV + vCard), compound unique upsert, insensitive search', async () => {
  thabo = (await upsertCustomer({ prisma, businessId: business.id, msisdn: PAYER.msisdn, name: 'Thabo Nkosi', tags: ['regular'] })).customer;
  const rows = parseContactsImport('name,phone\nLerato Mokoena, 082 555 1234\nBEGIN:VCARD\nFN:Zanele Dube\nTEL:0713334444\nEND:VCARD');
  const imp = await importCustomers({ prisma, businessId: business.id, rows });
  assert.ok(imp.added + imp.updated + imp.skipped >= 1);
  const again = await upsertCustomer({ prisma, businessId: business.id, msisdn: '+27 82 555 1234', name: '' });
  assert.equal(again.created, false, 'same number normalises to the same row');
  const { customers } = await listCustomersWithStats({ prisma, businessId: business.id, q: 'THABO' });
  assert.equal(customers.length, 1); assert.equal(customers[0].name, 'Thabo Nkosi');
});

await step('links: itemised link for Thabo, walk-in link, list + fee quote', async () => {
  links.thabo = await createBusinessLink({ prisma, business, customerId: thabo.id, items: [{ name: 'Wash & fold 5kg', qty: 1, unitCents: 12000 }, { name: 'Ironing', qty: 3, unitCents: 1000 }], reference: `T-${Date.now().toString(36).toUpperCase()}` });
  assert.equal(links.thabo.link.amountCents, 15000); assert.match(links.thabo.waLink, /^https:\/\/wa\.me\/27600000912\?text=/);
  links.walkIn = await createBusinessLink({ prisma, business, amountCents: 2500, reference: 'WALK-IN' });
  links.open = await createBusinessLink({ prisma, business, customerId: thabo.id, items: [{ name: 'Duvet', qty: 1, unitCents: 8000 }] });
  const open = await listBusinessLinks({ prisma, businessId: business.id, status: 'open' });
  assert.ok(open.total >= 3);
  const stored = await getPaymentRequest({ code: links.thabo.link.code });
  assert.equal(stored.businessId, business.id); assert.equal(stored.items.length, 2, 'JSON items round-trip');
});

await step('settle: card payment ITN-shaped (shared idemKey) + balance payment via buildSend; requests flip PAID exactly once', async () => {
  // Card leg exactly as pages/api/payfast/itn.js posts it.
  const code = links.thabo.link.code;
  const fee = paymentRequestFeeCents(15000);
  await prisma.providerRequest.upsert({
    where: { idemKey: `wapay-payreq-${code}` },
    update: {},
    create: { id: `pfreq-${code}`, provider: 'PAYFAST', route: 'payrequest', idemKey: `wapay-payreq-${code}`, status: 'SUCCESS', providerRef: 'PF-E2E-1', accountId: owner.id, metadata: { accountId: owner.id, waId: owner.waId, amountCents: 15000 - fee, feeCents: fee, grossCents: 15000, requestCode: code, payerMsisdn: PAYER.msisdn } },
  });
  const posted = await postEntry(buildLoad({ accountId: owner.id, rail: RAIL.PAYFAST, faceCents: 15000 - fee, customerFeeCents: fee, idemKey: `wapay-payreq-${code}` }));
  assert.equal(posted.replayed, false);
  assert.equal(await markRequestPaid({ code, payerRef: 'PAYFAST:PF-E2E-1' }), true);
  assert.equal(await markRequestPaid({ code, payerRef: 'PAYFAST:dup' }), false, 'exactly once');
  // Balance leg for the walk-in link: the payer pays from their WaPay balance.
  const w = links.walkIn.link.code;
  const sent = await postEntry(buildSend({ fromAccountId: payer.id, toAccountId: owner.id, amountCents: 2500, idemKey: `wapay-payreq-${w}` }));
  assert.equal(sent.replayed, false);
  assert.equal(await markRequestPaid({ code: w, payerRef: `WAPAY:${payer.id}` }), true);
  const wallet = await prisma.wallet.findFirst({ where: { accountId: owner.id, balanceType: 'SPEND' } });
  assert.ok(wallet.availableCents >= 15000 - fee + 2500, `owner wallet credited (${wallet.availableCents})`);
});

await step('notify: the owner\'s PAID message names the customer and the reference', async () => {
  const sends = [];
  const out = await deliverRequestPaidNotifications({ code: links.thabo.link.code, send: { text: async (a) => { sends.push(a); return { ok: true }; }, template: async () => ({ ok: false }), direct: async () => ({ ok: false }) } });
  assert.equal(out.requester, 'sent');
  const ownerMsg = sends.find((s) => s.to === owner.waId);
  assert.match(ownerMsg.text, /PAID/); assert.match(ownerMsg.text, /from Thabo Nkosi · ref T-/);
});

await step('walk-in linker: the balance payer becomes a customer (source PAYLINK, accountId set) and the link points at them', async () => {
  const out = await linkWalkInPayers({ prisma, businessId: business.id });
  assert.ok(out.linked >= 1 || (await prisma.paymentRequest.findUnique({ where: { id: links.walkIn.link.code } })).customerId, 'linked now or earlier');
  const row = await prisma.paymentRequest.findUnique({ where: { id: links.walkIn.link.code } });
  assert.equal(row.customerId, thabo.id, 'payer number == Thabo, so the existing customer is reused');
  const c = await prisma.businessCustomer.findUnique({ where: { id: thabo.id } });
  assert.equal(c.accountId, payer.id, 'WaPay account linked to the customer');
});

await step('dashboard: overview, customer profile and CSV all derive the same truth', async () => {
  const o = await businessOverview({ prisma, businessId: business.id, rangeDays: 30 });
  const fee = paymentRequestFeeCents(15000);
  assert.ok(o.vitals.paidCents >= 17500, `paid ${o.vitals.paidCents}`);
  assert.ok(o.vitals.feeCents >= fee); assert.ok(o.methods.card.count >= 1 && o.methods.wapay.count >= 1);
  assert.ok(o.vitals.outstandingCount >= 1, 'the duvet link is still open');
  assert.equal(o.monthly.length, 12); assert.ok(o.totals.last3mCents >= o.vitals.paidCents);
  assert.ok(o.topCustomers.some((c) => c.name === 'Thabo Nkosi'));
  const p = await getCustomerProfile({ prisma, businessId: business.id, customerId: thabo.id });
  assert.ok(p.stats.paidCents >= 17500); assert.ok(p.stats.openCents >= 8000); assert.ok(p.topItems.some((i) => i.name === 'Wash & fold 5kg'));
  const csv = await exportLinksCsv({ prisma, businessId: business.id, sinceDays: 30 });
  assert.match(csv, /,PAID,CARD,Thabo Nkosi,0600000912,T-/); assert.match(csv, /,PAID,WAPAY,Thabo Nkosi,/);
});

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} PASS · schema ${SCHEMA} · business ${business?.id} · owner ${OWNER.msisdn} · password ${PASSWORD}`);
await prisma.$disconnect();
process.exit(failed.length ? 1 : 0);
