# WaPay: the whole system on one page

*Written 2026-11-13 from a read-only review of the tree at `6df86a2`, with the changes of that day (CHANGELOG 140 and 141) added. Every statement was read in the code, not taken from the changelog. Values that live only in Vercel or in production rows are named as switches, not as facts.*

This file answers "what is there, where is it, what guards it". The design of the chat brain is `docs/AGENT_ARCHITECTURE_V2.md`; the money and privacy rules are `docs/GOLDEN_THREAD.md`; what a customer can do is `docs/CAPABILITIES.md`; what is open is the programme board (`docs/programme/README.md`).

**Keep it true.** A change that adds a host, a route, a cron, a table, a supplier, a switch or a subsystem updates its row here in the same commit.

## 1. The shape

One Next.js application (pages router) on Vercel, one Postgres database through Prisma, a double-entry ledger with holds, and a handful of supplier clients. Customers reach it through WhatsApp (the chat), through pay links and through three web portals. Every inbound message runs one function, the processor, which answers from rules first and from a model second.

```
WhatsApp ─▶ /api/webhooks/whatsapp ─▶ processor ─┬─▶ rules and flows (PIN steps, money states)
                                                 ├─▶ Pay agent (pilot numbers) ─▶ tools ─▶ proposals
                                                 └─▶ two-tier engine (everyone else)
pay link ─▶ /pay/[code] ─▶ /api/pay/checkout ─▶ PayFast or Adumo ─▶ ITN / return / webhook ─▶ ledger
portals  ─▶ /app, /business, /admin ─▶ their own /api routes ─▶ the same libraries ─▶ ledger
money out ─▶ requestPayout (PIN proof) ─▶ hold ─▶ approval ─▶ OTT Payout ─▶ webhook / reconciler ─▶ ledger
```

In numbers: the processor is 7,436 at the design baseline 240526c; 8,304 at bafa652; 9,826 at HEAD (git show <sha>:pages/api/webhooks/message-processor-v2.js \| wc -l). Library files: 63 at bafa652; 123 at HEAD (plus lib/agent 7 files, lib/audit 6 files). API route files: 64 at bafa652; 110 at HEAD (107 handlers and 3 library modules without a default export). Test files: 99 at bafa652; 154 at HEAD (tests/*.test.mjs). Prisma models: 26 at bafa652; 31 at HEAD.

## 2. Hosts

- pleasepayme.co.za: every pay link (hard-coded in lib/payment-requests.js:237); /PRxxxxxx is rewritten to /pay/:code on pleasepayme.co.za and wa-pay.me (next.config.js:14-22); referral links pleasepayme.co.za/i/<code> (pages/i/[code].js:2).
- app.wapay.co.za: the personal portal. Code default DEFAULT_APP_HOST (lib/app-host.js:30); that host's root redirects to /app (middleware.js:46-51). /app answers on every host.
- WAPAY_ADMIN_HOST (for example admin.wapay.co.za): once set, /admin serves only there, 404 elsewhere, and the root rewrites to /admin (middleware.js:26-45, lib/admin-host.js). Value unverified.
- WAPAY_BUSINESS_HOST (for example business.wapay.co.za): the same for /business (middleware.js:27-45, lib/business-host.js). Value unverified.
- wapay-api.vercel.app: the deployment address, used as the default base for approval links and the audit summary (lib/payout-approval.js:71, lib/audit/run.js:41) and in every operator curl example.
- wapay.co.za: named in comments and the e-mail identity only; this project does not serve it as far as the code shows (unverified).
- The middleware never touches /api/* (middleware.js:12-13 and the matcher at :21), so every API route answers on every attached host.
- Vercel region arn1 (vercel.json:38-40).
- Web surfaces: /admin (Mission Control, eight tabs, pages/admin/index.js); /business (pages/business/index.js); /app with 12 pages (index, login, forgot-pin, pay, get-paid, links, top-up, send, pay-out, activity, profile, help); /pay/[code] (public pay page); /i/[code] (referral redirect); /ops/approve and /ops/payout (signed-token operator pages); / (a placeholder page, pages/index.js).

## 3. Routes and what guards each

Six kinds of guard are in use. A new operator route uses `requireAdmin` or `requireInternalAuth`; `tests/public-surface-gates.test.mjs` fails on an admin or internal route without one.

| Route | Methods | Guard | What it does |
|---|---|---|---|
| `/api/webhooks/whatsapp` | GET, POST | Meta verify token (GET); X-Hub-Signature-256 HMAC (POST), fails closed in production | The inbound edge: claim, typing, processMessage, statuses, Meta account events. |
| `/api/webhooks/ott-payout` | POST | OTT hash (verifyPayoutWebhook) | Finalises a pending pay-out. |
| `/api/webhooks/adumo` | POST | signed JWT (verifyAdumoResponse) | Settles an Adumo payment. |
| `/api/webhooks/didit` | POST | Didit signature | KYC status; resumes a waiting pay-out. |
| `/api/webhooks/unifuel` | POST | UNIFUEL_PARTNER_SECRET, timing-safe | Redemption events on WaPay-issued wiCodes. |
| `/api/webhooks/message-processor-v2, /user-manager, /_middleware` | none | not handlers: library modules inside pages/api with no default export | The chat brain, account and state store, template init. |
| `/api/payfast/itn` | POST | PayFast signature, merchant id, passphrase, server validation (verifyItn); source IP warn-only | Credits a card deposit or paid link once. |
| `/api/pay/checkout` | GET, POST | public (the pay page form) | Creates the card intent; applies the own-link rule; records the visit. |
| `/api/pay/adumo-return` | GET, POST | signed response token | Payer's browser return from Adumo; settles on the token. |
| `/api/health` | GET | public; ?config=1 needs the internal key | Liveness; config presence booleans. |
| `/api/webhook-test` | any | none | Legacy echo endpoint. |
| `/api/wallet/balance` | GET | none found (accountId in the query) | Returns the SPEND balance for an account id. |
| `/api/wallet/send/preview` | POST | internal key | Quotes a send. |
| `/api/wallet/send/execute` | POST | internal key, then the sender's PIN inside | Moves the money for a confirmed send. |
| `/api/vas/airtime/preview, /execute` | POST | internal key; PIN inside execute | Airtime two-phase purchase. |
| `/api/vas/data/preview, /execute` | POST | internal key; PIN inside execute | Data bundle purchase. |
| `/api/vas/electricity/preview, /execute` | POST | internal key; PIN inside execute | Prepaid electricity purchase. |
| `/api/vas/fuel/preview, /execute` | POST | internal key; PIN inside execute | Fuel wiCode purchase through UniFuel. |
| `/api/vas/voucher/preview, /execute` | POST | internal key; PIN inside execute | OTT voucher self-purchase (historically the gift). |
| `/api/vas/bundles/[network]` | GET | internal key | Data bundles for one network from our catalogue. |
| `/api/vas/bundles/airtime, /api/vas/bundles/data, /api/vas/catalog, /api/vas/top-products` | GET | none (public product information) | Catalogue reads. |
| `/api/cron/daily-vas-sync` | GET | Bearer CRON_SECRET | The nightly run (see crons). |
| `/api/cron/payout-release` | GET | Bearer CRON_SECRET or internal key | Sends scheduled pay-outs whose business day has come. |
| `/api/cron/payout-reconcile` | GET | Bearer CRON_SECRET or internal key | Pay-out sweep on demand. Not scheduled. |
| `/api/cron/adumo-reconcile` | GET, POST | Bearer CRON_SECRET or internal key | Reconciles pending Adumo intents. Not scheduled. |
| `/api/ops/approve` | GET, POST | signed approval token (three days, one pay-out) | Shows, approves or rejects a waiting pay-out. |
| `/api/ops/payout-link` | GET, POST | signed operator link token (45 minutes) | Dry run, then executes one operator pay-out. |
| `/api/app/auth` | GET, POST | public for login (rate limited, CSRF); session for logout | Portal sign-in with cell number and PIN. |
| `/api/app/forgot` | POST | public, rate limited, CSRF | PIN reset with the whole ID number on file. |
| `/api/app/home, /activity, /profile` | GET (profile also POST) | portal session (+ CSRF and budget on POST) | Read side of the portal; profile actions. |
| `/api/app/pin` | POST | portal session + CSRF | Verifies the PIN and issues the proof for one intent and amount. |
| `/api/app/links, /send, /payout, /topup` | GET, POST | portal session + CSRF; money actions need the PIN proof | Get paid, send, pay out, top up by card. |
| `/api/business/auth` | GET, POST | public for sign-in and registration; session otherwise | Business portal sign-in. |
| `/api/business/overview, /customers, /customer, /links, /export, /settings, /payout` | GET, POST | business session; pay-out needs the step-up proof | Portal data, pay links, CSV, pay-out. |
| `/api/admin/auth` | GET, POST | public for request and verify; allowlist WAPAY_ADMIN_MSISDNS | Mission Control login. |
| `/api/admin/metrics, /growth, /signup-funnel, /conversations, /customers, /customer, /customer-turns, /inbox, /audit, /floats, /payout-reconciliation, /unifuel, /rails-check, /link-map, /watchlist, /whatsapp-quality` | GET | admin session cookie or internal key (requireAdmin) | Read-only dashboards and lookups. |
| `/api/admin/payout-approvals` | GET, POST | admin session or internal key | Lists waiting pay-outs; POST approves or rejects one. |
| `/api/admin/payout-requests` | GET, POST | admin session or internal key | Recent requests with triage; POST clears or freezes an account. |
| `/api/admin/float-load` | GET, POST | admin session or internal key | Records a float load in the journal; reconciliation. |
| `/api/admin/ops-reply` | POST | admin session or internal key | A person replies in the customer's chat. |
| `/api/admin/kyc` | GET, POST | admin session or internal key | Starts or re-syncs a verification. |
| `/api/admin/test-direct-send` | POST | admin session or internal key | One Direct Send test message. |
| `/api/admin/notify-request` | POST | internal key | Re-runs the paid notifications for a link. |
| `/api/admin/sync-vas-catalog, /whatsapp-debug` | POST; GET, POST | ADMIN_API_KEY in header or query string | Legacy: catalogue sync; WhatsApp config and a test send. |
| `/api/admin/vas-ensure-unique, /version` | POST; GET | ADMIN_API_KEY header | Legacy: adds a constraint; returns the commit. |
| `/api/admin/init-templates, /list-wabas` | GET | internal key (since CHANGELOG 141) | Legacy: refreshes templates; lists WhatsApp Business Accounts with the token. |
| `/api/internal/card-refund` | GET, POST | internal key (requireInternalAuth) | Dry run or booking of a card refund. |
| `/api/internal/card-chargeback` | GET, POST | internal key (requireInternalAuth) | Dry run or booking of a card chargeback: the wallet gives back what it holds, the rest is WaPay's loss. |
| `/api/internal/ops-payout` | POST | internal key | Operator pay-out; dry run by default. |
| `/api/internal/payout-hold, /payout-freeze, /payout-review` | GET, POST | internal key | Global hold and approval mode; per-account freeze; review list with clear and freeze. |
| `/api/internal/ops-reply, /audit-run, /audit-resolve, /compliance-check, /template-create, /blu-voucher-probe` | POST (some GET) | internal key | Operator reply; audit run and resolve; compliance verdict; templates through the Graph API; Blu voucher status probe. |
| `/api/internal/flags, /float, /funnel, /meta-node, /ads-breakdown` | GET | internal key | Switch readout; live float; sign-up funnel; one Graph node; ad insights. |
| `/api/internal/payout-status, /payout-reconcile, /payout-probe, /meta-status, /adumo-status, /ads-pipe-check, /capi-dataset, /capi-test-send, /ad-reminders` | GET or POST | internal key, checked by an inline copy in each file (401 when unset or wrong) | Rail probes, reconcile, sandbox probe, Meta status, Adumo status, ads pipe, Conversions API set-up, reminder sweep. |
| `/api/admin/programme` | GET | admin session | The programme board snapshot for Mission Control's Programme tab (2026-11-13). |
| `/api/internal/programme` | GET, POST | internal key | Counts of the stored board (GET); validate and store a board (POST). Never returns content on GET. |

Changed on 2026-11-13: `/api/webhook-test` is deleted; `/api/wallet/balance`, `/api/admin/list-wabas` and `/api/admin/init-templates` need the internal key; every `/api` answer carries `nosniff`; the consoles, the operator links and the bare root refuse framing.

## 4. Scheduled work

- Scheduled: /api/cron/daily-vas-sync at 02:00 UTC, 60 s, 1024 MB (vercel.json:7-10, :29-32). Fourteen steps in sequence, each best effort: (1) Blu data catalogue sync, (2) embeddings refresh, (3) pay-out sweep (5 rows, 20 s), (4) release floor for scheduled pay-outs (10), (5) refund held sends older than 30 days, (6) purge turns older than 30 days, (7) prune link visits older than 90 days, (8) wallet integrity check, (9) Meta ad insights snapshot, Conversions API sweep (50, 15 s) and ad reminders (20), (10) drain agent_jobs (10, 20 s: fuel-reconcile, electricity-reconcile), (11) quality check (8 s) and delivery stall check (5 s), (12) compliance check handed off by self-fetch with a 4 s abort, (13) daily conversation audit handed off the same way, in-process fallback capped by what is left of 57 s, (14) the JSON answer. pages/api/cron/daily-vas-sync.js:43-325.
- Scheduled: /api/cron/payout-release at 06:00 UTC (08:00 SAST) every day (vercel.json:33-36): releaseDuePayouts, up to 50 rows, each claimed before the rail call (pages/api/cron/payout-release.js:35).
- Not scheduled: /api/cron/payout-reconcile (pages/api/cron/payout-reconcile.js:19-20) and /api/cron/adumo-reconcile; both run only when an operator or an outside scheduler calls them.
- On the customer's turn instead of a schedule: fuel reconcile, electricity reconcile, pay-out reconcile after two minutes, held-gift claim (processor:1616-1796); a delivery and quality check at most once per time bucket inside the webhook (pages/api/webhooks/whatsapp.js:101-114).

## 5. Data

| Domain | Models |
|---|---|
| Identity and conversation | Account (conversationState, conversationData, profile JSON); OtpCode (otp_codes); AuthFactor (auth_factors); Consent (consents); AuditLog (audit_log); ConversationTurn (conversation_turns); ProcessedMessage (processed_messages: dedupe, pulses, switches, claims, rate limits); WhatsappTemplate; Beneficiary (beneficiaries); AuthSession (no reference in code); Limit (no reference in code) |
| Ledger | Wallet (one per account and balance type); Hold (holds); JournalEntry (idemKey unique, externalRef); JournalLine |
| Intents and supplier calls | ProviderRequest (ten route kinds: ott-payout, payrequest, deposit, send-preview, airtime-preview, data-preview, electricity-preview, fuel-preview, voucher-preview, ott-redeem) |
| Payment links and sends | PaymentRequest (payment_requests; status PENDING, PAID, CANCELLED, EXPIRED, REFUNDED); PendingGift (pending_gifts; voucher rails and the held rail WAPAY); LinkVisit (link_visits) |
| Pay-out details | PayoutIdentity (payout_identities, encrypted); PayoutDestination (payout_destinations, encrypted) |
| Business | Business (businesses); BusinessCustomer (business_customers) |
| Agent and jobs | AgentTurn (agent_turns); AgentJob (agent_jobs) |
| Audit loop | AuditRun (audit_runs); AuditFinding (audit_findings) |
| Growth | AdInsightDaily (ad_insights_daily); AdCatalog (ad_catalog) |
| Catalogue and legacy | VasProduct (with embeddings, migration 20260818_vas_embeddings); YoyoInstrument (dormant) |

One row is not a job although it lives in `agent_jobs`: kind `programme-board`, key `current`, status `DONE`, holding the programme board snapshot. The drain claims only `PENDING` and stale `RUNNING` rows.

## 6. Suppliers

| Supplier | Purpose | Where in the code | Environment |
|---|---|---|---|
| Meta WhatsApp Cloud API | The chat channel, templates, quality and account status | packages/whatsapp/src/send.ts behind lib/say.js and lib/notify.js; inbound pages/api/webhooks/whatsapp.js; Graph reads in lib/whatsapp-quality.js, lib/meta-compliance.js, pages/api/internal/meta-status.js | production |
| Meta Marketing API and Conversions API | Ad spend in, conversion events out (events only from the Production environment: lib/meta-capi.js:42) | lib/meta-ads.js, lib/meta-capi.js | production |
| OpenAI | Two-tier engine, Pay agent, translation, product search, nightly audit review | packages/ai/src/orchestrator.ts and agent.ts (chat), lib/localize.js (gpt-4o-mini), lib/vas-embeddings.js (text-embedding-3-small), lib/audit/review.js through callStructuredOnce | production |
| OTT Payout | Money out: PayShap, RTC, CashSend, Nedbank cardless, eWallet | lib/ott-payout.js behind lib/payouts.js | production (per CHANGELOG 73; the base URL is an env value, unverified) |
| OTT voucher issuing | OTT voucher self-purchase (switch default off) | packages/providers/ott/src/client.ts | test (code default test-api.ott-mobile.com; env override unverified) |
| OTT voucher redemption | Load an OTT voucher into the wallet (switch default off) | lib/ott-redemption.js | unknown |
| Blu Telecoms | VAS vending and Blu voucher cash-in (all default off) | packages/providers/blu/src/client.ts (vouchers), vas.ts (airtime, data, electricity), lib/vas-catalog-sync.js | test (code default api.qa.bltelecoms.net; CAPABILITIES says no production credentials were ever issued) |
| PayFast | Card and EFT in: deposits and paid links | packages/providers/payfast/src (checkout, itn, signature), pages/api/payfast/itn.js, lib/deposits.js | production (per CAPABILITIES section 7; PAYFAST_SANDBOX is an env value) |
| Adumo Online (Nedbank through SHB) | Second card rail | lib/adumo.js, lib/adumo-reporting.js | unknown (merchant approved 23 Oct; WAPAY_ADUMO_ENABLED is an env value) |
| Didit | Identity verification | lib/didit-kyc.js, pages/api/webhooks/didit.js | unknown (keys are env values) |
| UniFuel (Yoyo wiCode behind it) | Fuel vouchers | lib/unifuel-client.js, pages/api/webhooks/unifuel.js, lib/fuel-settlement.js | test (Yoyo TEST per CAPABILITIES) |
| Yoyo direct | Dormant; no importer in lib or pages | packages/providers/yoyo | unknown |
| Resend | Ops e-mail | lib/email.js | unknown (key is an env value) |
| Supabase Postgres through Prisma | The database | lib/prisma.js, packages/domain/src/db.ts, packages/whatsapp/src/templateCatalog.ts and seedTemplates.ts (four clients) | production |
| Vercel | Hosting, two crons, link-visit areas | vercel.json; edge geo headers read in lib/link-visits.js | production |
| OpenStreetMap tiles | The Link map's base map | components/admin/LinkMapTab.js:192 | production |

## 7. Subsystems added around the chat brain

Each is live in the code. "Described in" says where a reader finds the rule; "none" means the changelog is the only record and the subsystem needs a section in the document that owns its area.

### Model boundary and privacy scope

No personal data reaches any model: names, phones, e-mails and references become tokens; a message holding an ID, passport, account number or PIN refuses the call.

- **Code:** `packages/ai/src/boundary.ts`, `lib/privacy-names.js`, `lib/money-truth.js`, `packages/ai/src/orchestrator.ts:415`, `packages/ai/src/agent.ts:212-290`, `lib/localize.js:81`, and more
- **Tests:** `tests/model-boundary.test.mjs`, `tests/payout-timeout.test.mjs`
- **Since:** CHANGELOG 88 (2026-10-16)
- **Described in:** documented in docs/GOLDEN_THREAD.md section 1; in AGENT_ARCHITECTURE_V2.md only as one unversioned paragraph after section 15 (lines 589-606); not on the map

### Flow sealing and the PII vault

Bank account and ID numbers encrypted at rest when saved, and sealed inside Account.conversationData while a withdrawal is in progress.

- **Code:** `lib/flow-seal.js`, `lib/pii-vault.js`, `lib/payout-beneficiaries.js`, `pages/api/webhooks/user-manager.js:225`, `pages/api/webhooks/user-manager.js:257`
- **Routes:** `/api/internal/payout-status (switches.piiKey)`
- **Data:** payout_identities; payout_destinations; Account.conversationData
- **Switches:** WAPAY_PII_KEY; WAPAY_PII_KEY_VERSION
- **Tests:** `tests/payout-timeout.test.mjs`, `tests/payout-beneficiaries.test.mjs`
- **Since:** CHANGELOG 88 (sealing); vault 64 and 73
- **Described in:** documented in docs/GOLDEN_THREAD.md section 3

### PIN proof

A signed, two-minute proof bound to account, intent and amount that requestPayout and sendMoney demand before anything is written.

- **Code:** `packages/auth/src/pin-proof.ts`, `packages/auth/src/pin.ts:347`, `lib/business-auth.js:545`, `lib/payouts.js:467`, `lib/app-money.js`, `lib/ops-payout.js:171`, and more
- **Routes:** `/api/app/pin`
- **Switches:** WAPAY_PIN_PROOF_SECRET (falls back to PIN_PEPPER, then WAPAY_INTERNAL_API_KEY: pin-proof.ts:33)
- **Tests:** `tests/money-out-safeguards.test.mjs`, `tests/app-portal.test.mjs`
- **Since:** CHANGELOG 88
- **Described in:** documented in docs/GOLDEN_THREAD.md section 2, but the operator pay-out as a third issuer is missing

### PIN reset and the loop guard

Forgot or change PIN from any step with a WhatsApp code and the ID on file; a 24 hour cool-off without an ID check; a reply that asks the customer to retype what they typed is never sent.

- **Code:** `lib/pin-reset.js`, `lib/loop-guard.js`, `pages/api/webhooks/message-processor-v2.js:1969-1975`, `pages/api/webhooks/message-processor-v2.js:8182`
- **Routes:** `/api/app/forgot`
- **Data:** otp_codes; auth_factors; Account.profile.pinReset
- **Switches:** WAPAY_PIN_RESET_COOLOFF_HOURS (24)
- **Tests:** `tests/pin-reset.test.mjs`, `harness pay-out scenarios 7 and 8`
- **Since:** CHANGELOG 84 (2026-10-14)
- **Described in:** documented in docs/CAPABILITIES.md and docs/GOLDEN_THREAD.md 2.8, 5.2, 5.3

### One-step sign-up, PIN on demand, payer pre-registration, sign-up funnel

Four sign-up switches (three default off) and an always-on funnel measure.

- **Code:** `lib/onboarding-flags.js`, `lib/one-step-signup.js`, `lib/pin-setup.js`, `lib/payer-preregister.js`, `lib/signup-funnel.js`
- **Routes:** `/api/admin/signup-funnel`, `/api/internal/funnel`
- **Data:** Account.profile.onboarding; Account.profile.origin; consents; audit_log
- **Switches:** WAPAY_ONBOARDING_ONE_STEP; WAPAY_PIN_ON_DEMAND; WAPAY_PAYER_PREREGISTER; WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2
- **Tests:** `tests/one-step-onboarding.test.mjs`, `tests/pin-on-demand.test.mjs`, `tests/payer-preregister.test.mjs`, `tests/signup-funnel.test.mjs`
- **Since:** CHANGELOG 121 (2026-10-22)
- **Described in:** documented in docs/ONBOARDING.md section 5 and GOLDEN_THREAD 2.14; CAPABILITIES still says it lives on a branch

### Pay-out rules (caps and KYC by threshold)

R3,000 in any 24 hours for every account, an ID check over R1,000, a new-account cap.

- **Code:** `lib/payout-rules.js`, `lib/payouts.js:399`
- **Data:** ProviderRequest (route ott-payout)
- **Switches:** WAPAY_PAYOUT_DAILY_CAP_CENTS (300000); WAPAY_PAYOUT_KYC_SINGLE_CENTS (100000); WAPAY_PAYOUT_KYC_DAILY_CENTS (100000); WAPAY_PAYOUT_NEW_ACCOUNT_DAYS (7); WAPAY_PAYOUT_NEW_ACCOUNT_DAILY_CAP_CENTS (1000000); WAPAY_PAYOUT_KYC
- **Tests:** `tests/payout-rules.test.mjs`
- **Since:** CHANGELOG 107, 125
- **Described in:** docs/PAYOUT_RULES.md exists but shows the 20 October thresholds (R3,000 and R10,000), no daily cap row

### Express fee, pay-out speeds and the release cron

Money under two hours old costs double on cash rails; a bank pay-out is R12 next business day (default) or R20 same day; scheduled pay-outs are sent from 08:00 SAST.

- **Code:** `lib/payout-express.js`, `lib/payout-speed.js`, `lib/payout-approval.js (releaseDuePayouts)`, `lib/ledger-core.js:146-147`, `pages/api/cron/payout-release.js`
- **Routes:** `/api/cron/payout-release (06:00 UTC)`, `floor inside /api/cron/daily-vas-sync (lines 89-97)`
- **Data:** ProviderRequest (status SCHEDULED); holds
- **Switches:** WAPAY_PAYOUT_EXPRESS_WINDOW_MINUTES (120); WAPAY_PAYOUT_EXPRESS_FEE_MULTIPLIER (2)
- **Tests:** `tests/payout-speed.test.mjs`, `tests/payout-express-triage.test.mjs`
- **Since:** CHANGELOG 125, 139
- **Described in:** shipped-log-only (docs/COMMERCIALS.md names the speed; no architecture or capability doc does)

### Global pay-out hold and pay-out test numbers

One switch that stops every pay-out until the founder lifts it; named test numbers whose pay-outs are dry runs.

- **Code:** `lib/payout-hold.js`
- **Routes:** `/api/internal/payout-hold`, `/api/internal/flags`
- **Data:** processed_messages (row payout-hold:global and log rows)
- **Switches:** WAPAY_PAYOUT_TEST_NUMBERS
- **Tests:** `tests/payout-hold.test.mjs`
- **Since:** CHANGELOG 124, 128
- **Described in:** one row in docs/CAPABILITIES.md; nothing else

### Approval mode and the founder's approval links

Every customer pay-out is set aside as AWAITING_APPROVAL and reaches the rail only on the founder's tap; a signed three-day link per pay-out.

- **Code:** `lib/payout-approval.js`, `lib/payout-hold.js:108-146`, `pages/ops/approve.js`, `pages/api/ops/approve.js`, `pages/api/admin/payout-approvals.js`
- **Routes:** `/ops/approve`, `/api/ops/approve`, `/api/admin/payout-approvals`
- **Data:** processed_messages (row payout-mode:approval); ProviderRequest (AWAITING_APPROVAL, REJECTING); holds
- **Switches:** WAPAY_OPS_LINK_SECRET (falls back to WAPAY_INTERNAL_API_KEY); APP_BASE_URL
- **Tests:** `tests/payout-approval.test.mjs`
- **Since:** CHANGELOG 129 (2026-10-26)
- **Described in:** none

### Operator pay-out and tap-to-pay links

The founder pays a customer's own balance to a destination the customer saved, from a key-gated route or a signed 45-minute link.

- **Code:** `lib/ops-payout.js`, `lib/ops-link.js`, `pages/ops/payout.js`, `pages/api/ops/payout-link.js`, `pages/api/internal/ops-payout.js`
- **Routes:** `/api/internal/ops-payout`, `/ops/payout`, `/api/ops/payout-link`
- **Data:** payout_destinations; payout_identities; audit_log (OPS_PAYOUT); conversation_turns (kind ops)
- **Switches:** WAPAY_OPS_LINK_SECRET
- **Tests:** `tests/ops-payout.test.mjs`, `tests/ops-link.test.mjs (the library only; no test names /api/ops/payout-link)`
- **Since:** CHANGELOG 116, 118, 136
- **Described in:** GOLDEN_THREAD 3.1 mentions one vault reader; the money path itself is in no rule

### Per-account pay-out freeze

Stops money leaving one account (pay-outs, sends, paying a link from balance, purchases) while a card payment is checked.

- **Code:** `lib/payout-freeze.js`, `pages/api/vas/*/execute.js (refuseSpendIfFrozen)`
- **Routes:** `/api/internal/payout-freeze`, `/api/admin/payout-requests (POST clear or freeze)`
- **Data:** Account.profile.payouts
- **Tests:** `tests/payout-freeze.test.mjs`
- **Since:** CHANGELOG 106, 129
- **Described in:** one sentence in docs/PAYOUT_RULES.md

### Fraud triage, review level and the watchlist

Every pay-out request scored 1 to 5 from WaPay's own rows; level 4 and up waits for a person; a computed list of numbers to watch.

- **Code:** `lib/payout-triage.js`, `lib/payout-requests-view.js`, `lib/watchlist.js`
- **Routes:** `/api/admin/payout-requests`, `/api/internal/payout-review`, `/api/admin/watchlist`
- **Data:** audit_log (PAYOUT_REQUEST); Account.profile.payouts (clearance); link_visits; ProviderRequest
- **Switches:** WAPAY_PAYOUT_REVIEW_LEVEL (4); WAPAY_PAYOUT_FINGERPRINT_SECRET
- **Tests:** `tests/payout-express-triage.test.mjs`, `tests/payout-approval.test.mjs`
- **Since:** CHANGELOG 125, 126, 129
- **Described in:** one clause in docs/CAPABILITIES.md; the watchlist in no doc

### Float check, float loads and operator alerts

The pay-out float is read before every pay-out; float loads are recorded in the journal and reconciled; ops get a WhatsApp line when money lands or the float is thin.

- **Code:** `lib/payout-float.js`, `lib/float-loads.js`, `lib/ops-alerts.js`, `lib/ledger-core.js (buildFloatLoad)`
- **Routes:** `/api/admin/float-load`, `/api/admin/floats`, `/api/internal/float`
- **Data:** JournalEntry (FLOAT_LOAD); processed_messages (alert dedupe)
- **Switches:** WAPAY_OPS_ALERT_MSISDNS; WAPAY_OPS_ALERT_MIN_CENTS; WAPAY_FLOAT_WARN_CENTS; WAPAY_FLOAT_WARN_CENTS_OTT_PAYOUT; WAPAY_TEMPLATE_OPS_ALERT; WAPAY_OTT_PAYOUT_FUNDED_CENTS
- **Tests:** `tests/payout-float-short.test.mjs`, `tests/float-loads.test.mjs`, `tests/admin-floats.test.mjs`
- **Since:** CHANGELOG 94, 95, 101, 111, 120
- **Described in:** docs/CAPABILITIES.md and docs/GROWTH_DASHBOARD.md

### Card refund and chargeback routes

Books a refund the founder made in the PayFast or Adumo dashboard as the exact reversal of the card credit, never below zero. Since CHANGELOG 143 also books a chargeback (the cardholder's bank took the payment back): the wallet gives back its available balance, the rest goes to `EXPENSE:CHARGEBACK:<RAIL>`, pay-out holds are not touched, and a refund and a chargeback of the same payment refuse each other.

- **Code:** `lib/card-refund.js`, `lib/ledger-core.js` (`buildReversal`, `buildChargeback`), `pages/api/internal/card-refund.js`, `pages/api/internal/card-chargeback.js`, `lib/card-settlement.js`, `pages/api/payfast/itn.js`
- **Routes:** `/api/internal/card-refund`, `/api/internal/card-chargeback`
- **Data:** JournalEntry.externalRef; payment_requests.status REFUNDED (migration 20261109_payment_request_refunded); audit_log
- **Tests:** `tests/card-refund.test.mjs`
- **Since:** CHANGELOG 135 (2026-11-09)
- **Described in:** documented in docs/GOLDEN_THREAD.md 2.15 and docs/CAPABILITIES.md section 7

### Own-link rule

Paying your own link: the first time is allowed with a visible warning; after that, or from R1,000, a verified ID first, decided before any card session.

- **Code:** `lib/own-link.js`, `pages/api/pay/checkout.js:102`, `lib/request-notify.js`
- **Routes:** `/api/pay/checkout`
- **Data:** payment_requests
- **Switches:** WAPAY_OWN_LINK_KYC_FIRST_CENTS (100000; off disables)
- **Tests:** `tests/own-link.test.mjs`, `tests/payer-registration.test.mjs`
- **Since:** CHANGELOG 138 (2026-11-10)
- **Described in:** none

### Payment links v2

Every link says what it is for; one forwardable message; my links, remind, cancel; a tap-to-send link instead of WaPay writing to the payer; one notification per payment leg.

- **Code:** `lib/pay-links.js`, `lib/link-description.js`, `lib/request-notify.js`, `lib/payment-requests.js`
- **Routes:** `/pay/[code]`, `/api/pay/checkout`, `/api/app/links`, `/api/admin/notify-request`
- **Data:** payment_requests; processed_messages (notify claim legs)
- **Switches:** WAPAY_PAYREQ_MAX_OPEN (10); WAPAY_PAYREQ_MAX_PER_DAY (20); WAPAY_PAYREQ_FREE_BELOW_CENTS (5000)
- **Tests:** `tests/pay-links.test.mjs`, `tests/pay-links-chat.test.mjs`, `tests/pay-link-identity.test.mjs`, `tests/request-notify-once.test.mjs`
- **Since:** CHANGELOG 103, 127, 134
- **Described in:** docs/CAPABILITIES.md row; docs/architecture/rows.json still describes links as of 19 September

### Link visits and the Link map

Where links are made, opened and paid from, by area from Vercel's edge, kept 90 days.

- **Code:** `lib/link-visits.js`, `lib/link-map.js`, `components/admin/LinkMapTab.js`, `pages/pay/[code].js:57`, `pages/api/pay/checkout.js:70`, `pages/api/app/links.js:54`, and more
- **Routes:** `/api/admin/link-map`
- **Data:** link_visits (migration 20261025_link_visits)
- **Switches:** WAPAY_LINK_VISIT_SECRET
- **Tests:** `tests/link-visits.test.mjs`
- **Since:** CHANGELOG 128, 130
- **Described in:** docs/CAPABILITIES.md row

### Referrals

Invite gives one forwardable link; the friend's first message stamps the referrer; rewards tracked, paid only when a switch is above zero.

- **Code:** `lib/referrals.js`, `pages/i/[code].js`, `lib/ledger-core.js (buildReferralReward)`
- **Routes:** `/i/[code]`, `/api/admin/customer (referrals)`
- **Data:** Account.profile.referral; Account.profile.attribution; JournalEntry (REFERRAL_REWARD)
- **Switches:** WAPAY_REFERRAL_REWARD_CENTS (0); WAPAY_WA_NUMBER
- **Tests:** `tests/referrals.test.mjs`
- **Since:** CHANGELOG 104 (2026-10-20)
- **Described in:** documented in docs/REFERRALS.md and GOLDEN_THREAD 2.12

### Send through the ledger, held gifts and the recipient notice

Send money moves balance to balance for a member, or into a held liability for anyone else until they join (30 days, then refunded); a member who is sent money is told every time.

- **Code:** `lib/send-money.js`, `lib/pending-gifts.js`, `lib/ledger-core.js (buildGiftHeld, buildGiftClaimToBalance, buildGiftRefund)`, `pages/api/wallet/send/preview.js`, `pages/api/wallet/send/execute.js`, `pages/api/webhooks/message-processor-v2.js:1782-1796`
- **Routes:** `/api/wallet/send/preview`, `/api/wallet/send/execute`, `refund step in /api/cron/daily-vas-sync (lines 99-108)`
- **Data:** pending_gifts (rail WAPAY, migration 20261018_pending_gift_held); JournalEntry; ProviderRequest (route send-preview)
- **Switches:** WAPAY_HELD_GIFT_DAYS (30); WAPAY_TEMPLATE_MONEY_RECEIVED; WAPAY_TEMPLATE_SEND_REFUND
- **Tests:** `tests/send-money.test.mjs`, `tests/send-recipient-notice.test.mjs`, `tests/pending-gifts.test.mjs`, `harness: Send 1`
- **Since:** CHANGELOG 92, 137
- **Described in:** documented in GOLDEN_THREAD 2.11 and CAPABILITIES; AGENT_ARCHITECTURE_V2.md section 7 and rows.json still say a voucher

### Personal web portal

The customer's own money without WhatsApp: log in with cell number and PIN, balance, get paid, links, top up, send, pay out, activity, profile.

- **Code:** `pages/app/*.js (12 pages)`, `pages/api/app/*.js (10 routes)`, `lib/app-auth.js`, `lib/app-login.js`, `lib/app-http.js`, `lib/app-money.js`, and more
- **Routes:** `/app/*`, `/api/app/auth`, `/api/app/forgot`, `/api/app/home`, `/api/app/activity`, `/api/app/links`
- **Data:** none new; processed_messages for rate limits (lib/app-auth.js:259-270), audit_log
- **Switches:** WAPAY_APP_SESSION_SECRET; WAPAY_APP_HOST (default app.wapay.co.za); WAPAY_APP_WHATSAPP_PAUSED; WAPAY_APP_BANNER; WAPAY_APP_DEV_FIXTURE
- **Tests:** `tests/app-portal.test.mjs`
- **Since:** CHANGELOG 117, 119 (2026-10-21)
- **Described in:** documented in GOLDEN_THREAD 2.13 and docs/briefs/PERSONAL_PORTAL_BRIEF.md; CAPABILITIES says built on a branch, not deployed

### WaPay for Business portal (before 6 Oct, never in the record)

A business is a WaPay account wearing a hat: customers, itemised pay links, revenue, pay-outs.

- **Code:** `pages/business/index.js`, `pages/api/business/*.js (8 routes)`, `lib/business.js`, `lib/business-auth.js`, `lib/business-chat.js`, `lib/business-host.js`, and more
- **Routes:** `/business`, `/api/business/*`
- **Data:** businesses; business_customers; payment_requests (business columns)
- **Switches:** WAPAY_BUSINESS_HOST; WAPAY_BUSINESS_MSISDNS; WAPAY_BUSINESS_SIGNUPS; WAPAY_BUSINESS_SESSION_SECRET; WAPAY_BUSINESS_NOTIFY; WAPAY_BUSINESS_NUDGES_PER_DAY
- **Tests:** `tests/business-portal.test.mjs`, `tests/business-chat.test.mjs`, `tests/e2e/business-e2e.mjs`
- **Since:** CHANGELOG 22 to 27, 96
- **Described in:** documented in docs/BUSINESS_PORTAL.md; absent from the architecture record

### Mission Control (eight tabs)

The operator console: money, growth and valuation, support inbox with a reply box, customers, pay-out approvals and requests, link map, health and the daily audit, supplier floats.

- **Code:** `pages/admin/index.js`, `lib/admin-auth.js`, `lib/admin-charts.js`, `lib/inbox.js`, `lib/scale-model.js`, `lib/payout-books.js`, and more
- **Routes:** `/admin`, `/api/admin/*`
- **Data:** reads most tables; writes JournalEntry (float load), ProviderRequest and holds (approve or reject), Account.profile (clear or freeze, KYC)
- **Switches:** WAPAY_ADMIN_HOST; WAPAY_ADMIN_MSISDNS; WAPAY_ADMIN_SESSION_SECRET; WAPAY_ADMIN_PASSWORD_HASH; WAPAY_TEMPLATE_ADMIN_OTP
- **Tests:** `tests/admin-console.test.mjs`, `tests/admin-floats.test.mjs`, `tests/dashboard-and-audit.test.mjs`, `tests/inbox.test.mjs`
- **Since:** CHANGELOG 94, 95, 97, 100, 112, 128 to 130
- **Described in:** docs/ADMIN_DASHBOARD_DESIGN.md and docs/GROWTH_DASHBOARD.md; the record knows only two C19 cards

### Ad chat flow and the one reminder

A Click-to-WhatsApp arrival is answered deterministically, opened in onboarding and led to a first link; one reminder ever, inside the window.

- **Code:** `lib/ad-flow.js`, `lib/ad-reminders.js`, `pages/api/webhooks/message-processor-v2.js:3381`
- **Routes:** `/api/internal/ad-reminders`
- **Data:** Account.profile.attribution
- **Switches:** WAPAY_AD_REMINDERS (off unless on); WAPAY_AD_FIRST_LINK_RESUME_HOURS (24)
- **Tests:** `tests/ad-flow.test.mjs`, `harness: Ad arrival`
- **Since:** CHANGELOG 90, 109
- **Described in:** documented in docs/AD_CHAT_FLOW.md

### Launch scope switches and the master hold

Airtime, data, electricity, voucher loads and the OTT self-purchase read coming soon for everyone until a switch is set; one master hold over all of them.

- **Code:** `lib/vas-config.js`, `lib/capabilities.js (launchScopeFor)`, `lib/agent/guards.js:79`
- **Routes:** `/api/internal/flags`
- **Switches:** WAPAY_LAUNCH_HOLD (unset = hold); VAS_LIVE_<KEY> (false); VAS_ALLOWLIST_<KEY>; WAPAY_WICODE_LIVE
- **Tests:** `tests/launch-scope.test.mjs`, `harness: Launch scope`
- **Since:** CHANGELOG 91, 93 (2026-10-18)
- **Described in:** documented in docs/LAUNCH_SCOPE.md and CAPABILITIES section 3; rows.json product rows predate it

### Meta compliance: template block, outbound guard, compliance check, Meta alerts, quality and delivery health

WaPay never writes first to a number that never wrote; no marketing template can leave; a daily verdict from Meta's side and our own sends; Meta's account events reach the founder in minutes.

- **Code:** `lib/outbound-guard.js`, `lib/meta-compliance.js`, `lib/meta-alerts.js`, `lib/whatsapp-quality.js`, `lib/delivery-health.js`, `lib/say.js:51-56`, and more
- **Routes:** `/api/internal/compliance-check`, `/api/admin/whatsapp-quality`, `/api/internal/meta-status`, `/api/internal/meta-node`, `/api/internal/template-create`
- **Data:** processed_messages (pulse rows, bi-refused rows, compliance markers)
- **Switches:** WAPAY_ALLOW_MARKETING_TEMPLATES; WAPAY_ONBOARDING_MARKETING_TEMPLATES; WAPAY_SEND_CAP (8); WHATSAPP_DIRECT_SEND
- **Tests:** `tests/spam-strike-guard.test.mjs`, `tests/meta-compliance.test.mjs`, `tests/whatsapp-compliance.test.mjs`, `tests/delivery-health.test.mjs`
- **Since:** CHANGELOG 102, 105, 114, 115, 116, 118, 122, 133
- **Described in:** documented in docs/WHATSAPP_POLICY_COMPLIANCE.md and GOLDEN_THREAD 4.6; delivery health is in no doc

### Ops reply, the support template and the inbox

A person answers a customer inside their chat from Mission Control; one approved template crosses a closed window.

- **Code:** `lib/ops-reply.js`, `lib/inbox.js`
- **Routes:** `/api/admin/ops-reply`, `/api/internal/ops-reply`, `/api/admin/inbox`, `/api/admin/customer-turns`
- **Data:** conversation_turns
- **Switches:** WAPAY_TEMPLATE_SUPPORT_FOLLOWUP; WAPAY_SUPPORT_EMAIL; WAPAY_SUPPORT_WHATSAPP
- **Tests:** `tests/ops-reply.test.mjs`, `tests/inbox.test.mjs`
- **Since:** CHANGELOG 96, 97, 100, 105
- **Described in:** docs/WHATSAPP_POLICY_COMPLIANCE.md and docs/GROWTH_DASHBOARD.md

### Daily conversation audit loop

Each night the day's redacted conversations are swept by rules and read by a model reviewer; findings are stored with their recurrence and summarised to ops.

- **Code:** `lib/audit/export.js`, `lib/audit/rules.js`, `lib/audit/brief.js`, `lib/audit/review.js`, `lib/audit/store.js`, `lib/audit/run.js`, and more
- **Routes:** `/api/internal/audit-run`, `/api/internal/audit-resolve`, `/api/admin/audit`, `hand-off from /api/cron/daily-vas-sync (lines 273-323)`
- **Data:** audit_runs; audit_findings (migration 20261019_audit_loop)
- **Switches:** WAPAY_AUDIT_MAX_ACCOUNTS; WAPAY_AUDIT_REVIEW_MODEL (gpt-5.4-mini); WAPAY_AUDIT_REVIEW_CONCURRENCY; WAPAY_ADMIN_URL
- **Tests:** `tests/audit-loop.test.mjs`, `tests/audit-precision.test.mjs`, `tests/audit-handoff.test.mjs`
- **Since:** CHANGELOG 99, 113
- **Described in:** documented in docs/audits/DAILY_AUDIT.md; absent from the architecture record

### Didit KYC and resume after verification

Hosted identity check; after it lands the interrupted pay-out continues by itself.

- **Code:** `lib/didit-kyc.js`, `lib/kyc-resume.js`, `pages/api/webhooks/didit.js`
- **Routes:** `/api/webhooks/didit`, `/api/admin/kyc`
- **Data:** Account.profile.kyc
- **Switches:** DIDIT_API_KEY; DIDIT_WORKFLOW_ID; DIDIT_WEBHOOK_SECRET; WAPAY_PAYOUT_KYC
- **Tests:** `tests/didit-kyc.test.mjs`, `tests/kyc-resume.test.mjs`
- **Since:** CHANGELOG 13 (KYC), 110 (resume)
- **Described in:** documented in docs/KYC.md and docs/DIDIT_KYC_API.md

### Adumo card rail and reporting (before 6 Oct; merchant approved 23 Oct)

A second hosted card page next to PayFast, with a reporting client that reconciles payments whose return never arrived.

- **Code:** `lib/adumo.js`, `lib/adumo-reporting.js`, `lib/card-settlement.js`, `pages/api/pay/adumo-return.js`, `pages/api/webhooks/adumo.js`
- **Routes:** `/api/pay/adumo-return`, `/api/webhooks/adumo`, `/api/cron/adumo-reconcile (not scheduled)`, `/api/internal/adumo-status`
- **Data:** ProviderRequest; JournalEntry (LOAD_ADUMO)
- **Switches:** WAPAY_ADUMO_ENABLED (false); WAPAY_PRIMARY_CARD_RAIL (code default ADUMO); ADUMO_MERCHANT_ID; ADUMO_APPLICATION_ID; ADUMO_JWT_SECRET; ADUMO_CLIENT_ID
- **Tests:** `tests/adumo.test.mjs`, `tests/adumo-reporting.test.mjs`
- **Since:** CHANGELOG 28, 62, 123, 134
- **Described in:** documented in docs/ADUMO.md

### Electricity settlement and reconcile

A slow electricity sale keeps its hold and is reconciled by re-sending the same request id, on the customer's next message and from the job queue.

- **Code:** `lib/electricity-settlement.js`, `lib/payout-books.js (electricityBooks)`, `pages/api/vas/electricity/execute.js`, `pages/api/webhooks/message-processor-v2.js:1655-1729`
- **Routes:** `/api/vas/electricity/preview`, `/api/vas/electricity/execute`
- **Data:** ProviderRequest (route electricity-preview); holds; agent_jobs
- **Switches:** BLU_ELEC_INFO_TIMEOUT_MS; BLU_ELEC_SALE_TIMEOUT_MS
- **Tests:** `tests/electricity-timeout.test.mjs`, `tests/vas-electricity-flow.test.mjs`
- **Since:** CHANGELOG 66, 67, 68
- **Described in:** docs/CAPABILITIES.md; the record mentions it only in the 6 October where-we-are text

### Growth: ad attribution, Meta Marketing API, Conversions API, Scale Model

Where each account came from, the ad account's daily numbers, events back to Meta, and the planning model beside measured inputs.

- **Code:** `lib/growth-attribution.js`, `lib/meta-ads.js`, `lib/meta-capi.js`, `lib/scale-model.js`, `pages/api/admin/growth.js`, `lib/money-flows.js` (the flow reading shared with `pages/api/admin/metrics.js`, CHANGELOG 144)
- **Routes:** `/api/admin/growth`, `/api/internal/ads-pipe-check`, `/api/internal/ads-breakdown`, `/api/internal/capi-dataset`, `/api/internal/capi-test-send`
- **Data:** ad_insights_daily; ad_catalog (migration 20261010_ad_insights); Account.profile.attribution
- **Switches:** META_ADS_ACCESS_TOKEN; META_AD_ACCOUNT_ID; META_CAPI_DATASET_ID; META_CAPI_ACCESS_TOKEN; META_CAPI_ALLOW_NON_PRODUCTION; META_CAPI_TEST_EVENT_CODE
- **Tests:** `tests/growth.test.mjs`, `tests/growth-route.test.mjs`
- **Since:** CHANGELOG 75, 76, 78, 86, 87
- **Described in:** documented in docs/GROWTH_DASHBOARD.md

### Credential guard and the test-database guard

The suite fails on a credential-shaped string in any tracked file; a test process can never reach the .env database.

- **Code:** `tests/no-committed-credentials.test.mjs`, `tests/test-db-guard.test.mjs`, `lib/prisma.js:11-17`, `packages/domain/src/db.ts:12-15`, `packages/whatsapp/src/templateCatalog.ts:12`, `packages/whatsapp/src/seedTemplates.ts:13`
- **Switches:** TEST_DATABASE_URL; NODE_TEST_CONTEXT
- **Tests:** `tests/no-committed-credentials.test.mjs`, `tests/test-db-guard.test.mjs`
- **Since:** CHANGELOG 108, 125
- **Described in:** credential guard in GOLDEN_THREAD section 6; the test-database guard is in no doc and not in CLAUDE.md

### Cron auth

One gate for cron routes: Bearer CRON_SECRET only, fails closed.

- **Code:** `lib/cron-auth.js`
- **Routes:** `/api/cron/daily-vas-sync`, `/api/cron/payout-release`, `/api/cron/payout-reconcile`, `/api/cron/adumo-reconcile`
- **Switches:** CRON_SECRET (16 characters or more)
- **Tests:** `tests/golden-thread-hardening.test.mjs`
- **Since:** CHANGELOG 89
- **Described in:** GOLDEN_THREAD section 8 item O4

### Situation-aware gates and small deterministic helpers

The R0 withdraw gate reads the customer's situation; close-my-account, loans and save-as-mine are real answers before any model.

- **Code:** `lib/money-situation.js`, `lib/payout-gate.js`, `lib/account-closure.js`, `lib/payout-nickname.js`, `lib/payout-collection.js`
- **Switches:** WAPAY_DEPOSIT_UNPAID_AFTER_MINUTES (15)
- **Tests:** `tests/payout-round5.test.mjs`
- **Since:** CHANGELOG 80 to 83, 98
- **Described in:** docs/CAPABILITIES.md pay-out row only

### The programme board (2026-11-13)

Every workstream, session and open item in one place: a tab in Mission Control and a private page, both published from one master file that lives outside this repository.

- **Code:** `lib/programme-board.js`, `components/admin/ProgrammeTab.js`, `scripts/programme-board.mjs`
- **Routes:** `/api/admin/programme`, `/api/internal/programme`
- **Data:** one finished row in `agent_jobs`
- **Tests:** `tests/programme-board.test.mjs`
- **Since:** CHANGELOG 140
- **Described in:** `docs/programme/README.md`

## 8. The chat brain, component by component

Not started. No promotion (the gate is unchanged), no hook deleted, and the two-tier engine still answers everyone off the list (orchestrate at processor:7777). The last recorded state of the promotion week is day 3 of 7 on 6 October (docs/architecture/rows.json:188); nothing in the repo records what happened after. The processor is 9,826 lines against 8,304 at map Version 15 and 7,436 at the design baseline, where the plan said it would roughly halve (rows.json:111).

| Component | State | What the code does today |
|---|---|---|
| **C1** Webhook edge | live | Shipped and wider than drawn. Signature check, claim, typing indicator, send scope, claim release and 500 on a turn that sent nothing are all there. Since 6 Oct the same route also stores delivery statuses as pulse rows, runs a delivery-stall and quality watch, alerts the founder on Meta account events and checks billed messages to strangers. |
| **C2** Sender (lib/say.js) | live | Shipped. Added: a per-number send cap held in an in-process Map (8 texts in 20 s), a hard block on MARKETING-category templates inside the package sender, and two operator routes that write an assistant turn directly beside say(). |
| **C3** Turn runtime (handleAgentTurn) | pilot only | Still shadow. Runs only for numbers on the pilot list. Order at HEAD: agentGuard, bare-secret check, hourly budget, pack + turns + profile, withdraw slot rescue, prompt, model, proposal dispatch or output gates, echo-loop breaker, send, ledger row. The design's 20 second deadline with a fact-built fallback does not exist; each model call gets 6 s. The gate sits below 13 deterministic intercepts, not at the top. |
| **C4** Guard list | pilot only | agentGuard has four kinds (COMING_SOON since 18 Oct, VOUCHER_PIN_RESEND, PAY_REQUEST_CODE, VOUCHER_PIN) and is followed by the bare-secret check. It is still code, not the one exported ordered table of the design. The structural half (a bare PIN, ID or passport never reaches a model) runs for every customer on both brains. |
| **C5** Strict PIN states | live | Shipped. Added around it: PIN reset from any step (lib/pin-reset.js), PIN chosen on demand (lib/pin-setup.js, switch default off), and the PIN proof that verifyPIN issues for one intent and amount. |
| **C6** Context pack | live | Shipped. One Promise.all of ten reads (wallets, holds, provider rows, gifts sent and received, pay links, pending pay-out, saved people, saved pay-out destinations, pay-out identity). It does not know the two pay-out states added since: AWAITING_APPROVAL and SCHEDULED fall through normaliseProviderStatus to PENDING, and the direct pending lookup names only PENDING and INIT. |
| **C7** Capability registry | live | Shipped, 15 descriptors (the record says 11): BALANCE, AIRTIME, DATA, ELECTRICITY, SEND, OTT_SELF, REQUEST_MONEY, DEPOSIT_CARD, DEPOSIT_VOUCHER, VOUCHER_LOAD, WITHDRAW, FUEL, BUSINESS, INVITE, PIN_RESET. launchScopeFor and worksToday were added for the launch scope. |
| **C8** Prompt assembler | pilot only | Shadow. Focus knowledge is still never loaded: the runtime passes focusKnowledge: null. The composition rules grew (reply-only rule, loans line, PIN-on-demand rule). |
| **C9** Pay agent loop | pilot only | Shadow. Two rounds, three tools, no retries. Default timeout 8 s in the package, 6 s as called. Every message, tool argument and tool result crosses the model boundary; a secret refuses the turn. Tools run in one Promise.all with no per-tool timeout. |
| **C10** Tool registry | pilot only | Shadow. Seven read tools, nine start_* proposal tools, show_home, show_help, propose_note and reply. get_payout_status maps any status it does not know to PENDING. |
| **C11** Policy engine and output gates | partial | Partial, and the gap changed shape. Output gates grew to BETTING, PARTNER, URL, PIN_ASK, MONEY_CLAIM, LENGTH, DASH_REWRITE, LIST_REWRITE plus RECEIPT and ECHO_LOOP in the runtime. The policy engine still has one requirement (WITHDRAW minKycTier, effective only when WAPAY_PAYOUT_KYC is neither off nor threshold) and the dispatcher discards it. Meanwhile real money policy was built outside the engine in nine modules. |
| **C12** Proposal dispatcher | partial | Partial, unchanged in kind. Sixteen cases; WITHDRAW is still proposed only by the agent. The action is still named SEND_VOUCHER although a send is now a ledger transfer. |
| **C13** Preview and execute routes | live | Shipped. Five VAS execute routes plus /api/wallet/send/execute behind the internal key, which answers 503 in production when the key is unset. Each execute route now also refuses a frozen account. |
| **C14** Conversation store | live | Shipped. Thirty-day purge runs in the daily cron. Two operator routes create turn rows without going through lib/turns.js. |
| **C15** Movements read | live | Shipped as before: the pack reads source tables. The later step (per-account columns on journal lines) is not built. |
| **C16** Customer model | live | Shipped. Habits are still computed in JavaScript over the fetched rows, not in SQL as the design table says. |
| **C17** Turn ledger and audit | pilot only | Same. agent_turns rows exist only for pilot turns; the nightly balance integrity check runs for everyone in the daily cron. A separate daily conversation audit (audit_runs, audit_findings) now exists and is not in the record. |
| **C18** Eval runner | live | Shipped as a hand-run script. The corpus is 132 golden cases in eleven languages plus 34 agent cases: 166. It is not in CI. |
| **C19** Mission Control cards | live | Shipped and outgrown. Mission Control is eight tabs backed by 30 admin routes: Dashboard, Valuation Metrics, Inbox, Customers, Pay-outs, Link map, Health, Supplier Floats. |
| **C20** Jobs runner and pay-out sweep | partial | Partial. agent_jobs is drained once a day inside the 02:00 UTC cron and has two producers (fuel-reconcile, electricity-reconcile). The pay-out sweep is still five rows a day plus the on-inbound hook. A second cron, /api/cron/payout-release at 06:00 UTC, was added on 11 Nov. /api/cron/payout-reconcile and /api/cron/adumo-reconcile exist and are not scheduled. |
| **C21** notifyCustomer and localizer | partial | notifyCustomer: text inside the 24 hour window; outside it the outbound guard first (never a number that never wrote), then Direct Send, then an env-named template, then a text fallback. Callers: pay-out sweep, ops alerts, ad reminders, held-gift refunds, the recipient notice of a send, the cron's job handlers. Localizer: gpt-4o-mini behind guardTranslation. |
| **GATE** Shadow gate (agentV3For) | pilot only | Unchanged and still the only route to the agent. Canonical-digit matching in lib/shadow-list.js; unset means nobody. |
| **CLARIFY** AGENT_CLARIFY pending intent | pilot only | Shadow, with the withdraw slot rescue in front of the model. |
| **BUDGET** Per-customer model-call budget | pilot only | Shadow. Default 60 turns an hour; guard and budget rows do not count. |
| **ENGINE** Two-tier engine (orchestrate) | live | Live for everyone off the pilot list and not retired. It gained the model boundary, and its single-call door is reused by the nightly audit review. |
| **P3-promotion** Phase 3: promote per language | not built | Did not happen. No per-language promotion mechanism exists beyond the number list. |
| **P3-delete** Phase 3: delete the regex hooks | not built | None deleted. All 14 hooks on the deletion list are still in the processor, and the pre-model layer grew (about 44 intercept points for a customer off the pilot list). |
| **P3-classifier** Phase 3: retire the classifier | not built | Not retired. The older regex NLP package (@wapay/nlp, 1,837 lines) has no importer left but is still built and transpiled. |
| **P3-deadcode** Phase 3: retire dead code | partial | The three named items are gone. New dormant code has accumulated: apps/api and apps/ops scaffolds, @wapay/nlp, @wapay/ledger and @wapay/providers-yoyo without importers, Prisma models Limit and AuthSession without a reference, four legacy admin routes on ADMIN_API_KEY. |
| **P3-textlocks** Phase 3: rewrite the text locks | partial | Source surgery is at zero per CHANGELOG 57, but 43 of 154 test files still read the processor as source text and 67 name it. |
| **P4-jobs** Phase 4: agent_jobs + drain | live | Shipped, daily drain only (limit 10, 20 s). |
| **P4-fuel** Phase 4: fuel reconcile off the turn | not built | Still on the customer's turn, by recorded decision, with a job queued as a backstop. Electricity reconcile was added in the same on-turn shape. |
| **P4-journal** Phase 4: journal columns | not built | Not built. |
| **P4-provider** Phase 4: second model provider | not built | Not built. Three OpenAI call sites, no other provider. |
| **P4-summary** Phase 4: memory summary (flag) | not built | Not found. |
| **P4-media** Phase 4: voice notes and photos | not built | Not found in the webhook. |
| **P7** Partner module proof | not built | Not built. |
| **VERCEL** Vercel plan decision | partial | vercel.json now schedules two daily crons. No ten-minute schedule. Comments in four files still say the Hobby plan allows one cron. |

## 9. Switches

Read them from `/api/internal/flags` and `/api/internal/payout-status`; never guess. Defaults are the code's.

| Area | Switch | Default | Effect |
|---|---|---|---|
| Agent and models | `WAPAY_AGENT_V3_MSISDNS` | unset = nobody | The pilot list: these numbers get the Pay agent instead of the hooks and the two-tier engine (lib/shadow-list.js:30-38). |
| Agent and models | `WAPAY_AGENT_TURNS_PER_HOUR` | 60 | Model turns per customer per hour on the agent path (processor:7604). |
| Agent and models | `WAPAY_AGENT_MODEL, WAPAY_ORCHESTRATOR_MODEL, WAPAY_CATEGORY_AGENT_MODEL, WAPAY_REASONING_EFFORT` | gpt-5.5, gpt-5.5, gpt-5.4-mini, none | Model ids and effort (agent.ts:134-139, orchestrator.ts:57-59). |
| Agent and models | `OPENAI_API_KEY` | unset = canned fallback, audit review skipped | All model calls. |
| Agent and models | `WAPAY_STATE_IDLE_MINUTES` | 30 | When an unfinished flow expires (processor:1897). |
| Agent and models | `WAPAY_AUDIT_REVIEW_MODEL, WAPAY_AUDIT_MAX_ACCOUNTS, WAPAY_AUDIT_REVIEW_CONCURRENCY` | gpt-5.4-mini; see lib/audit/run.js:45 and review.js | The nightly audit reviewer. |
| Launch scope | `WAPAY_LAUNCH_HOLD` | unset = hold | While it holds, every VAS product and voucher rail is off for everyone; off releases it (lib/vas-config.js:36-40). |
| Launch scope | `VAS_LIVE_AIRTIME, VAS_LIVE_DATA, VAS_LIVE_ELECTRICITY, VAS_LIVE_BLU_LOAD, VAS_LIVE_OTT_LOAD, VAS_LIVE_OTT_VOUCHER (also LIFESTYLE, BILLPAY, REMITTANCE, GAMING)` | false | Switches one product or rail on once the hold is released (lib/vas-config.js:49-62, :95-99). |
| Launch scope | `VAS_ALLOWLIST_<KEY>` | unset = everyone | Narrows an ON product to named waIds; matched as raw text (lib/vas-config.js:102-108). |
| Launch scope | `WAPAY_WICODE_LIVE` | false | Fuel vouchers for customers (lib/vas-config.js:61). |
| Launch scope | `BLU_VAS_STUB_MODE` | false | Stubbed Blu calls for QA; throws in production (packages/providers/blu/src/vas.ts:43). |
| Pay-outs | `WAPAY_PAYOUT_ENABLED` | off unless true | Withdrawals exist at all (lib/payouts.js:50). |
| Pay-outs | `WAPAY_PAYOUT_ALLOWLIST` | unset = every customer | Narrows withdrawals to named waIds; matched as raw text (lib/payouts.js:65-72). |
| Pay-outs | `Global hold and approval mode` | not env: rows payout-hold:global and payout-mode:approval in processed_messages | Pause every pay-out, or queue every pay-out for the founder (lib/payout-hold.js). |
| Pay-outs | `WAPAY_PAYOUT_KYC` | anything but off or threshold = ID check for everyone | off = none; threshold = by amount (lib/payout-rules.js:31-37). |
| Pay-outs | `WAPAY_PAYOUT_DAILY_CAP_CENTS` | 300000 | Most any account can pay out in 24 hours (lib/payout-rules.js:48). |
| Pay-outs | `WAPAY_PAYOUT_KYC_SINGLE_CENTS, WAPAY_PAYOUT_KYC_DAILY_CENTS` | 100000, 100000 | Above these an unverified account needs the ID check in threshold mode (lib/payout-rules.js:49-50). |
| Pay-outs | `WAPAY_PAYOUT_NEW_ACCOUNT_DAYS, WAPAY_PAYOUT_NEW_ACCOUNT_DAILY_CAP_CENTS` | 7, 1000000 | Daily cap for young accounts (lib/payout-rules.js:46-47). |
| Pay-outs | `WAPAY_PAYOUT_MIN_CENTS, WAPAY_PAYOUT_MAX_CENTS, WAPAY_CASH_MIN_CENTS, WAPAY_CASH_STEP_CENTS` | 2000, 300000, 5000, 5000 | Amount limits; cash in R50 notes (lib/payouts.js:47-48, :211-212). |
| Pay-outs | `WAPAY_PAYOUT_EXPRESS_WINDOW_MINUTES, WAPAY_PAYOUT_EXPRESS_FEE_MULTIPLIER` | 120, 2 | Double fee on money under two hours old; on a bank account fresh money means next business day only (lib/payout-express.js:22-28). |
| Pay-outs | `WAPAY_PAYOUT_REVIEW_LEVEL` | 4 (off or 0 disables) | Triage level from which a pay-out waits for a person (lib/payout-triage.js:42-47). |
| Pay-outs | `WAPAY_PAYOUT_TEST_NUMBERS` | unset | Numbers whose pay-outs pass the hold as dry runs (lib/payout-hold.js:92). |
| Pay-outs | `WAPAY_PIN_RESET_COOLOFF_HOURS, WAPAY_PAYOUT_RESUME_HOURS` | 24, 24 | Cool-off after a reset without an ID check; how long a timed-out withdrawal can resume. |
| Pay-outs | `WAPAY_PII_KEY, WAPAY_PII_KEY_VERSION` | unset = nothing saved or sealed | Encryption of saved and in-flight bank and ID details (lib/pii-vault.js). |
| Pay-outs | `WAPAY_PIN_PROOF_SECRET` | falls back to PIN_PEPPER, then WAPAY_INTERNAL_API_KEY; none = no pay-out | Signs PIN proofs (packages/auth/src/pin-proof.ts:33). |
| Pay-outs | `OTT_PAYOUT_BASE_URL, OTT_PAYOUT_USERNAME, OTT_PAYOUT_PASSWORD, OTT_PAYOUT_API_KEY` | all four required | The rail is configured (lib/payouts.js:73-75). |
| Pay-outs | `WAPAY_FLOAT_WARN_CENTS, WAPAY_FLOAT_WARN_CENTS_OTT_PAYOUT, WAPAY_OTT_PAYOUT_FUNDED_CENTS` | unset | Low-float alarms and the drift figure. |
| Money in and links | `WAPAY_OWN_LINK_KYC_FIRST_CENTS` | 100000 (off disables) | From this amount a first own-link payment needs a verified ID (lib/own-link.js:24, :41-46). |
| Money in and links | `WAPAY_ADUMO_ENABLED, WAPAY_PRIMARY_CARD_RAIL` | false; ADUMO when unset | Adumo on; which rail the pay page offers (lib/adumo.js:65-70). |
| Money in and links | `PAYFAST_SANDBOX, PAYFAST_ENFORCE_SOURCE_IP, PAYFAST_PASSPHRASE, PAYFAST_MERCHANT_ID` | enforce IP false; passphrase and merchant id required in production | PayFast mode and ITN checks (pages/api/payfast/itn.js:156). |
| Money in and links | `WAPAY_DEPOSIT_FEE_BPS, WAPAY_DEPOSIT_FEE_FIXED_CENTS, WAPAY_ADUMO_FEE_BPS, WAPAY_ADUMO_FEE_FIXED_CENTS, WAPAY_VAT_REGISTERED` | 420 bps; VAT false | Card fee quoted and booked (lib/deposits.js:61, :100). |
| Money in and links | `WAPAY_PAYREQ_FREE_BELOW_CENTS, WAPAY_PAYREQ_MAX_OPEN, WAPAY_PAYREQ_MAX_PER_DAY, WAPAY_BIZ_PAYREQ_MAX_OPEN, WAPAY_BIZ_PAYREQ_MAX_PER_DAY` | 5000, 10, 20 | Free band and creation caps for links. |
| Money in and links | `WAPAY_HELD_GIFT_DAYS` | 30 | How long a send to a non-member is held before refund (lib/pending-gifts.js:305). |
| Money in and links | `WAPAY_REFERRAL_REWARD_CENTS` | 0 = track only | Above zero credits the referrer once per referred account (lib/referrals.js:71-74). |
| Money in and links | `WAPAY_FUEL_MIN_CENTS, WAPAY_FUEL_MAX_CENTS, WAPAY_FUEL_FLAT_FEE_CENTS, WAPAY_WICODE_COMMISSION_BPS` | fee 0 | Fuel limits and economics. |
| Onboarding | `WAPAY_ONBOARDING_ONE_STEP, WAPAY_PIN_ON_DEMAND, WAPAY_PAYER_PREREGISTER` | off (on, or a list of numbers) | One-message sign-up; PIN chosen when money first leaves; payer accounts pre-made (lib/onboarding-flags.js:23-40). |
| Onboarding | `WAPAY_ONBOARDING_OTP` | on (off skips the code) | The one-time code step (packages/auth/src/onboarding.ts:72). |
| Onboarding | `WAPAY_ONBOARDING_BUSINESS_QUESTION` | not asked unless the value is ask | The for-you-or-a-business question after sign-up (lib/business-chat.js:49-51). |
| Onboarding | `WAPAY_ONBOARDING_MARKETING_TEMPLATES` | off | Onboarding may use marketing-category templates (packages/auth/src/onboarding.ts:86). |
| Messaging and Meta | `WAPAY_ALLOW_MARKETING_TEMPLATES` | off | Lifts the hard block on MARKETING templates (packages/whatsapp/src/send.ts:316-331). |
| Messaging and Meta | `WHATSAPP_DIRECT_SEND` | off | Direct Send as a rail outside the window (lib/notify.js). |
| Messaging and Meta | `WAPAY_SEND_CAP` | 8 (never below 3) | Texts to one number in 20 s, per instance (lib/say.js:53-56). |
| Messaging and Meta | `WAPAY_TEMPLATE_PAYOUT_OUTCOME, WAPAY_TEMPLATE_MONEY_RECEIVED, WAPAY_TEMPLATE_SEND_REFUND, WAPAY_TEMPLATE_PAYMENT_RECEIPT, WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2, WAPAY_TEMPLATE_REQUEST_PAID, WAPAY_TEMPLATE_OPS_ALERT, WAPAY_TEMPLATE_SUPPORT_FOLLOWUP, WAPAY_TEMPLATE_ADMIN_OTP, WAPAY_TEMPLATE_BUSINESS_OTP, WAPAY_TEMPLATE_BUSINESS_REQUEST` | unset = that rail is absent | Names of approved templates for notices outside the 24 hour window. |
| Messaging and Meta | `WAPAY_AD_REMINDERS, WAPAY_AD_FIRST_LINK_RESUME_HOURS` | off unless on; 24 | The ad arrival's one reminder; late first-link answers (lib/ad-reminders.js:70). |
| Messaging and Meta | `WAPAY_OPS_ALERT_MSISDNS, WAPAY_OPS_ALERT_MIN_CENTS` | unset = no alerts | Operator money-in and float alerts (lib/ops-alerts.js). |
| Messaging and Meta | `WAPAY_BUSINESS_NOTIFY, WAPAY_BUSINESS_NUDGES_PER_DAY` | off | WaPay-originated sends for businesses. |
| Messaging and Meta | `META_APP_SECRET, WHATSAPP_VERIFY_SIGNATURE` | secret required in production | Webhook HMAC; with a secret present the check always runs (lib/webhook-security.js:75-84). |
| Portals and access | `WAPAY_ADMIN_HOST, WAPAY_BUSINESS_HOST, WAPAY_APP_HOST` | unset = no restriction; app default app.wapay.co.za (off disables) | Which host serves which portal (middleware.js). |
| Portals and access | `WAPAY_ADMIN_MSISDNS, WAPAY_ADMIN_SESSION_SECRET, WAPAY_ADMIN_PASSWORD_HASH` | unset = console closed | Mission Control login (lib/admin-auth.js). |
| Portals and access | `WAPAY_BUSINESS_MSISDNS, WAPAY_BUSINESS_SIGNUPS, WAPAY_BUSINESS_SESSION_SECRET` | registration closed; secret falls back to the admin one | Business portal registration and sessions. |
| Portals and access | `WAPAY_APP_SESSION_SECRET, WAPAY_APP_WHATSAPP_PAUSED, WAPAY_APP_BANNER, WAPAY_APP_DEV_FIXTURE` | secret falls back to business then admin; fixture development only | Personal portal sessions and banner. |
| Portals and access | `WAPAY_INTERNAL_API_KEY` | unset in production = 503 on requireInternalAuth routes | Internal routes, admin APIs, and the fallback key for operator links and PIN proofs (lib/internal-auth.js:66-76, lib/admin-auth.js:521-530, lib/ops-link.js:16, packages/auth/src/pin-proof.ts:33). |
| Portals and access | `CRON_SECRET` | unset or under 16 characters = crons refuse | Cron routes (lib/cron-auth.js:19-21). |
| Portals and access | `ADMIN_API_KEY` | unset = 401 | Four legacy admin routes. |
| Portals and access | `WAPAY_OPS_LINK_SECRET` | falls back to WAPAY_INTERNAL_API_KEY | Signs operator pay-out links and approval links. |
| Portals and access | `DIDIT_API_KEY, DIDIT_WORKFLOW_ID, DIDIT_WEBHOOK_SECRET` | unset = identity check not configured | KYC (lib/payout-rules.js:39-41). |
| Portals and access | `PIN_PEPPER, PIN_PEPPER_PREVIOUS` | in-source default if unset (logged in production) | PIN hashing (packages/auth/src/pin.ts). |
| Growth | `META_ADS_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_CAPI_DATASET_ID, META_CAPI_ACCESS_TOKEN, META_CAPI_ALLOW_NON_PRODUCTION` | unset = pipes are no-ops; non-production false | Ad insights in, conversion events out. |
| Infrastructure | `DATABASE_URL, TEST_DATABASE_URL` | tests use TEST_DATABASE_URL or a closed port | Database; tests can never reach the .env database (lib/prisma.js:11-17). |
| Infrastructure | `APP_BASE_URL, NEXT_PUBLIC_APP_URL, VERCEL_URL, PAYLINK_BASE_URL` | first set wins for self-calls | Base URL for internal fetches and links (lib/api-url.js:5-14); PAYLINK_BASE_URL is called retired in lib/payment-requests.js:233 and still read in pages/api/pay/checkout.js:192. |
| Infrastructure | `BLU_BASE_URL, OTT_BASE_URL, UNIFUEL_API_BASE_URL, UNIFUEL_PARTNER_SECRET, RESEND_API_KEY, ALERT_EMAIL` | Blu and OTT default to their test hosts in code | Supplier endpoints and credentials. |

## 10. Tests and gates

- node --env-file-if-exists=.env.test --test tests/*.test.mjs (package.json:11). Not run in this review.
- .github/workflows/tests.yml exists: Node 20, the pnpm cache step before pnpm is installed (lines 14-20). Not a working gate as far as the file shows.
- tests/e2e/chat-harness.mjs (shared: real processMessage, real database on a QA account, sends captured)
- tests/e2e/chat-qa.mjs (pnpm qa:chat)
- tests/e2e/chat-qa-vas.mjs
- tests/e2e/fuel-e2e.mjs (pnpm qa:fuel)
- tests/e2e/fuel-chat-e2e.mjs
- tests/e2e/business-e2e.mjs
- scripts/eval-agent.mjs (pnpm eval:agent, 34 agent cases, frozen baseline)
- scripts/eval-orchestrator.mjs (132 golden cases, eleven languages)
- scripts/verify-ledger-db.mjs
- Last committed harness report: docs/testing/chat-qa-report-2026-10-24.md
- 2026-11-13: 1,520 tests pass in a copy whose path has spaces; `next build` passes. The push gate is a session reading "fail 0", not a machine.

## 11. Structural risks and the smallest next step for each

1. **The chat brain is one 9,826-line file that grew a third while the plan was to halve it.** pages/api/webhooks/message-processor-v2.js: 9,826 lines, 155 functions, 116 import sites, 31 conversation states,handlePostOnboarding spans lines 1597-2880; handleConversationState spans 4967-7444,7,436 lines at 240526c, 8,304 at bafa652 (git show),43 of 154 test files read it as source text,It lives under pages/api with no default export, beside user-manager.js and _middleware.js *Next step:* Lift the thirteen intercepts above the shadow gate (lines 2019-2139) into one exported ordered table, in place, with no behaviour change. That is the C4 design, it serves both brains, and substring test locks survive an in-place export.
2. **One nightly function is the scheduler for fourteen jobs, three of them money.** pages/api/cron/daily-vas-sync.js:43-325: catalogue, embeddings, pay-out sweep, release floor, held-gift refunds, retention twice, integrity, growth, job drain, quality, compliance, audit,The file records two nights when later steps were starved (comments at :30 and :274),The pay-out sweep gets 5 rows and 20 s a day (:66); compliance and audit are handed off by a self-fetch that is aborted after 4 s (:249-256, :286-295),vercel.json:28-37 schedules only this and payout-release; payout-reconcile and adumo-reconcile exist unscheduled *Next step:* Give the money steps their own schedule: add /api/cron/payout-reconcile (already written) to vercel.json and remove the sweep, release floor and held-gift refund from the nightly run.
3. **processed_messages has become a switchboard: dedupe, heartbeat, delivery log, pay-out switches, claims and rate limits in one table with no retention.** Eleven modules write or read it: lib/payout-hold.js (the global hold and approval-mode rows and their log), lib/request-notify.js, lib/meta-compliance.js, lib/meta-alerts.js, lib/delivery-health.js, lib/outbound-guard.js, lib/ops-alerts.js, lib/app-auth.js, lib/payouts.js, lib/ledger-post.js, pages/api/webhooks/whatsapp.js,lib/payout-hold.js:4-6: no job purges that table by age,pages/api/webhooks/whatsapp.js:33 writes a pulse row per kind per minute,lib/app-auth.js:263 counts login attempts with a startsWith scan *Next step:* Move the two pay-out switches to a small settings table (one idempotent migration, two functions in lib/payout-hold.js); then add a purge for pulse and rate-limit prefixes to the housekeeping run.
4. **Money-out policy lives in nine modules and four surfaces while the policy engine gates nothing.** lib/policy.js:66-70 holds one requirement; the dispatcher drops it (processor:7851),lib/payouts.js:396-479 calls hold, rules, speed, express, proof, triage, approval in sequence,Four callers build a pay-out their own way: lib/payout-chat.js, lib/app-money.js, pages/api/business/payout.js, lib/ops-payout.js; ALL_METHODS is declared twice (lib/payout-chat.js:101, lib/app-money.js:320),docs/PAYOUT_RULES.md shows thresholds the code no longer has *Next step:* Export one payoutDecision() from lib/payouts.js that returns the ordered verdicts requestPayout already computes, and have the three quote surfaces call it. Record it as C11 in the architecture.
5. **Duplicated truth on live money states and switches.** Pay-out row status has eight stored values; four readers keep their own list: lib/context-pack.js:131-138 and :402, lib/agent/tools/read.js:233, lib/app-portal.js:304, lib/payout-books.js:24. On the agent path AWAITING_APPROVAL, SCHEDULED, REJECTING and NEEDS_OPERATOR all read as PENDING,Launch scope is implemented twice: lib/vas-config.js:36-64 honours WAPAY_LAUNCH_HOLD; packages/ai/src/orchestrator.ts:234-241 reads VAS_LIVE_* without it,Number lists are matched three ways: canonical digits (lib/shadow-list.js), normalised (lib/onboarding-flags.js:33-40), raw text (lib/vas-config.js:102-108, lib/payouts.js:65-72), the spelling trap of BUGLOG 73 *Next step:* Export one PAYOUT_STATUS map (stored value to customer meaning) from lib/payouts.js and import it in the four readers; it is a pure refactor with an immediate fix for the agent path.
6. **The golden thread's guard and the code disagree about who can approve money out.** docs/GOLDEN_THREAD.md rule 2.2 says only verifyPIN and the business step-up issue a proof,lib/ops-payout.js:171 and :302 issue one through an alias for the operator pay-out,tests/money-out-safeguards.test.mjs:110-114 looks for the text issuePinProof( and so passes,packages/auth/src/pin-proof.ts:33: the proof key falls back to WAPAY_INTERNAL_API_KEY, the same secret that opens internal routes, admin APIs (lib/admin-auth.js:521-530) and operator links (lib/ops-link.js:16) *Next step:* Add the operator pay-out to GOLDEN_THREAD section 2 as its own rule and change the structure test to match imports of issuePinProof, with lib/ops-payout.js on the allowed list. Founder decision whether the fallback to the internal key stays.
7. **One polymorphic intent table and two JSON columns carry lookups that will not scale.** ProviderRequest holds ten route kinds with indexes on accountId and status only (packages/domain/prisma/schema.prisma:162-177),The pay-out finaliser finds a row by metadata.reference (lib/payouts.js:648, :739; pages/api/ops/approve.js:21),Every pay-out request scans accounts for profile.payouts.frozen (lib/payout-triage.js:127); the watchlist does the same (lib/watchlist.js:38),Referral codes are looked up by JSON path (lib/referrals.js:264, :379),Account.profile holds KYC, freeze, clearance, attribution, referral, PIN reset, onboarding path and notes *Next step:* Add a nullable reference column with an index to ProviderRequest and backfill it for route ott-payout; add an index on (route, status, requestTs).
8. **About eighteen queries and four database clients per model turn.** Before routing: fuel, electricity and pay-out reconcile probes, held gifts, pending gifts, state, inbound record (processor:1616-1881),A model turn adds a ten-read Promise.all plus turns and profile (lib/context-pack.js:364; processor:7613-7617),Four PrismaClient instances per function instance: lib/prisma.js:22, packages/domain/src/db.ts:16, packages/whatsapp/src/templateCatalog.ts:12, packages/whatsapp/src/seedTemplates.ts:13,Caches and the send cap are in process memory (lib/say.js:51, lib/payout-hold.js approvalCaches, lib/payout-float.js) *Next step:* Make the packages take the client from one place (inject lib/prisma.js into @wapay/auth and @wapay/whatsapp), then fold the three reconcile probes into one query on ProviderRequest for stuck rows.
9. **No automatic test gate, and the live-brain harness has no committed run since 24 October.** .github/workflows/tests.yml:14-20 sets up the pnpm cache before installing pnpm and pins Node 20; CLAUDE.md:47 requires the Node 24 glob form,The eval (166 cases) and pnpm qa:chat are run by hand (package.json:20-23),Newest harness report: docs/testing/chat-qa-report-2026-10-24.md; CHANGELOG 128 to 139 followed,No test names /api/ops/payout-link; /api/cron/payout-release is covered only through releaseDuePayouts in tests/payout-speed.test.mjs *Next step:* Repair the workflow (install pnpm first, Node 24) so main shows red or green on every push; add a route test for /api/ops/payout-link beside tests/ops-link.test.mjs.
10. **Access gates come in six shapes and nothing lists them.** requireInternalAuth, fail closed in production (lib/internal-auth.js:66-76),Nine inline copies of the key check in pages/api/internal (for example payout-status.js:22-34, meta-status.js:20-52),requireAdmin accepts a session or the internal key (lib/admin-auth.js:521-535),ADMIN_API_KEY on four legacy admin routes, two of which take it in the query string (pages/api/admin/sync-vas-catalog.js:13-16, whatsapp-debug.js:17-22),Signed tokens on /api/ops,No gate found on /api/admin/init-templates, /api/admin/list-wabas and /api/wallet/balance *Next step:* Add one static test that maps every file under pages/api to a declared gate and fails on a new file without one; use the table in inventory.routes as its first version.

## 12. Documents behind the code on 2026-11-13

The corrections themselves (51, each with the wrong line and the right fact) are on the programme board under System and in the review file kept with it.

| Document | Corrections waiting |
|---|---|
| docs/AGENT_ARCHITECTURE_V2.md | 12 |
| docs/architecture/rows.json | 8 |
| docs/CAPABILITIES.md | 8 |
| docs/GOLDEN_THREAD.md | 6 |
| CLAUDE.md (repo) | 5 |
| docs/architecture/phase-map.svg | 3 |
| docs/architecture/README.md | 1 |
| docs/CHANGELOG.md | 1 |
| docs/PAYOUT_RULES.md | 1 |
| docs/PAYOUTS.md | 1 |
| docs/HANDOVER_PROMPT.md and docs/HANDOVER_V1.6.md | 1 |
| docs/HANDOVER_PAYOUTS_V1.md and V2 | 1 |
| docs/HANDOVER_V1.3.md | 1 |
| docs/HANDOVER_V1.4.md, V1.5, BLU_V1, COMMERCIALS_V1 | 1 |
| code comments (not a doc, but they mislead the same way) | 1 |

