# WaPay — Bug Register

*Every caught bug, with its root cause and the guard that stops it coming back. Format: **symptom → root cause → fix → guard**. Add new entries at the top. A bug without a regression guard is not closed.*

---

## 36. PayFast asked known depositors "How can we get hold of you?"

- **Symptom (founder screenshot, 2026-08-31):** loading your own wallet by card, the PayFast page asks for an email/cellphone before showing payment methods — even though the depositor is a signed-in WaPay customer whose number we obviously have.
- **Root cause:** the deposit checkout never passed `cell_number` to PayFast. (The pay-link flow did pass it, but as a raw value — a 27-format number silently fails PayFast's prefill, which expects local 0-format.)
- **Fix:** the deposit checkout now passes the depositor's number, and `@wapay/providers-payfast` normalizes any cell number to local 0-format (27-format converted; invalid input dropped rather than sent broken). `cell_number` was already part of the signed field set, so signatures stay correct.
- **Guard:** `tests/payfast-contact-prefill.test.mjs` — normalization, drop-on-garbage, and static assertions that both flows pass a cell number.

## 35. Yoyo userRef over ~45 chars fails issuance with "General System Error" (caught pre-ship)

- **Symptom (fuel E2E first run, 2026-08-29):** every wiCode issuance through the new
  WaPay→UniFuel pipeline failed at Yoyo with `General System Error` — while the identical
  call with a shorter reference succeeded. Probed on the test env: userRef ≤ 45 chars
  issues, ≥ 47 fails. The WaPay reference `wapay-fuel-preview-fuel-<uuid>` produced a
  66-char userRef.
- **Root cause:** an undocumented Yoyo userRef length limit; UniFuel's own refs
  (`fuel:guest:<uuid>` ≈ 47) sit close to the same cliff, unnoticed because Yoyo's error is
  generic.
- **Fix:** the WaPay execute route builds a COMPACT deterministic reference —
  `wapay-fuel-` + 27 hex chars of the preview UUID, 38 chars total (userRef 44) — and the
  webhook receiver maps references back via `ProviderRequest.providerRef`, never string
  surgery. UniFuel's partner route enforces max 38 (`REFERENCE_SHAPE`).
- **Guard:** `tests/fuel-flow.test.mjs` pins the `.slice(0, 38)` + prefix-strip; the
  fuel E2E (`pnpm qa:fuel`) exercises the real issuance end-to-end.

## 34a. "Where can I spend my WaPay money!" answered with the bare Help Menu (founder screenshot)

- **Symptom (live customer, 2026-08-29):** the exact question got the static
  `📋 WaPay Help Menu` twice. No deterministic matcher was at fault: the tier-1
  orchestrator's fast path defined HELP as "asking what WaPay can do", so a capability
  QUESTION short-circuited to the HELP action — and the dispatch `case 'HELP'` rendered
  every HELP as the same static menu, discarding conversation entirely. The sibling trap:
  "Where can I spend my voucher?" was eaten by the voucher-HISTORY regex, and "Can I buy
  petrol?" by the product-query indicators (generic VAS dump).
- **Fix (three layers):** (1) prompts — fast-path HELP narrowed to bare menu asks, the
  CHAT agent told a subject question is NEVER HELP, and a data-driven claim-gated
  knowledge block (lib/spend-catalogue.js) now rides every tier-2 call; (2) dispatch —
  `case 'HELP'` answers question-shaped input with the warm spend-destinations reply
  (menu only for explicit asks); (3) adjacent matchers — voucher-history excludes how-to
  phrasings, and a no-match product query with concrete residue falls to the AI instead
  of the product dump (recursion-guarded via `viaAi`).
- **Guard:** `tests/help-conversational.test.mjs` (prompt pins, gate regex drives,
  residue behavior) + four `pnpm qa:chat` scenarios asserting question-shaped input never
  gets a bare menu (the founder phrasing verbatim among them).

## 33. Admin login code never arrived — free-form send outside WhatsApp's 24-hour window

- **Symptom (founder's first login, 2026-08-28):** entered the correct number on
  admin.wapay.co.za, never received the 6-digit code. The console gave no error (by design —
  the request endpoint is deliberately not an allowlist oracle).
- **Diagnosis:** two `adm:`-prefixed rows existed in `otp_codes` for the founder's account, so
  the allowlist matched, the account resolved and the code was generated — only DELIVERY
  failed. The last inbound WhatsApp message was 28.6 hours old, so Meta's 24-hour customer
  service window was CLOSED and a free-form text is undeliverable.
- **Root cause:** `requestAdminOtp` sent the code with `sendWhatsAppText` (free-form). That is
  precisely wrong for a login flow: an admin signs in FROM A COMPUTER, so the window is
  normally closed. The onboarding OTP had it right all along — template first
  (`otp_register_step_2`, APPROVED/AUTHENTICATION, delivers outside the window), text as
  fallback.
- **Fix:** admin OTP now sends the approved AUTHENTICATION template first (name overridable
  via `WAPAY_TEMPLATE_ADMIN_OTP`), falling back to free-form only if the template fails. If
  BOTH fail the code row is DELETED, so the admin retries immediately instead of being
  throttled behind a code that never arrived; logged as `admin_otp_undeliverable`. The two
  stranded rows were cleared from prod.
- **Guard:** `tests/admin-console.test.mjs` — template-attempted-first, free-form-not-used-on-
  success, fallback-on-template-failure, undeliverable-row-deleted-and-retry-not-throttled,
  plus a static check that the route wires the template sender.
- **SECOND ROUND — the template path was a dead end.** With an internal-key delivery
  diagnosis added to the request endpoint, production said: `(#132001) Template name does not
  exist in the translation` for BOTH `otp_register` and `otp_register_step_2`, while the
  free-form fallback returned `ok:true` with a message id and still never arrived (Meta
  accepts an out-of-window free-form send, then silently drops it — `ok` means *accepted*,
  not *delivered*). Root cause of the template failure: **templates are approved per WABA**,
  and our catalogue mixes two business accounts (`otp_register_step_2` is approved on
  647978251504290; we send from 801970852418258) — and neither resolved in the requested
  language on the sending account.
- **DURABLE FIX — invert the flow.** Pushing a login code to a closed window is inherently
  fragile, so the admin now REQUESTS it from their phone: messaging **"admin login"** to the
  WaPay number issues the code and replies in-session, where free-form delivery is guaranteed
  and no template is involved. `requestAdminOtpInSession` reuses the same allowlist, throttle,
  daily cap and hashed storage; non-admins get no acknowledgement that the command exists.
  The console's push button still works whenever the window happens to be open, and the login
  screen now tells the user the phone path. Guards: matcher precision against a customer-
  sentence corpus, allowlist gating, throttle parity, hashed-at-rest.
- **Wider lesson:** onboarding has the same latent template failure — it has simply never
  surfaced because onboarding always runs inside an open window, so its free-form fallback
  always carries it. Worth fixing when the WABA/template catalogue is next reconciled.
- **Lesson (applies to every future outbound):** anything the customer/admin has not just
  messaged us about needs a TEMPLATE, not free-form text. Free-form is only safe as a reply
  inside an open session.

## 34. admin.wapay.co.za sits behind Vercel's bot challenge; login button failed silently

- **Symptom (2026-08-28):** with the login code still not arriving, verification of the admin
  host produced a second, independent problem — every automated request to
  `admin.wapay.co.za` returned **403 with `x-vercel-mitigated: challenge`**, while
  `pleasepayme.co.za` returned 200 for the identical path at the same second. Vercel's bot
  protection is enabled on the admin domain and not on the app domain.
- **Impact:** low for humans, high for tooling. A real browser solves the challenge and then
  the APIs answer normally (verified: `/api/admin/auth` returns 200 and a live POST returns
  `{"ok":true}` once the challenge cookie is held). But the FIRST request of a session — the
  page's own auth probe — can be 403'd, and any curl/monitor/uptime check against that host
  fails permanently. It also made every remote verification of the deploy misleading.
- **Second defect found while proving it:** the login button's handler had no error handling —
  `await post(...)` then `setStage('code')`, with nothing catching a rejection and no check of
  the response. A blocked or failed request therefore left the screen visibly unchanged with
  no message, which is indistinguishable from "the app is broken". Now: the number is
  validated before sending, a non-ok response says so, and a network rejection says so.
- **Fix/actions:** UI error handling shipped. The Vercel challenge is a dashboard setting, not
  code: Project → Firewall / Attack Challenge Mode, either disable it for this project or
  exempt `admin.wapay.co.za`. Until then the console still works in a normal browser (solve
  the challenge once), and clearing `WAPAY_ADMIN_HOST` re-opens `/admin` on the app domain as
  an immediate fallback.
- **Verification lesson:** `curl` against a challenged host proves nothing. Confirm a deploy
  by inspecting the served JS bundle from a real browser (that is how the login copy was
  finally verified) or by an authenticated version endpoint.

## 32. Admin console + Didit KYC — 27-agent adversarial review (caught pre-ship 2026-08-28)

The whole admin/KYC surface was reviewed by a 27-finding adversarial workflow BEFORE it saw
prod traffic. The load-bearing catches, all fixed in the same push:

- **CRITICAL — admin allowlist matched last-9-digits only.** `isAdminMsisdn`/`adminAccount`
  reduced numbers to a 9-digit tail, so a foreign/VoIP WhatsApp number sharing an admin's
  last 9 digits could receive the admin OTP and mint a session. **Fix:** normalise to the
  full SA 27-form (`normSa`), resolve the account by exact full-number match, and fail closed
  when 0 or >1 accounts match. Guard: a UK-number-collision test.
- **HIGH — admin OTP shared the `otp_codes` table with customer money-flow OTPs.** Admin
  verify consumed the newest live row of EITHER flow, burning a customer's onboarding code.
  **Fix:** admin codes are namespaced `adm:`+hash and every admin query filters on the
  prefix; the customer flow already matched exact plaintext so it never touched admin rows.
  Plus a daily issuance cap + burn-based lockout against slow brute-force / lockout DoS.
- **HIGH — profile JSON lost-update race.** Every profile writer did read-modify-write on the
  whole column; a KYC merge and a language write on the next message clobbered each other.
  **Fix:** `lib/profile-merge.js` merges in Postgres with jsonb `||` / `jsonb_set`; the KYC
  webhook, `updateProfile`, and the acquisition backfill all use it now.
- **HIGH — KYC webhook could permanently lose the customer notification** (gated on a
  one-shot `changed`) and could regress VERIFIED via a stale decision. **Fix:** notify gated
  only on `notifiedStatus`, 5xx-on-send-fail so Didit retries; a VERIFIED account is never
  downgraded by a different/older session; the decision's `vendor_data` must match the
  account or the write is refused.
- **MEDIUM batch:** metrics truncated at 5000 rows (silent GMV understatement) → aggregated
  in SQL, reversal-correct, counted by account id not wallet code; internal-key compare made
  constant-time; declineReason free text redacted (POPIA); `getOrCreateUser` fabricated-
  account fallback (split-brain) replaced with an upsert + rethrow; dashboard stale-response
  guard; customer balances render all wallets.

**Guard:** `tests/admin-console.test.mjs` + `tests/didit-kyc.test.mjs` (24 base + 8 regression
tests pin every fix above). This is the review-before-ship discipline working as intended —
none of these reached prod.

## 31. Every "what ..." question answered with the products menu

- **Symptom (chat QA harness, first run 2026-08-27):** "What did I tell you my name was?" and "What is my favourite colour?" both got the 🛒 VAS products menu. The third product-query indicator was `/\b(show|list|what|which)\s+(me\s+)?(your\s+)?(the\s+)?/i` — every group after the first word optional, so ANY sentence containing "what " (or which/show/list) read as a product ask at 0.8 confidence and never reached the AI.
- **Root cause:** an intent indicator with no required object — it encoded "starts like a browse ask" instead of "asks about something buyable".
- **Fix:** the indicator now requires a commerce noun within 40 chars: `(airtime|data|bundles?|electricity|vouchers?|products?|deals?|prices?|buy|sell|top up)`. "what can I buy" and "show me Vodacom bundles" still route to products; personal and general questions fall through to the AI (which, with #30 fixed, actually remembers).
- **Guard:** `tests/chat-qa-findings.test.mjs` extracts the REAL indicator array and drives 5 personal questions (must not match) and 7 commerce asks (must match); a second test pins that the bare pattern never returns. The conversational proof lives in `pnpm qa:chat` (memory scenarios).

## 30. Conversation history amnesia on every flow transition

- **Symptom (spotted in code review while building the chat QA harness, confirmed live by its first run 2026-08-27):** tell the bot "my favourite colour is green", start ANY flow ("buy electricity"), cancel it, ask "what is my favourite colour?" — the AI had no idea. `mergeConversationData` rebuilds `conversationData` from `{}` whenever the conversation state changes and re-attached only `processedMessageIds` and `sentErrorKeys` — `history` (the AI's 10-message context window) silently died on every flow entry, exit, and step.
- **Root cause:** history is cross-cutting like the idempotency keys, but the merge treated it as a state slot.
- **Fix:** `lib/conversation-data.js` now carries `history` across state transitions (an explicit `nextData.history` still wins; junk non-array values are dropped, not resurrected).
- **Guard:** `tests/conversation-data.test.mjs` pins history through flow entry, flow exit, explicit override, and junk input; `pnpm qa:chat` scenario "a flow in between does not amnesia the AI" proves it against the live brain and DB.

## 29. "Payment link" ask was invisible to intent detection — meter state ate it

- **Symptom (founder live test 2026-08-27):** mid-electricity-flow (waiting for a meter number), the founder typed "Please create a payment link for R20" and got "❌ That doesn't look like a valid meter number." The universal intent-switch escape (BUGLOG-era fix, founder feedback 2026-08-25) WAS wired globally, but it saw no intent: `matchRequestMoneyAsk` knew "pay me / get paid / payment request / request money" and not the **payment LINK** phrasing customers actually use. With no strong intent detected, the meter state's validator answered — and ELECTRICITY_METER (unlike the request/deposit/voucher states) had no conversational-sentence backstop either. Founder had flagged flow-trapping before; this was the residual phrasing gap.
- **Root cause:** two independent layers each had a hole and the holes lined up: (1) the deterministic intent matcher lacked the most natural phrasing for its own feature; (2) eight slot-collector states (electricity amount/meter, airtime amount/msisdn, data msisdn/network/period, voucher-gift amount) answered unparseable SENTENCES with validation errors instead of escaping to the router.
- **Fix:** `matchRequestMoneyAsk` now matches link asks (create-verb + "pay(ment) link", or "pay(ment) link" + amount) while complaints/questions about a link ("the payment link doesn't work") still fall to the router; all eight collector states got the `isConversationalEscape` → clear state → `handlePostOnboarding` backstop (the REQUEST_MONEY_AMOUNT idiom); and the universal escape now ACKNOWLEDGES the switch ("👍 No problem, switching over. We can come back to the electricity purchase any time.") before the new intent's reply, so the parked flow is parked out loud.
- **Guard:** `tests/intent-switch-payment-link.test.mjs` extracts the REAL matcher + switch detector (no stubs): the founder's exact message must return `REQUEST_MONEY` from `ELECTRICITY_METER`, meter numbers and in-family answers must never escape, all eight states must carry the backstop, and the ack copy is pinned em-dash-free.

## 28. OTT Payout client: amount hash/wire mismatch + two double-spend paths (caught pre-launch)

- **Symptom (adversarial review 2026-08-26, before any live credential existed):** three defects in the new payout client. (a) **BLOCKER** — the hash was computed over the 2dp string `"50.00"` but the body sent `Number("50.00")` → `50`, so OTT would recompute its hash over `"50"` and **every round-rand withdrawal** would fail with status 2 Invalid Hash. My own test asserted `amount === 50`, i.e. it *locked the bug in* and made a green suite meaningless. (b) a transport failure/timeout **threw**, giving the caller no settlement class — if a caller treated "threw" as failure and released the hold, the customer could respend money OTT had already paid. (c) status `3` (duplicate reference) mapped to RELEASE, but with our deterministic epoch-free reference a duplicate means an **earlier attempt already reached OTT and may have succeeded** — releasing double-spends.
- **Root cause:** (a) serialising the amount twice, once for the hash and once for the wire, in different types; (b)/(c) treating "no/negative answer" as "nothing happened" — the classic indeterminate-payment fallacy.
- **Fix:** the wire amount is now the exact hashed 2dp string; transport failures RETURN `{outcome:'TRANSPORT_INDETERMINATE', settlement:'PENDING', reconcileRequired:true}` instead of throwing; status `3` is PENDING+reconcile. The caller contract ("never release on PENDING; after reconcileRequired call getPaymentStatus, never re-issue performPayout") is documented in the module header and `docs/OTT_PAYOUT_API.md`.
- **Guard:** `tests/ott-payout.test.mjs` asserts the wire amount equals the hashed amount as a STRING across 5 amount shapes incl. round rands, drives a real transport error to prove the PENDING outcome, and pins `3` → reconcile. The two OTT golden vectors remain pinned so the crypto can't drift.

## 27. Directed-request relationship gate was self-populatable (phishing surface)

- **Symptom (re-review 2026-08-25, pre-deploy):** the rebuilt directed-request gate ("please pay me R50 from <name/number>") required the target to be the requester's saved beneficiary — but a beneficiary is created UNCONDITIONALLY by sharing a WhatsApp contact card (`rememberBeneficiary`, no money, no target consent). So an attacker could save any victim's number via a contact-card share, then push an unsolicited (label-spoofable) "pay request" nudge into that stranger's WaPay chat and read the requester-side response as a membership-enumeration oracle. The CORE harm (cross-user state plant / auto-pay) was already closed; this was the residual delivery+oracle surface.
- **Fix:** the gate is now a real PRIOR MONEY MOVEMENT — `hasPriorSendTo` (a `PendingGift` from the requester to that recipient exists), applied on BOTH the number and name branches. A prior send is money-backed and cannot be forged for free, and the recipient already received value from the sender (benign). Plus: `safeRequesterLabel` gained a system/authority denylist (wapay/support/admin/…→ neutral label), and the informational nudge is no longer written into the payer's conversation history (kept out of their AI-context window).
- **Guard:** `tests/founder-feedback-0825.test.mjs` requires ≥2 `hasPriorSendTo` gates in the resolver, asserts `isSavedBeneficiary` is gone from it, and locks the denylist + no-history + no-state + no-money properties of delivery.

## 26. Paid-request notifications were one-shot — a lost invocation lost them forever

- **Symptom (founder live test `PRMDCUQA`, R20 card payment, 2026-08-25):** the payment was captured perfectly — payer number stored, request marked PAID, requester credited — but NEITHER the requester's "you've been paid" nor the payer's receipt ever arrived on WhatsApp.
- **Root cause:** both sends were gated on `wonRequestTransition` — winning the atomic PENDING→PAID check-and-set, which by design succeeds exactly once. The ITN route had no `maxDuration` (Vercel default cap) while doing a PayFast server-verify POST-back, ledger posting, and two WhatsApp sends; when the invocation died mid-sends, PayFast's redelivery could not win the transition again, so the notification branch never re-ran. Exactly-once *notification* was implemented as exactly-once *attempt*.
- **Fix:** notifications moved to `lib/request-notify.js` — durable and idempotent: `requesterNotifiedAt`/`payerNotifiedAt` flags in the intent metadata, set ONLY after a send resolves ok; the ITN now runs the helper on EVERY delivery (replayed or not), so redeliveries repair lost sends; `POST /api/admin/notify-request` (internal-key-guarded) repairs manually; `vercel.json` gives the ITN 30s and the WhatsApp webhook 60s.
- **Guard:** behavioral tests drive the helper through send-fails-then-template-rescues and redelivery-never-double-sends paths; statics pin every-delivery invocation (never transition-gated), flags-only-on-ok, and metadata MERGE on flag persist.

## 25. Parallel-session rsync swept another thread's PRE-review code into a push

- **Symptom:** commit `619a285` (amount-change swap) also shipped the in-flight payer-registration feature BEFORE its adversarial-review fixes — prod briefly ran a GET form (payer msisdn into query-string request logs), a hijackable last-click-wins receipt destination, a dead-code template fallback, and a fail-open health config block.
- **Root cause:** two sessions share one git-less fast copy; rsync is tree-wide, so "commit my work" swept every mid-flight file the other session had touched — the commit message described none of it.
- **Fix:** the review-fixed versions pushed the same evening (this commit); window ≈ one deploy cycle.
- **Guard:** process rule — before rsync+commit, run `rsync -rcn --itemize-changes` and inventory every differing path against the tracker; a file you didn't author in THIS session either ships with its author's sign-off visible in the tracker or stays out of the commit (`git add` is selective even when rsync isn't).

## 24. Payer-registration review batch (41-agent adversarial review, 2026-08-22)

- **Symptom (batch, all fixed pre-launch bar the #25 window):** (a) `@wapay/whatsapp` send functions RESOLVE `{ok:false}` — never throw — so a catch-based template fallback was dead code and out-of-window payers silently got no receipt, with zero log evidence; (b) the receipt destination was last-click-wins metadata — anyone holding the link could redirect a paying payer's receipt + PayFast reference to their own number during the whole card-entry + ITN-latency window; (c) the payer's msisdn rode a GET query string into platform request logs; (d) `RECEIPT_CODE_PATTERN` un-anchored under `/i` matched ordinary sentences ("receipt problems" → PROBLEMS, "is my receipt prepared" → PREPARED); (e) `/api/health?config=1` was world-readable until the key existed and leaked two env VALUES its own doc called presence-only; (f) a payer whose card payment landed after the requester cancelled was told "no payment was taken on it".
- **Root cause:** single-session blind spots — assumed exceptions on send failure, trusted mutable shared metadata for a money-adjacent artifact, defaulted fail-open by analogy with internal-auth, pattern-matched user text too loosely.
- **Fix:** branch on the resolved `.ok` with an env-gated template fallback; receipt destination bound to signed `custom_str1` (the ITN persists the true payer back into metadata for the in-chat ref gate); number travels in the POST body only; patterns anchored + restricted to the code alphabet (PAY_REQUEST tightened too); health fails closed with presence-booleans only; intent-status consulted before ever denying a payment.
- **Guard:** `tests/payer-registration.test.mjs` (26 tests) pins every fix: `.ok` branches, `custom_str1` wiring, POST-only payer, the false-positive corpus, fail-closed health, metadata MERGE spreads (mutation-tested), gross-cents receipts, upsell-free push receipts, and the betting/cash-out word ban.

## 17. Every VAS settle idemKey was timestamp-poisoned — vend delivered, customer never charged

- **Symptom:** (latent, would hit every airtime/data/electricity purchase on the new ledger) the provider vends, then `settleHold(buildSpend(...))` throws — the customer keeps the product AND the money.
- **Root cause:** preview ids embedded raw `Date.now()` (`preview-air-1787…`); the derived settle idemKey then trips ledger-core's own timestamp-lookalike guard. Blu voucher redemption had the same class of bug: the SHA-256 PIN-hash prefix looks like an epoch for ~1 in 481 vouchers — after Blu consumed the voucher, stranding the cash.
- **Fix:** preview stamps are base36 (`Date.now().toString(36)`), the redemption idemKey interleaves `x` every 8 hex chars — both provably immune to the guard.
- **Guard:** the guard itself still rejects any regression; found by the 45-agent QA audit 2026-08-21.

## 18. Payment-request card leg was not exactly-once

- **Symptom:** double card charges and double credits were possible (fresh intent + fresh idemKey per checkout click; ITN credited without consulting the request; a crash between credit and mark-paid stranded the request PENDING-and-repayable forever).
- **Root cause:** the two rails used different idemKeys, and mark-paid was gated on `!posted.replayed` and swallowed errors.
- **Fix:** ONE idemKey per request code shared by BOTH rails (`wapay-payreq-<code>`) with one reusable intent — postEntry can only ever credit once across all rails and clicks; mark-paid runs on every delivery (atomic PENDING→PAID); confirmations gate on winning the transition; a replayed entry with a different PayFast ref logs `payfast_overpayment_detected` (CRITICAL_REFUND_NEEDED).
- **Guard:** `tests/payment-requests.test.mjs` locks the unified key, the intent reuse, the absence of the replay gate, and the overpayment scream.

## 19. PAYREQ_PIN burned wallet-PIN attempts on chatty replies

- **Symptom:** five conversational replies at the PIN prompt soft-locked the wallet PIN; ten hard-locked it.
- **Root cause:** every non-cancel message was fed to `verifyPIN`.
- **Fix:** only `\d{4,6}` reaches verifyPIN; sentences escape to the router; anything else re-prompts without burning attempts.
- **Guard:** QA audit finding; PIN-shape gate now mirrors VOUCHER_GIFT_PIN.

## 20. Fee-free self voucher was quoted free but booked the R3 fee

- **Symptom:** self OTT-voucher purchases were silently overcharged R3 (or failed at settle on an exact balance) — the preview quoted 0, `buildVoucherGift` hardcoded the flat fee.
- **Fix:** `buildVoucherGift` takes `flatFeeCentsOverride`; execute passes the preview's quoted fee — the preview is the quote of record.

## 21. Broke-checkout resume was unreachable

- **Symptom:** the pay-the-difference + auto-resume flow never triggered — the processor matched `INSUFFICIENT_FUNDS` but execute returned `USER_INPUT`, and the preview blocked short balances with a generic error first.
- **Fix:** preview and execute both return a distinct `INSUFFICIENT_FUNDS`; the preview path now ALSO enters the checkout flow (shortfall + PayFast link + `RESUME_VOUCHER_PURCHASE`).

## 22. Claiming marked gifts DELIVERED before the send

- **Symptom:** one failed WhatsApp send permanently stranded the recipient's bearer voucher PIN (row DELIVERED, PIN never received).
- **Fix:** `revertGiftDelivery` flips DELIVERED→ISSUED when the send definitively fails (`ok:false`) so the next inbound message retries; applied to the claim flow AND self-purchase delivery.

## 23. Routing/state batch (QA audit 2026-08-21)

One sweep, all fixed: phone-number replies re-parsed as rand amounts in AIRTIME_MSISDN (R7.8m airtime "amounts"); "me" cancelling despite the prompt offering it; "Yebo/Ewe/Ja/Ee" cancelling every confirm state (7 regexes extended); deposit-status questions with amounts minting fresh payment links (status now checked first); a dashed 16-digit voucher PIN minting a R1,234 card checkout; "pay request <word>" matching ordinary words (codes now strictly `PR[A-Z]{6}`); "send an OTT voucher to <name>" hijacked into self-purchase; contact cards shared mid-flow hijacking into send-money; 9+ digit context follow-ups read as rands; "cancel … request" creating a NEW request (cancel now wired: "cancel request PRXXXXXX"); BUY_DATA discarding the agent's English productQuery.

**Known-open (logged, deliberate):** profile write races (last-write-wins acceptable at current volume); language-evidence echo on neutral turns; voucher-history intercept answers recipients with sender-only history; a crash between settleHold and createPendingGift (idempotent retry design exists, no caller retries yet); redemption replay tells the losing account in a same-PIN race "Redeemed Successfully".

## 15. Voucher-execute crash stranded R36 in ACTIVE holds

- **Symptom:** failed voucher sends ("An error occurred while executing purchase") left the reserved money missing from the balance — two ACTIVE holds (R23 + R13) found in prod, wallet R36 lighter than the journal (founder-reported balance confusion, 2026-08-20).
- **Root cause:** an exception between `reserveHold` and the taxonomy failure paths (which do call `releaseHold`) fell through to the outer catch, which returned 500 without releasing the hold.
- **Fix:** `holdIdemKey` is hoisted; the outer catch best-effort releases it (`execute_crashed:` reason). `releaseHold` is status-guarded, so the safety release is a no-op after settle/normal release. Stuck prod holds released with the library function; wallet reconciled.
- **Guard:** `tests/voucher-execute-crash-release.test.mjs`-style static assertion lives in `tests/ott-voucher-self.test.mjs` (crash-release path present); `reconcileWallets()` detects any stored-vs-derived drift.

## 16. Manual credit applied twice — R20 of unbacked balance

- **Symptom:** stored wallet balance exceeded the journal-derived truth by exactly R20 ("real money vs fake money", founder, 2026-08-20).
- **Root cause:** the 2026-08-18 manual R20 credit (PayFast IP-reject recovery) hit the wallet twice: once as a direct wallet update and once properly via `postEntry` (which also increments the wallet). The journal was correct; the stored cache wasn't.
- **Fix:** wallet reconciled to journal truth (R50.00) after releasing the stuck holds; logged as `wallet_reconcile_fix`.
- **Guard:** manual credits are banned as direct wallet updates — `postEntry` only (it is replay-safe by idemKey). `reconcileWallets()` catches drift; run it after any manual intervention.

## 1. Zero-cent commission line crash

- **Symptom:** small vends crashed at posting time; the journal entry was rejected.
- **Root cause:** the fee model rounded commission to 0 cents on small amounts, and the spend builder still emitted the commission posting — a zero-amount line, which the balanced-entry validation (and DB constraints) rightly refuse.
- **Fix:** builders in `lib/ledger-core.js` omit zero-amount postings entirely; the entry stays balanced without them.
- **Guard:** `tests/ledger-core.test.mjs` covers minimum-amount vends; `validateBalanced` rejects zero/invalid lines on every posting, so a regression fails loudly, not silently.

## 2. Electricity execute wrote nonexistent Prisma fields

- **Symptom:** electricity purchases failed at runtime with Prisma validation errors.
- **Root cause:** `pages/api/vas/electricity/execute.js` was written against fields that don't exist in `schema.prisma` — untested code shipped on the old non-atomic pattern.
- **Fix:** rebuilt on the reference hold pattern (ensureWallet → reserveHold → Blu → settleHold/releaseHold), response shape preserved; the phantom fields are gone.
- **Guard:** `tests/vas-electricity-flow.test.mjs` + `tests/vas-execute-ledger-pattern.test.mjs` (statically asserts every execute route follows the hold pattern).

## 3. Balance endpoint: wrong relation + 200-on-error

- **Symptom:** users could be shown R0.00 when the DB was down, and the endpoint queried a Yoyo wallet relation nobody used.
- **Root cause:** `pages/api/wallet/balance.js` swallowed DB errors into a 200-with-zero response — indistinguishable from a genuinely empty wallet — and carried a dead `yoyo` include.
- **Fix:** queries the SPEND wallet; DB failure returns **503 `BALANCE_UNAVAILABLE`**, never a fabricated zero; dead include removed.
- **Guard:** the "never 200-with-zero" rule is asserted in tests; principle recorded here: an error must never look like a balance.

## 4. `Date.now()` idempotency keys (double-vend risk)

- **Symptom:** none observed — caught in review. A provider timeout + retry would have vended twice and debited twice.
- **Root cause:** execute routes built idemKeys from `Date.now()`, so every retry was a "new" operation; idempotency existed in name only.
- **Fix:** idemKeys are deterministic from stable inputs (WhatsApp message id, voucher PIN hash) so a retry replays the same entry; `postEntry` returns the original result.
- **Guard:** DB-unique constraint on idemKey; live-DB verification replays every flow (`scripts/verify-ledger-db.mjs`, 21/21); pattern test bans timestamp-derived keys.

## 5. Webhook accepted unsigned POSTs, no dedupe

- **Symptom:** none observed — caught in review. Anyone who learned the webhook URL could POST a forged message and drive a real money flow; Meta's retries could double-process real ones.
- **Root cause:** signature verification was never implemented; a fallback verify-token had leaked into the repo; no processed-message tracking.
- **Fix:** HMAC (`X-Hub-Signature-256`) verified over the exact raw bytes before anything else — 401 on failure; leaked token removed; `claimMessage` per-message dedupe (availability-over-dedupe on DB error).
- **Guard:** `tests/webhook-security.test.mjs` + `tests/webhook-wiring.test.mjs` (statically enforces verify-before-ACK in the route source).

## 6. Catalog sync: dead endpoint (20 vs 821+ products)

- **Symptom:** the bot only knew ~20 products; most searches found nothing.
- **Root cause:** the sync job called a dead/legacy Blu catalog endpoint that returned a tiny subset, and nothing flagged the shortfall.
- **Fix:** corrected endpoint (`f9b52eb`); catalog now 831 products.
- **Guard:** sync logs product counts as structured JSON; an implausibly small sync is visible in logs. (No automated floor-count alert yet — worth adding.)

## 7. Mute bot: ACK-before-processing on serverless

- **Symptom:** bot went completely silent after the `44b51c9` deploy — webhook returned 200, no replies ever sent.
- **Root cause:** the handler ACKed 200 to Meta, then processed the message in a fire-and-forget async block. Vercel serverless freezes/kills execution after the response, so processing never ran. (The stable January deploy had awaited processing; the regression came in with the refactor.)
- **Fix:** `6096585` — verify → process (awaited) → ACK, which also matches Meta's timeout budget.
- **Guard:** `tests/webhook-wiring.test.mjs` enforces the ordering and bans void-async blocks in the webhook. If the project later needs post-ACK work, use the platform's `waitUntil`, never a bare async block.

## 8. OTT `GetAPIKey` rotates the live key

- **Symptom:** near-miss — discovered in the API docs before it burned us. Calling `GetAPIKey` doesn't *read* the key, it **rotates** it, instantly invalidating the credential every deployed environment is using.
- **Root cause:** an API whose "get" is a destructive write.
- **Fix:** the method is deliberately fenced off in `@wapay/providers-ott`; nothing in the codebase calls it.
- **Guard:** standing rule (tracker + package docs): never call GetAPIKey — in tests, OTT is only ever exercised through undici MockAgent, never the live API.

## 9. iCloud `node_modules` + trailing-space path

- **Symptom:** glacial installs, phantom file changes, and scripts breaking with "no such file or directory" on a path that clearly exists.
- **Root cause:** the working tree lived in iCloud Drive (which syncs/evicts `node_modules` and fights file watchers) inside a directory named `WaPay ` — with a **trailing space** — which silently breaks any unquoted shell path.
- **Fix:** canonical dev copy at `~/Projects/wapay` (fast local disk, no sync); the iCloud folder is documents/strategy only. All scripts quote paths.
- **Guard:** convention recorded here and in the tracker: build and test only in `~/Projects/wapay`; always quote the iCloud path exactly, trailing space included.
