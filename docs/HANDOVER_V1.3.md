# WaPay Build continuation v1.3 — handover

Written 2026-08-29 by the v1.2 session, from the founder's voice notes. This is the
work order for the next thread. Read in order before touching anything:
`CLAUDE.md`, `WAPAY_BUILD_TRACKER.md`, `docs/CAPABILITIES.md`, `docs/BUGLOG.md`,
then the memory index. The fast working copy is `~/Projects/wapay` (never install
deps in the iCloud tree); the iCloud tree is the deploy source — follow the rsync
sweep discipline in memory `review-agents-read-only` (always `rsync -rcn
--itemize-changes` and inspect before syncing).

---

## Task 1 — Supplier float visibility in Mission Control

We fund prepaid floats at suppliers and currently fly blind on them. Provision for
wallet-balance tracking of:

| Float | Supplier API? | Where |
|---|---|---|
| OTT voucher issuance float | **YES — already implemented.** `getBalance()` in `packages/providers/ott/dist/client.js` (GetBalance → current + available, integer cents) | Call it, don't rebuild |
| OTT payout float | **YES — already implemented.** `getBalance()` in `lib/ott-payout.js:303` (`/api/purchase/v1/GetBalance`) | Call it, don't rebuild |
| Blu (BlueVas) trade account | **UNKNOWN.** Our notes came off their Swagger UI and show no balance endpoint. The OpenAPI spec + this exact question are already in the outstanding ask to Phuti (see `docs/BLU_VAS_CATEGORY_REQUEST.md`) | If the spec shows one, wire it; else ledger-side only until Phuti answers |
| PayFast | PayFast is an acquirer, not a float: money settles to our bank. Verify whether api.payfast.co.za exposes a balance/settlement query; at minimum pull transaction history for reconciliation | Verify before building |

Build a **Supplier floats** card in Mission Control (money-engine health area):

1. **Ledger view** (always available): our double-entry clearing accounts already
   track what we believe sits at each counterparty — derive per-supplier positions
   from `CLEARING:*` account codes.
2. **Supplier view** (where APIs exist): pull the two OTT balances server-side on
   dashboard load (admin-gated route, cache ~60s, never from the browser directly).
3. **Drift** between the two views, same visual language as the existing
   trial-balance/wallet-drift pills.
4. **Low-float warning** thresholds so we know when to top up before vends fail.

Never log or expose API credentials in the process. Internal-key/session gate like
every other admin route.

## Task 2 — Conversational quality: the help-menu fallback is customer-hostile

Screenshot evidence (founder, 2026-08-29): customer asked **"Where can I spend my
WaPay money!"** and got the generic WaPay Help Menu — twice in a row. That is a
routing bug AND a product decision:

1. **Diagnose why** the free-text router in
   `pages/api/webhooks/message-processor-v2.js` fell through to the help menu for
   that phrasing. Fix the routing so open questions reach the conversational/LLM
   path, not the menu. The menu is a last resort, not a default.
2. **Personality mandate (founder, verbatim intent):** responses must be
   personalized and conversational — "like speaking to your bank", with a
   personality: what *"Pay"* should be. Nice emojis in **all** customer responses.
   This should be part of testing: add conversation-level tests that assert
   question-shaped inputs never get the bare menu.
3. **"Where can I spend?" must get a real, warm answer**: airtime, data,
   electricity for any meter, vouchers for the OTT retail network, send money to
   any WhatsApp contact, pay requests. Localized (all 11 languages pipeline
   exists), concise, with emojis.
4. **Cash-out asks** (balance withdrawal): the honest scripted position is —
   not available *yet*; it's coming soon via our payouts capability with OTT
   (Payout agreement SIGNED 2026-08-25, integration in progress — see memory
   `ott-collect-decision`); meanwhile guide them conversationally through
   everywhere they CAN spend. Never promise a date. Never mention that voucher
   balances were ever considered cashable (memory `voucher-as-balance-rejected`).
   KYC applies on withdrawal only when it ships (locked model).

**Hard constraints that survive any rewrite:** no betting/gambling promotion in
WhatsApp ever (Meta policy — memory `meta-gambling-policy`); voucher PINs are
bearer secrets, never in logs or admin responses; POPIA — no full ID/document
numbers anywhere.

## Task 3 — UniFuel integration (the big one)

**Context:** UniFuel is our company too. Repo:
`~/Library/Mobile Documents/com~apple~CloudDocs/Desktop/UniFuel.co` — read its
`HANDOVER.md` (excellent, verified 2026-08-09) and `docs/yoyo-production-status.md`
FIRST. UniFuel sells prepaid fuel vouchers: PayFast payment → Yoyo/WiGroup issues a
**wiCode** gift card → WhatsApp + email delivery → redeem at the forecourt.

**Ground truth you must respect:**

- Yoyo/wiCode is in **TEST MODE**. Production credentials are blocked on Yoyo's QA
  finalisation + Dean's verification, and production costs ~R15,000/month. Test
  vouchers DO NOT work at pumps. Nothing customer-facing may claim fuel redemption
  until that unblocks.
- Redemption reality when live: **Shell** (~85% of stations, pump + convenience
  store), **Engen** (forecourt till only). **TotalEnergies NOT onboarded.** Say
  "participating stations", never "any station".
- wiCode retail economics (memory `wicode-retail-economics`): no Spar on the
  network, the ~5% commission is in fast food, partial redemption complicates the
  code lifecycle. Verify the actual redeemable retail catalogue with Yoyo before
  advertising any of it.
- UniFuel already runs: live PayFast rail (merchant 27749361), WhatsApp Cloud API
  (+27 76 049 7624, 3 approved templates), **Resend email** (noreply@unifuel.co,
  domain verified), Supabase, cron retry queue (fixed 9 Aug).

**What the founder wants:**

1. **WaPay wallet → wiCode retail spend.** Over and above the OTT retail network,
   customers must be able to spend their WaPay balance wherever wiCode is
   accepted, because we earn commission on that spend. Design the flow: WaPay
   debits the wallet → UniFuel/Yoyo issues the wiCode → delivered in the same
   WhatsApp chat.
2. **Fuel purchase from chat.** "Buy fuel" in WaPay → issue a UniFuel fuel voucher
   (wiCode) from wallet balance, redeemable at a selected service station
   (Shell/Engen when live). Study UniFuel's issuance pipeline and reuse it.
3. **Two codebases, one system.** Do NOT merge the repos. UniFuel becomes the
   fuel/wiCode issuance service; WaPay stays the wallet + conversation front.
   Tight service-to-service integration (authenticated API between the two Vercel
   apps), each leveraging the other's existing infrastructure — do not rebuild
   what UniFuel already has.
4. **Resend for WaPay comms.** Reuse UniFuel's working Resend integration pattern
   for WaPay email — but on WaPay branding and a WaPay domain (verify
   wapay.co.za in Resend; never send WaPay mail from the UniFuel identity).
5. **Money flow through the ledger.** Every wiCode issuance is a double-entry
   posting: wallet debit → `CLEARING:YOYO` (new account code), commission line →
   `REVENUE:*`. Integer cents only. The founder's economics: customer spends from
   the wallet, we earn the commission.

**Deliverable for Task 3:** an integration design doc first (API contract between
the apps, ledger postings, failure/refund paths, what's gated on Yoyo production),
then a phased build — phase 1 can ship against the Yoyo TEST env end-to-end with
an explicit "not redeemable yet" internal flag, so flipping to production is a
credentials change, not a build.

## Standing rules (do not relearn these the hard way)

- Review agents are READ-ONLY; mutations only by the main session (BUGLOG #24/#25).
- Never push a red test. Run the full suite + build before any rsync/commit.
- No card surcharging anywhere, ever (PayFast T&C 5.3 + SARB/PASA).
- KYC on withdrawal only. Flat fees. Spend vs cash balance model is locked.
- Never call OTT `GetAPIKey` (it rotates the live key).
- Key rotation of leaked Blu QA + Meta secrets is STILL OUTSTANDING (memory
  `key-rotation-deferred`) — re-raise before launch.
- Remittance needs counsel sign-off before any build.
- Admin console lives on admin.wapay.co.za; login = WhatsApp "admin login" to the
  WaPay number; Vercel bot-challenge exemption may still be pending (BUGLOG #34).

## v1.3.1 amendments (founder, 2026-08-29 PM)

These refine the tasks above and change the execution mode:

1. **Build fully against the Yoyo TEST environment now — including verification.**
   Do not wait for Yoyo production. Everything ships end-to-end on test
   credentials; going live is a credentials/flag flip, not a build. The founder is
   separately asking Yoyo to enable **additional merchants** on the platform, so
   the redeemable-merchant catalogue must be **data, not hardcoded copy** — it
   will grow.
2. **Bake the wiCode/UniFuel knowledge into the WaPay brain.** The bot must be
   able to advise customers conversationally: where they can shop, what they can
   buy, and *how* redemption works — both pre-purchase ("here's what you can get
   with your balance") and post-issuance ("here's how to use the wiCode you just
   received at a participating Shell/Engen"). Redemption guidance per voucher
   type (wiCode at POS, partial redemption behaviour, participating-stations
   caveat). Customer-facing claims that a voucher is redeemable at real stations
   are **gated on the production-live flag** — in test mode the brain knows the
   catalogue but presents fuel/retail as "coming soon".
3. **Mission Control gets the Yoyo/UniFuel layer**: wiCode issuance in the
   "what's being sold" categories (new journal sources → SELLING_LABELS),
   `CLEARING:YOYO` in supplier floats, UniFuel issuance/redemption stats surfaced
   via the service-to-service API.
4. **Execution mode: autonomous end-to-end loop.** Build → test → fix →
   re-test recursively until every function above is complete and verified;
   only notify the founder when EVERYTHING is done and tested end-to-end.
   Use the multi-agent Workflow harness with adversarial review before ship
   (review agents READ-ONLY). "Tested end-to-end" means: full unit suite green,
   `pnpm qa:chat` conversation harness green (including the new
   question-never-gets-bare-menu assertions), build green, deploy verified in a
   real browser, and the Mission Control panels rendering real data. Finish with
   a single founder report: what shipped, what's gated on Yoyo production, and
   the short list of founder-only actions (Vercel/DNS/supplier emails).

## Suggested order

1. Task 2 (conversational fix + brain knowledge) — live-customer-facing.
2. Task 1 (floats, now including CLEARING:YOYO) — mostly wiring existing clients.
3. Task 3 (UniFuel integration) — design doc, then build against Yoyo TEST
   end-to-end per amendment 1.
4. The autonomous loop closes over all three until done; one report at the end.
