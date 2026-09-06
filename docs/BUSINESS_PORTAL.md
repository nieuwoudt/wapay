# WaPay for Business — the business portal

*Built 2026-09-04 from the founder's brief (`docs/prompting/prompts/2026-09-04-wapay-for-business.md`). Design partner: a local laundry that runs on WhatsApp and today reconciles every customer's payment links by hand. Status: **built, env-gated, verified on an isolated schema; not yet activated in production.***

## 1. What it is

A business is a WaPay account wearing a hat. The owner signs in to `/business` with the WhatsApp number of their WaPay wallet, names the business, keeps a customer list, and sends each customer a "please pay me" link for what they bought. Every payment lands in the owner's SPEND wallet through the ordinary payment-request rail (same pay page, same PayFast ITN, same in-chat balance pay, same receiver-pays fee, free under R50). The portal then answers, per customer and per business, who paid what, what is outstanding, and what the revenue was by month over 3, 6 and 12 months. It exports a CSV so nothing is reconciled by hand again.

Tabs: **Overview** (KPIs, 12-month revenue bars, 3/6/12-month totals, card-vs-balance split, outstanding, recent, top customers) · **Customers** (list with derived spend, add, import, profile with 12-month spend, what they buy, every link) · **Payment links** (the POS composer: customer picker, line items with a recent-items memory, reference, note, expiry, live fee/net quote; result card with the link, the ready message, "Send on WhatsApp", copy; link ledger with copy/cancel; CSV export) · **Settings** (name, category, default expiry, password).

## 2. How a link reaches the customer (the cross-user rule)

The default and only unconditional path is the **business owner's own WhatsApp**: the portal builds a `wa.me/<customer>?text=<message>` deep link with the message prefilled, the owner taps send, and the message arrives from the business, not from WaPay. No template, no 24-hour window, no Meta policy exposure, and no way for a business to make WaPay message a stranger.

A WaPay-originated push ("Also send from WaPay") exists but is **off by default** (`WAPAY_BUSINESS_NOTIFY=true` to enable) and, even then, is allowed only on a **verified relationship**: the customer has paid this business **from their own WaPay account** (a `WAPAY:` payer whose number is the customer's number), or their customer row is bound to such an account. A card payment never counts, because the number at a card checkout is whatever the payer typed (review 2026-09-05, BUGLOG #39). The push is informational-only (names the sender as "a WaPay business", plants no state on the recipient, tells them to ignore it if unrecognised), one send per link (a later copy click cannot reset that), capped at `WAPAY_BUSINESS_NUDGES_PER_DAY` (default 20) per business, and uses window-crossing rails first: Direct Send → approved template (`WAPAY_TEMPLATE_BUSINESS_REQUEST`) → free-form text last, since Meta accepts free-form text and drops it later when the window is closed. **Run `/fable-review` again before flipping the flag.**

Contact import: the WhatsApp Cloud API has **no contact-list endpoint**, so "import my WhatsApp contacts" is not possible by API. The portal accepts a pasted CSV (either column order), bare numbers, undelimited "Name 073 …" lines, and vCard blocks (phone / Google Contacts export), mixed freely; and every payer of a link is captured automatically (card payers from the signed `custom_str1` number, balance payers from their WaPay account) by an idempotent lazy linker that runs on dashboard loads. A future phase can connect a business's own WABA via Embedded Signup.

## 3. Money and data model

- **No new money path.** `createPaymentRequest` gained an optional `business` bag (`businessId, customerId, items, reference, ttlDays`); every existing caller passes nothing and behaves byte-for-byte as before. The ITN, the pay page's card form, `markRequestPaid`, and the in-chat balance leg are untouched.
- **Caps.** Business links count per business (`WAPAY_BIZ_PAYREQ_MAX_OPEN` default 250, `WAPAY_BIZ_PAYREQ_MAX_PER_DAY` default 300) and personal chat links now exclude business links, so an owner with 40 open tickets can still "please pay me" personally. TTL up to 30 days (`MAX_BUSINESS_TTL_DAYS`), default 7.
- **Amounts** stay R5–R3000 per link (the no-KYC exposure cap). Fee = `paymentRequestFeeCents` (banded, receiver-pays, free under R50), quoted at composition and shown per paid link as fee/net.
- **Tables** (`packages/domain/prisma/migrations/20260904_business/migration.sql`, idempotent): `businesses` (one per account, argon2id `passwordHash` optional, `settings` JSON: `defaultTtlDays`, `recentItems`), `business_customers` ((businessId, msisdn) unique, source MANUAL | IMPORT | PAYLINK, `accountId` once known), and six nullable columns on `payment_requests` (`businessId, customerId, items, reference, channel, sentAt`) plus two indexes. **Totals are never stored**: every number is derived from `payment_requests` at read time (PAID = revenue, PENDING and unexpired = outstanding), so the CRM can never disagree with the pay page.
- **Apply to prod:** run the migration SQL against the pooler (`migrate deploy` is unbaselined here), then `prisma generate` (the build's postinstall does this).

## 4. Auth and security shape

Mirrors the admin console (`lib/admin-auth.js`), keyed on the account instead of an env allowlist:

- Session secret `WAPAY_BUSINESS_SESSION_SECRET` (falls back to `WAPAY_ADMIN_SESSION_SECRET`; payloads are domain-separated so a business token never opens the admin console and vice versa, tested). **Fails closed** without one.
- OTP over WhatsApp: hashed `biz:` rows in `otp_codes` (never collide with admin `adm:` or customer codes), 10-min expiry, one attempt per code, 1 send/min, 20/day. The public request path messages only numbers that own a business or are invited (an uninvited or suspended number gets the same generic answer and no message). Lockouts (5 wrong codes, 5 wrong passwords, 15 min) are **per source**: a stranger looping guesses at a shop's public number locks their own connection out, never the owner, and a locked-out source cannot consume the owner's fresh code (review 2026-09-05). Delivery: **in-session is the primary path**: the owner types `business login` (or `business code` / `portal login`) to WaPay from their phone and the code comes straight back, even mid-flow (the BUGLOG #33 inversion; an owner or invitee asking twice inside a minute is told to wait; non-owners get silence). The portal's push (authentication template candidates `WAPAY_TEMPLATE_BUSINESS_OTP` → admin/onboarding candidates → free-form) only delivers inside the 24-hour window: Meta accepts free-form text outside it and drops it later, which is exactly what the founder's first attempt hit (2026-09-06, a kept `biz:` row and no message).
- Password (optional, set at registration or in Settings): self-contained argon2id in `businesses.passwordHash`, 10+ chars, wrong-number and wrong-password answer identically. Changing or removing it needs a fresh factor (the current password, or a one-time code when none is set); the owner gets a WhatsApp notice. A borrowed 24h cookie can never become permanent access.
- Owners must be onboarded wallets (`S5_COMPLETED`): a number that only ever said hi to WaPay is not an owner, with the same generic answers so nothing leaks.
- Suspending a business (`businesses.status = 'SUSPENDED'`) locks the portal AND stops its open links on every rail: pay page, card checkout, and the in-chat balance confirm and PIN settle all ask `businessRequestPayable`.
- Registration is **closed by default** (2026-09-05): a verified wallet without a business may register only if its number is on `WAPAY_BUSINESS_MSISDNS` (comma-separated, any SA form; the singular spelling `WAPAY_BUSINESS_MSISDN` is accepted as an alias since 2026-09-06) or `WAPAY_BUSINESS_SIGNUPS=open`. A closed portal with nobody invited logs `business_signups_closed_no_invites` at cold start; malformed entries log `business_allowlist_malformed`. A verified-but-uninvited owner is told so honestly (no token); uninvited numbers typing `business login` get silence. Passing the OTP yields a 15-minute registration token; the name is validated (`validateBusinessName`: sanitised, 2–60 chars, may not contain WaPay / PayFast / WhatsApp / Meta / SARS / Eskom / bank names). Existing businesses always keep signing in.
- Session: stateless HMAC cookie `wapay_biz`, 24h, HttpOnly/Secure/SameSite=Strict. Every API route runs `requireBusinessContext` before any other DB access (suspended business = 401), and every read/write is scoped to the session's business (a foreign customer or link id is simply "not found"). Scripts may use `x-internal-api-key` + `x-wapay-business-id`.
- Host: `WAPAY_BUSINESS_HOST` (e.g. `business.wapay.co.za`) makes `/business` serve only there (404 elsewhere, root rewrites in), exactly like `WAPAY_ADMIN_HOST`. Unset = reachable everywhere during setup. `/api/*` is never host-gated.
- Labels shown to third parties (business name on the pay page, in messages) are sanitised (`sanitizeLabel`) and rendered as plain text.
- Nothing logs codes, passwords, hashes or tokens; no bearer secrets (voucher PINs) are ever touched. No betting or cash-out language anywhere (statically tested).

## 5. Activation (founder, in Vercel, then REDEPLOY)

1. ~~Apply `packages/domain/prisma/migrations/20260904_business/migration.sql` to the production DB~~ **DONE 2026-09-04** via `node --env-file=.env scripts/apply-migration.mjs 20260904_business` (idempotent; re-running is safe). The old deployed code ignores the new nullable columns, so deploy order is no longer a hazard.
2. Secret: the portal already falls back to `WAPAY_ADMIN_SESSION_SECRET` (set in prod), so nothing is needed to switch it on. Optionally set a dedicated `WAPAY_BUSINESS_SESSION_SECRET` (`openssl rand -hex 32`).
3. **Who may register** (closed by default): `WAPAY_BUSINESS_MSISDNS=0787051175,0731234567` (any SA form; the founder's own WaPay number plus the laundry owner's). Later, `WAPAY_BUSINESS_SIGNUPS=open` opens it to every WaPay wallet.
4. **Host `business.wapay.co.za`** (founder 2026-09-05): Vercel → project `wapay-api` → Settings → Domains → add `business.wapay.co.za` → create the CNAME it shows at the DNS provider for wapay.co.za (`cname.vercel-dns.com`) → wait for the green tick → set `WAPAY_BUSINESS_HOST=business.wapay.co.za` → Vercel Firewall: exempt the host from Attack Challenge Mode (the admin host needed this, BUGLOG #34). Until the env is set, `/business` also answers on `pleasepayme.co.za/business`, which is fine for testing.
5. Leave `WAPAY_BUSINESS_NOTIFY` unset (the WaPay-originated push stays off).
6. **Redeploy** after every env change (env changes do nothing until then).

First login for the laundry: they must already have a WaPay wallet (say hi to WaPay on WhatsApp). Then at the portal: number → code (or `business login` from the phone) → name the business → set a password for the shop computer. Step-by-step founder test plan: `docs/BUSINESS_PORTAL_TEST_GUIDE.md`.

## 6. Files

- `lib/business.js` (domain), `lib/business-auth.js` (auth), `lib/business-host.js` (host gating)
- `pages/business/index.js` (the portal), `pages/api/business/{auth,overview,customers,customer,links,export,settings}.js`
- Additive touches: `lib/payment-requests.js` (business bag + caps, personal counts exclude business links), `pages/pay/[code].js` (business name, items, reference), `lib/request-notify.js` (owner's PAID message names customer + ref), `middleware.js` (matcher + business host), `pages/api/webhooks/message-processor-v2.js` (`matchBusinessLoginAsk` hook next to the admin one)
- Tests: `tests/business-portal.test.mjs` (31), `tests/e2e/business-e2e.mjs` (8 steps on a scratch schema, run with `DATABASE_URL=…?schema=wapay_qa_biz_<x>`; header explains create/teardown)

## 7. Follow-ups (not built, by design)

Embedded Signup for a business's own WABA; staff logins; refunds; recurring invoices; per-item catalogue with stock; QR-code print sheet for the till (the `pleasepayme.co.za` walk-in link already works as one); restyling the admin console to the new visual system; a nightly rollup table if a business exceeds ~5,000 paid links a year (the dashboard scans the most recent 5,000 and says so).
