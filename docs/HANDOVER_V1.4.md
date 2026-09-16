# WaPay Build continuation v1.4 — handover

Written 2026-09-16 by the v1.3 session (thread `491a1a32`), from the founder's fourth
chat review (2026-09-15 21:38 to 2026-09-16 08:36) and everything built since the v1.3
ship on 2026-08-29. This is the work order for the next thread. Read in order before
touching anything: `CLAUDE.md`, `WAPAY_STATUS.md` (iCloud root, the versioned living
status), the newest entry of `WAPAY_BUILD_TRACKER.md`, `docs/CAPABILITIES.md`,
`docs/BUGLOG.md` (#43 to #55 are the conversation and payout story), the memory index,
then `docs/AGENT_ARCHITECTURE_RECON.md` (the plan this brief executes). The fast working
copy is `~/Projects/wapay` (never install deps in the iCloud tree; its `.git` is corrupt,
"bad object HEAD", which does not matter because commits happen from the iCloud repo);
the iCloud tree `WaPay V1.01` is the deploy source. Always `rsync -rcn --itemize-changes`
and inspect before syncing (memory `review-agents-read-only`).

---

## 0. The mandate (founder, 2026-09-16, verbatim)

> "I still get a clear sense that we are not running the orchestration agent right. It's
> not like a super orchestrator that is empowered by all sources of information. It gives
> very stochastic answers in terms of the customer memory and history. It doesn't know,
> and it can't match that with what products and services are available. I just don't
> get that full intelligence feel that WaPay is really being orchestrated right.
> Fundamentally, I think there's a big issue here that we need to address."

> "It's still not responding like a chatbot, streaming the answers and giving me an
> individual answer each time. It doesn't feel like it. It just gives me menu options."

> "The whole idea is to build an agentic native layer for the context of all the
> customer's transactions."

In one sentence: **v1.4 is the agent described in `docs/AGENT_ARCHITECTURE_RECON.md`
§5 (context pack, capability registry, read tools, proposal tools, one loop per turn
behind a hard money boundary), not another round of regex patches.** Phase 0 and 0.5 of
that plan shipped on 2026-09-13/15; Phase 1 and Phase 2 are this brief.

---

## 1. Founder review 4: every screenshot, what it proves, where it stands

| # | The founder typed | Pay answered | What the founder wants (his words) | Root cause | State |
|---|---|---|---|---|---|
| 1 | "How can I withdraw money?" | The four-step walkthrough (`TOPICS.withdraw.answer` in `lib/how-it-works.js`: say withdraw and the amount / choose how / give the details / confirm and PIN, plus the identity-check line and the collection steps), then after YES the method menu | "This is a very simple answer. The user asked and I just gave it such a long answer, which looks like a static menu option. The user didn't ask for steps on how to withdraw money. It's just 'How can I withdraw money?' and say 'We have various options for how you can withdraw money' and just mention the options like you would in a conversation and then say 'How would you like the money to be withdrawn?' and then I'll guide you through the step by step. Instead of giving all this unnecessary information with a simple question, this sort of thing should be prompted to avoid it happening." | `wantsSteps()` treats "how can I" the same as "how do I": both earn the walkthrough. The `brief` (BUGLOG #51) exists and is the right shape, but this phrasing never reaches it. More fundamentally: a template chooses between two fixed strings; nothing composes a two-line answer with one question from the live option list. | **Open. v1.4 Task 3.** |
| 2 | The PayShap flow: 1, 50, account number, FNB, 13-digit ID, Yes, PIN | "⏳ Sent. R50 has been handed to the bank rail (reference WPC15800A7BD6637). I'll message you the moment the bank confirms it, usually within minutes." Then, at 21:57: "Yes, I will message you here as soon as the bank confirms it" and "if a withdrawal fails, the money is returned to your WaPay balance" | "How can we test that this works? Can we test that it works with the float that's been added to our bank account or to our payouts account? … we'll do a payout to a specific account here based on the float we have available and then we'll just reconcile our systems to have the R58 that we have from the customer here in WaPay stay in an account wherever that is. We need a proper reconciliation ledger in our super business admin portal, of course, where we know: the clients' funds and where they sit; where the payouts sit so that we are always in positive." | The ledger side worked exactly as designed (SPEND to CASH, R58 hold, one PerformPayout). OTT's sandbox answered with a status code outside our table; the intent parked as PENDING/UNKNOWN with nothing recorded, the sandbox sends no webhook, and nothing existed to ask OTT again. The promise "I'll message you" could never be kept (BUGLOG #53). No reconciliation view exists in Mission Control beyond the supplier-float card. | **Reconcile path BUILT and deployed 2026-09-16** (`reconcilePayout`, `GET /api/internal/payout-reconcile`, chat asks the rail live). **Open: a scheduler for the sweep and the Mission Control payouts reconciliation card (v1.4 Task 5).** |
| 3 | "How does fnb e wallet work?" then "Okay" and "I'll try later" | The eWallet brief; "Cool 😊 If you want to start, just type withdraw R<amount>."; "No stress 😊 When you're ready, just type withdraw R<amount>." | No annotation. Acceptable, but the two acknowledgements are canned strings, not a reply to what was said. | The fallback for a non-intent message is a fixed sentence. | Folds into Task 4 (the agent composes). |
| 4 | "Where can I spend my OTT voucher?" | One paragraph: accepted online at Talk360, fibertime, ikeja, Capitec Connect, megsApp, Pay@, Xash, FoondaMate, LAYAWAY; not at supermarket tills, Takealot, Netflix, Showmax, Spotify, the networks' own sites; the 12-digit PIN; ottvoucher.com; then the YES offer | "This list should be a nice structured list. It shouldn't be all over the place like this. It should be formatted nicely always, not just this list. Any time a customer asks something and it's a long answer, the agent must try and break up that answer before he gives a long answer, if possible, or just give information (like high-level information at these retailers, blah, blah, blah). Point out where it's not accepted for example. This is just a chunk of text. It just doesn't feel like it's a natural conversation." | `TOPICS.ott.answer` and `lib/ott-acceptance.js` render facts as prose. There is no formatting policy anywhere: nothing says "three or more items become a list", nothing says "accepted / not accepted / how to pay are separate headed lines". | **Open. v1.4 Task 3.** |
| 5 | 08:35 "Did my payment to tbh go through" and then "No my payment to my fnb account I did last night?" | Twice: "✅ Your R20 deposit was received. 💰 Balance: R8.00" (a card deposit from weeks earlier; the R50 PayShap from 21:52 the night before was never mentioned) | "It doesn't feel like there's a natural understanding of the past transactions inside of WaPay. The whole idea is to build an agentic native layer for the context of all the customer's transactions. When I ask a question as a user, 'Did my payment go through?' even if there was a spelling mistake, it should know what payment the customer is referring to. Look at all the latest payments that were made, bring that into context and say 'This payment, the last payment, are you referring to this? I assume you're referring to this last payment. No or yes, it didn't go through.'" | `handleDepositStatus` only ever read the newest PayFast deposit; no pay-out lookup existed in the chat (recon §3). The first message matched the deterministic status regex, the second was classified `DEPOSIT_STATUS` by the AI; both funnel into the same deposit-only handler (BUGLOG #54). The general capability (every recent movement in context, disambiguation between candidates) is recon Phase 1 and does not exist. | **Deposit-versus-pay-out FIXED and deployed 2026-09-16** (newest deposit AND newest pay-out, the words decide, PENDING reconciled live). **Open: the context pack and disambiguation (v1.4 Task 1).** |
| 6 | "Home" (three times over the evening) | The home screen: balance, voucher balance, Buy / Send / Get Paid / Deposit / Fuel / Withdraw / Transactions / Settings, quick actions | "It just gives me menu options." | The home screen IS a menu, and "📄 Transactions" on it still has no handler (recon §2). The founder typed Home himself; the menu is not wrong as a home, but it is the only shape the bot has for "what can I do". | Task 1 (Transactions handler) and Task 2 (registry renders the home from the gates). |

Everything above is in the conversation history stored on the founder's account
(`Account.conversationData.history`, 27787051175) and in the screenshots in the thread.

---

## 2. The fundamental issue, stated precisely

The recon of 2026-09-13 (`docs/AGENT_ARCHITECTURE_RECON.md`, verified by two independent
refuters per finding) already names it; the fourth review confirms every point:

1. **Twenty-six deterministic hooks run before the model.** Most question-shaped messages
   are caught by a regex and answered with a template. The templates are careful and
   localized, and they are why the product feels like a menu.
2. **The model sees no facts about the customer.** Per turn it gets the profile block
   (language, deposit method, last meter, interests) and the last five history lines.
   Balance, transactions, pending pay-outs, open pay links, vouchers and KYC status never
   reach it. "Stochastic answers about history" is the absence of any read path from the
   ledger to the conversation, not a model weakness.
3. **Truth is hand-written in six places** (PRODUCT_TRUTH, home screen, Help Menu,
   no-OpenAI fallback, onboarding welcome, VAS list). Phase 0 made fees, cash-out and the
   product list read the gates; the rest still drifts.
4. **No composition policy.** Every canned answer is a paragraph. Nothing decides when
   an answer is a list, when it is two lines and a question, when it is a walkthrough.
5. **Memory is half-written.** Only AI-routed turns store the customer's own words;
   deterministic turns store the bot's reply alone; the current message is written before
   history is read (recall is four turns); STS tokens sit in history; writes are
   non-atomic.

The money boundary is right and must survive: the model proposes, deterministic PIN-gated
flows execute, idempotency keys derive from previews, holds settle or release only on a
known answer from the rail (BUGLOG #28, #53).

---

## 3. The v1.4 work order

### Task 1 — The context pack and the read path from the ledger to the conversation (recon Phase 1)

Build `lib/context-pack.js`: **one database round trip per turn** returning, for the
customer: SPEND and CASH balances (held amounts separately), the last five money
movements across every table (PayFast deposits, OTT voucher loads, sends and gifts
(`PendingGift`), VAS vends and fuel (`ProviderRequest`), pay-outs (`ProviderRequest`
route `ott-payout`), pay links (`PaymentRequest`)) each as `{ kind, amountCents, status,
counterparty (masked), reference, at }`, any PENDING pay-out, open pay links, KYC status,
saved recipients (names only), preferred language, voucher count.

Use it in three places:
- **Every AI turn**: rendered as a `KNOWN CUSTOMER FACTS` block after the knowledge block.
- **The status answers**: "did my payment go through" and all its variants pick from the
  pack; when two or more movements happened in the last 24 hours the answer names the
  newest and asks ("I assume you mean the R50 PayShap from last night, reference
  WPC15800A7BD6637, still with the bank; or the R20 card deposit?"). Spelling mistakes and
  "to tbh" must not matter: the candidate set comes from the pack, the words only rank it.
- **"Transactions"** (the home-screen line with no handler), "my transactions", "what did
  I buy last week", "who paid my link", "my withdrawals": deterministic lists from the
  pack, newest first, ten rows, localized.

Acceptance: the exact founder exchange of row 5 answered correctly in the harness
(pay-out named, reference given, held amount explained), plus the four queries above; a
pay-out that is PENDING is reconciled with OTT before the answer (already built:
`reconcilePayout`).

### Task 2 — The capability registry (recon Phase 1)

`lib/capabilities.js`: `capabilities(waId)` returns what is live for THIS customer (VAS
categories from `isCategoryEnabledForWaId`, fuel via `fuelLiveFor`, withdrawals via
`payoutAllowedFor`, OTT voucher self-purchase, OTT voucher load, card deposit rails,
business features) with, per capability: label, one-line description, the start command,
the fee line (from `lib/fee-facts.js`), limits. **Every** surface renders from it:
PRODUCT_TRUTH in the orchestrator, the home screen, the Help Menu, the no-OpenAI fallback,
the onboarding welcome, `handleListVasProducts`, `lib/how-it-works.js` topic availability,
`lib/spend-catalogue.js`. Delete the hand-written copies as each is replaced; a test
asserts no surface names a capability the registry does not.

### Task 3 — Composition policy (rows 1 and 4; the quickest visible win)

Rules, enforced in code and in the agent's style prompt:
- A capability question gets **two lines and one question**: what is possible, the
  options by name, "How would you like it?". Row 1 becomes: "You can take money out by
  PayShap into your own bank account (R8, minutes) or as cash at an Absa or Nedbank ATM,
  a Pick n Pay or Boxer till, or an FNB eWallet (from R18). How would you like it?" and the
  answer starts the flow at the method step.
- **"How can I / can I / is it possible"** are capability questions (brief). **"How do I /
  what are the steps / instructions"** earn the walkthrough. Fix `wantsSteps()` in
  `lib/how-it-works.js` accordingly and pin both phrasings.
- **Three or more items become a list**, one per line, with a short header; "accepted at"
  and "not accepted at" are separate blocks; the how-to-pay line comes last. Rewrite
  `TOPICS.ott.answer` and the acceptance renderer to that shape. Row 4 becomes a headed
  list.
- A long answer is never sent whole when it can be split: send the summary, offer the
  detail ("Want the full list? Reply YES").
- The acknowledgements ("Okay", "I'll try later") are answered in the customer's own
  terms by the model, not by a fixed sentence (Task 4 covers it; until then keep them).

Acceptance: harness scenarios with the four exact founder messages of rows 1 and 4
asserting line counts, list markers and the closing question.

### Task 4 — The agent loop behind a shadow list (recon Phase 2)

`@wapay/tools` (in-process TypeScript package, categorised): read tools
(`get_context`, `get_transactions(range)`, `get_fee_quote(kind, amount)`,
`get_products(category, query)`, `get_vouchers`, `get_pay_links`,
`get_payout_status(reference)`, `where_accepted(network, merchant?)`) and proposal tools
(`start_buy_airtime`, `start_buy_data`, `start_electricity`, `start_send`,
`start_pay_link`, `start_deposit`, `start_withdraw`, `start_fuel`, `start_voucher_load`).
One loop per turn: system prompt = persona + policy + the registry + FEES + HOW IT WORKS;
the context pack prefetched so most turns need zero tool calls; at most three tool calls;
proposals hand off to the existing confirm, PIN and idempotent execute flows with slots
re-validated exactly as `dispatchOrchestratorAction` does. Behind
`WAPAY_AGENT_V3_MSISDNS` (the founder's number first); old and new paths side by side on
the 132-case golden corpus (extended with withdraw, fee, status and discovery cases) and
the chat QA harness; measure action accuracy, latency and cost; promote per language.
Model ids stay env-tunable.

### Task 5 — Pay-out operations: the founder's reconciliation ask (row 2)

1. **A scheduler for the sweep.** `reconcilePendingPayouts` exists; nothing calls it.
   Vercel Hobby crons are daily, so either confirm the project is on Pro and add
   `/api/cron/payout-reconcile` every 10 minutes to `vercel.json`, or trigger
   `POST /api/internal/payout-reconcile` from UniFuel's existing job runner (it already
   has a cron and the internal key can be shared), or from the daily VAS sync as a floor.
2. **Mission Control "Payouts" card**: pending pay-outs (count, total held), each with
   reference, method, age, last provider status, a Reconcile button (calls the internal
   route); settled today; failed today; and the drift between `CLEARING:OTT_PAYOUT`
   (or the rail-cost clearing account the ledger uses for pay-outs) and OTT's GetBalance.
   The founder's words: "the clients' funds and where they sit; where the payouts sit so
   that we are always in positive."
3. Ask OTT (email 9, drafted) which status code the sandbox returns for a PayShap payout
   and whether the test webhook fires; add the code to `classifyPayoutStatus` by name.

### Task 6 — Memory hygiene (recon §3)

Store both sides of every turn (deterministic turns included); read history before
writing the current message; redact bearer values (STS tokens, voucher PINs, wiCodes)
before storage; atomic jsonb merges for `conversationData`; a thirty-day retention job.

### Suggested order

Day 1: Task 5.1 (scheduler) and Task 3 (composition; the founder sees it immediately).
Days 2 to 5: Task 1 then Task 2 (the pack and the registry are the foundation of Task 4).
Week 2: Task 4 behind the shadow list, harness and corpus expanded, adversarial review
(read-only agents), promote the founder's number. Task 6 alongside Task 4. Task 5.2 when
the pack exists (it is the same data).

Run `pnpm test` (634 today), `pnpm build`, and `pnpm qa:chat` before every push; the
harness is the only thing that drives the real processor with the real brain.

---

## 4. What was built in this thread (2026-08-29 to 2026-09-16)

Two sessions worked in parallel for most of this period. This session (`491a1a32`)
carried v1.3 and the items marked (this session); the peer session (`wapay-bb`, later
`wapay-24`) carried the business portal, the payout chat flow and the conversation
knowledge base, recorded in tracker Deltas 16 to 25. Commit hashes are from the iCloud
repo (`git log`).

**v1.3 (this session, shipped 2026-08-29, `6e32871` + UniFuel `51e90d0`)**: supplier
floats card (`/api/admin/floats`), spend catalogue + "Pay" persona + never-the-bare-menu
routing (BUGLOG #34a), UniFuel fuel pipeline end to end on Yoyo TEST (`lib/unifuel-client.js`,
`lib/fuel-settlement.js`, `/api/vas/fuel/*`, `/api/webhooks/unifuel`), per-user fuel gate
`fuelLiveFor()`. Adversarial review: 77 agents, 34 findings fixed pre-ship
(`docs/testing/adversarial-review-2026-08-29.md`). Memory `v13-shipped-unifuel-live`.

**After v1.3 (this session):**
- Admin console password sign-in (`WAPAY_ADMIN_PASSWORD_HASH`, self-contained argon2id,
  `HASH_MALFORMED` diagnostic, login page no longer advertises the chat command).
- OTT Redemption client on spec v6 (`lib/ott-redemption.js`, `da59d9b`) and the
  cash-in rail "load an OTT voucher into the wallet" (`8c726e8`); rails probe
  `/api/admin/rails-check` (`115d048`).
- `docs/WICODE_NETWORK.md`, `docs/STORE_TEST_PLAYBOOK.md`, `docs/PAYFAST_FEES.md`
  (`b0319ee`; PayFast rates are excl VAT, Mukuru Cash loses money), `EMAIL_TO_SIPHO_YOYO.txt`
  (campaign list Checkers, Shoprite, Pick n Pay, KFC, Engen, Shell; Total deferred;
  five-brand fallback drops Checkers), `EMAIL_TO_KEAMO_8_LIVE_CREDENTIALS.txt` (`44ff5d9`).
- Cash-out pilot gate `WAPAY_PAYOUT_ALLOWLIST` (`3a40272`, and `4e16daa` which fixed a
  ReferenceError that 3a40272 shipped: `payoutAllowedFor(from)` inside a function with no
  `from`; lesson recorded below).
- **2026-09-16 (this brief's commit): pay-out reconciliation** (BUGLOG #53), the status
  handler covers pay-outs (#54), the processor import guard (#55).

**Peer session (tracker Deltas 16 to 25):** WaPay for Business portal (`9784923`,
`ed7d171`, `4ffcc46`), business sign-up in chat (`71b0a35`), Meta diagnostics and the OTP
template fix (`cb11328`), Adumo Online rail (`3a3ade3`, `2a730a0`), withdrawals in chat
(`f2b66da`), pay-out fees +R2 (`ea290eb`), truth-is-data fixes #43 to #45 (`0d5e477`),
the recon (`bf409f5`), PayShap by account number (`e227f16`), OTT live provider mapping
#46/#47 (`cd1395c`), the conversation knowledge base #48/#49 (`3940829`), FNB eWallet and
Nedbank methods (`2fa7b78`), idle expiry / briefs / minimums #50 to #52 (`e098ade`).

---

## 5. Where every rail stands (2026-09-16)

| Rail | Environment in production | State | Evidence / probe |
|---|---|---|---|
| WhatsApp (Meta WABA) | live | inbound + outbound live; OTP pushes on the approved authentication template; delivery pulse rows | `/api/internal/meta-status` |
| PayFast deposits | live | first real deposit 2026-08-18; fees documented; Mukuru Cash to be disabled in the PayFast dashboard | `docs/PAYFAST_FEES.md` |
| Adumo Online (Nedbank/SHB) | sandbox-proven, OFF | `WAPAY_ADUMO_ENABLED` unset; needs SHB written confirmation on third-party processing | `docs/ADUMO.md` |
| OTT issuing (vouchers, gifts) | **TEST host, TEST creds** (WAPAYVIT) | live gifts work end to end on the test float (R99,960 on 2026-09-16); live portal credentials received (Issuer + Merchant portals, beneficiary OTT1416, Vendor ID 11) and NOT yet applied | `/api/admin/floats` |
| OTT redemption (load an OTT voucher) | **TEST host**: `OTT_MERCHANT_BASE_URL=https://test-api.ott-mobile.com` | built and probed; live = the same URL without `test-`: `https://api.ott-mobile.com` (spec v6, same host as issuing, `/api/v1/`) | `/api/admin/rails-check` |
| OTT pay-outs | ON, **TEST host** `https://test-payoutapi.ott-mobile.com`, allowlisted | 4 providers (PayShap 127, ABSA CashSend 112, Nedbank Cardless 4, FNB e-wallet 1), float R100,000 (test), `WAPAY_PAYOUT_KYC=off`, `WAPAY_PAYOUT_ALLOWLIST` = the five test numbers; first live pay-out parked and reconcile built | `/api/internal/payout-status`, `/api/internal/payout-reconcile` |
| UniFuel / Yoyo fuel | live link, Yoyo TEST | founder-only pilot (`VAS_ALLOWLIST_FUEL`); production blocked on Yoyo campaign IDs + retainer terms | `/api/admin/unifuel` |
| Blu VAS (airtime, data, electricity) | QA creds | live for customers on QA; production cutover deliberate (journey screenshots to Blu) | |
| Didit KYC | built, envs unset | required again before public cash-out | `docs/KYC.md` |
| Mission Control | live | password sign-in, dashboard, CRM, floats, UniFuel, rails-check | `/admin` |
| WaPay for Business | live, registration closed | invites via `WAPAY_BUSINESS_MSISDNS` | `docs/BUSINESS_PORTAL.md` |
| Email (Resend) | env-gated | wapay.co.za domain verification unconfirmed | `lib/email.js` |

Production build at the time of writing: `4e16daa` before this brief's commit; see
`WAPAY_STATUS.md` for the current one.

---

## 6. Production environment facts (names, never values)

`WAPAY_PAYOUT_ENABLED=true` · `WAPAY_PAYOUT_KYC=off` · `WAPAY_PAYOUT_ALLOWLIST` (set
2026-09-16 to the five registered numbers) · `OTT_PAYOUT_BASE_URL` test host ·
`OTT_PAYOUT_USERNAME/PASSWORD/API_KEY` set (the key in Vercel is NOT the one pasted in
chat) · `OTT_BASE_URL` test host, `OTT_API_*` WAPAYVIT · `OTT_MERCHANT_BASE_URL` test host,
`OTT_MERCHANT_API_*` set, `OTT_VENDOR_CODE=11` · `WAPAY_WICODE_LIVE=true` +
`VAS_ALLOWLIST_FUEL=27787051175` · `UNIFUEL_API_BASE_URL` + `UNIFUEL_PARTNER_SECRET` (and
in the UniFuel project: `WAPAY_PARTNER_SECRET`, `WAPAY_WEBHOOK_URL`) ·
`WAPAY_ADMIN_MSISDNS`, `WAPAY_ADMIN_SESSION_SECRET`, `WAPAY_ADMIN_PASSWORD_HASH` ·
`WAPAY_INTERNAL_API_KEY` · `WAPAY_BUSINESS_MSISDNS` · `WAPAY_STATE_IDLE_MINUTES` (default
30) · `WAPAY_FLOAT_WARN_CENTS*`. **Every env change takes effect on redeploy only.**

Local fast copy `.env` has `OTT_PAYOUT_USERNAME` blank on purpose (the harness fills the
blanks); the internal key there matches production (the probes work from the laptop).

---

## 7. Standing rules (do not relearn these the hard way)

Carried from v1.3: never push a red test; no card surcharging (PayFast T&C 5.3); KYC on
withdrawal only; never call OTT `GetAPIKey` (it rotates the live key); voucher PINs and
wiCodes are bearer secrets (masked in logs, never in history); POPIA: masked documents
only; rotate the leaked Blu QA + Meta secrets and scrub git history before launch (still
outstanding); remittance needs counsel sign-off; nothing customer-facing claims real fuel
or retail redemption until `WAPAY_WICODE_LIVE`; review agents are READ-ONLY; never promise
dates; never mention betting in WhatsApp; no em dashes in customer copy or emails; the
payout partner is never named while withdrawals are off.

Added in this thread:
- **Run `pnpm build` before every push, and never chain tests into a pipe whose exit code
  is a grep's.** Commit `3a40272` shipped a red test and a ReferenceError because
  `node --test … | grep … && pnpm build && git push` masked five failures. Commit of
  2026-09-16 caught a duplicate `let` only in the build; `tests/processor-loads.test.mjs`
  now imports the processor.
- A helper called from inside another function must be given what it needs: the
  intent-switch detector has no `from`, so per-user gates live at the flow entry point,
  not in the detector.
- Cash-out stays behind `WAPAY_PAYOUT_ALLOWLIST` until Didit is back on and counsel has
  cleared it; new sign-ups are excluded automatically, which is the point.
- Coordinate with a live peer session (`ListAgents` / `SendMessage`) before committing;
  inventory the rsync delta and add files selectively.

---

## 8. Founder actions (open on 2026-09-16)

1. Read the reconcile result for WPC15800A7BD6637 (in the session report) and decide
   whether to reverse the test pay-out's journal if OTT never finalises it.
2. Send `EMAIL_TO_KEAMO_9_PAYOUT_COMMERCIALS.txt` (pay-out commercials per provider,
   production float mechanics, sandbox status codes, IP allowlist, production timeline).
3. Send `EMAIL_TO_SIPHO_YOYO.txt` (campaign list, retainer, fees, float top-up,
   production path).
4. Disable Mukuru Cash in the PayFast dashboard (loss-making on every ticket).
5. Decide the deposit fee (4.20% vs 4.50%) and the +R2 on PayShap/CashSend.
6. When ready for real vouchers: apply the OTT live API credentials and set
   `OTT_BASE_URL` / `OTT_MERCHANT_BASE_URL` to the hosts without `test-`; redeploy.
7. Test at tills through wrappedgifts.co.za (`docs/STORE_TEST_PLAYBOOK.md`).
8. Rotate the leaked Blu QA + Meta secrets; scrub git history.
9. Verify wapay.co.za in Resend.
10. Commission the payments-law / NPS counsel opinion before cash-out opens beyond the
    allowlist; turn Didit back on (`DIDIT_*`, remove `WAPAY_PAYOUT_KYC=off`).
11. Confirm the Vercel plan (Hobby vs Pro) so Task 5.1 can pick the scheduler.

---

## 9. Hard-to-reconstruct details

- The parked pay-out: reference **WPC15800A7BD6637**, idemKey
  `payout-cmi7t758h000dnf0ndpexchob-wa-mu32rl83-c4pbsy71`, PayShap (127), R50 + R8, FNB
  account ending 394, requested 2026-09-15 19:52:05 UTC (21:52 SAST); founder account id
  `cmi7t758h000dnf0ndpexchob`, waId 27787051175; SPEND R8.00, CASH pending R58.00.
- Registered accounts (the allowlist): 27787051175 Nieuwoudt, 27726252243 Shaun Jacobs,
  27833092433 Mike Waller, 27827877781 Alan, 353877863507 ross (Irish number; SA rails
  will reject it at the provider).
- Probes (header `x-internal-api-key`): `GET https://pleasepayme.co.za/api/internal/payout-status`,
  `GET …/api/internal/payout-reconcile?reference=WPC15800A7BD6637`,
  `GET …/api/internal/meta-status`, admin-session routes `/api/admin/floats`,
  `/api/admin/rails-check`, `/api/admin/unifuel`.
- OTT hosts: issuing/redemption `test-api.ott-mobile.com` (live: `api.ott-mobile.com`);
  pay-outs `test-payoutapi.ott-mobile.com` (live: `payoutapi.ott-mobile.com`); test payout
  portal `test-payout-portal.ott-mobile.com`. Webhook URL given to OTT:
  `https://pleasepayme.co.za/api/webhooks/ott-payout`.
- OTT status codes: 100 paid, 99 pending finalisation, 98 pending, 0 rejected, 3
  reference not unique (reconcile, never release), 97 failed at provider; anything else
  PENDING + reconcile. The sandbox returned a code outside this table on 2026-09-15
  (see the reconcile result).
- Yoyo `userRef` fails above 45 characters with "General System Error"; our references
  are 38. `getUserGiftCards` returns `data.giftcardList`.
- OTT contacts: Keamo Modikwe (Senior Sales & Account Manager, keamo@ott-mobile.com,
  +27 83 397 2997); Ritesh Rugnundan (Product Lead Payout & Collect). Yoyo: Sipho. Blu:
  Phuti. SHB/Adumo: Tiisetso.
- Harness: `pnpm qa:chat` (live DB + OpenAI, sends captured, funded QA wallet, mocked OTT
  rail; report `docs/testing/chat-qa-report-<date>.md`); `pnpm qa:fuel` (scratch schema).
- The processor is `pages/api/webhooks/message-processor-v2.js` (about 6,100 lines); the
  orchestrator `packages/ai/src/orchestrator.ts`; the knowledge base
  `lib/how-it-works.js`; fees `lib/fee-facts.js`; catalogue `lib/spend-catalogue.js`;
  pay-outs `lib/payouts.js` + `lib/payout-chat.js` + `lib/ott-payout.js`.
