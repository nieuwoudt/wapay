# WaPay — Changelog

*One dated section per meaningful commit, newest first. This local working copy has no `.git`, so history is reconstructed from `WAPAY_BUILD_TRACKER.md` and the known deploy commits; dates marked ~ are approximate (the commit hash is exact, the day is the tracker's). Keep this file updated per commit going forward — that is the version-control discipline the repo is held to.*

---

## 2026-08-27 (7) — Pay-page quiet hero + adjacent pay options + rich link previews

Founder screenshot feedback, round two:

- **Hero calmed down**: "Please Pay Me™ with WaPay" is now one small normal-weight line
  (15px/500, was 28px/800) — the amount is the loudest thing on the page again.
- **Both payment options sit adjacent**: balance button (renamed "Pay from my WaPay account
  (free)") directly above the card button; the required WhatsApp-number field moved below the
  card button inside the form — the browser walks the payer to it on submit, so capture is
  unchanged.
- **Forwardable message reads "🙏 Pay Niev now · R100 on WaPay"** instead of leading with the
  raw URL. The URL itself must stay (WhatsApp strips CTA buttons from forwarded messages and
  has no text-anchored hyperlinks — a forwarded message's only tappable path IS the URL), but
  the page now ships **OG meta tags**, so a shared link renders a rich preview card
  ("Please pay Niev · R100") that acts as the visual button above the URL.
- Localization marker for the forwardable surface updated in tests/localize-coverage.test.mjs
  (coordination note from the parallel session applied as instructed).

366/366, build green. Commit via the session holding iCloud access (TCC still blocks this one).

## 2026-08-27 (6) — Em dashes out of chat copy (founder style rule, chat sweep)

Completes the sweep the pay-page batch started: all ~55 em dashes in customer-facing chat
copy rewritten (menu rows `*Label* — desc` → `*Label*: desc`; independent clauses split into
sentences; short qualifiers become commas/parentheses; the voucher-history row separator is
now `·`). Two deliberate survivors, whitelisted by content: the `'—'` null-serial placeholder
in the voucher list and the internal orchestrator context label (never user-facing). Code
comments untouched by design. Recipient gift notification in `lib/gifting.js` reworded too.

Guard: `tests/founder-feedback-0825.test.mjs` now fails on ANY non-whitelisted em dash in a
non-comment processor line, so new copy can't reintroduce them. Two pinned copy tests synced
in the same commit (deposit prompt, home voucher line). 366/366, build green.

## 2026-08-27 (5) — Full deterministic-surface localization (build-queue #3)

The 2026-08-25 batch localized home/help/get-paid/airtime; this completes the sweep. Every
deterministic prompt, confirmation, receipt, product list and flow error now renders in the
user's profile language via `localizeOutbound` (money/codes frozen, fail-open English) —
~184 call sites across the state machine, orchestrator dispatch, smart product query, all ten
category list functions, deposit status, voucher history, contact-share, pay-request flows.
Variable-built messages localize at assignment so conversation history stores what was
actually sent.

Deliberately NOT localized: bearer voucher claim messages (`buildVoucherClaimMessage` output
is delivered verbatim — a translation model never sits between a bearer PIN artifact and the
customer) and messages to OTHER parties (recipients/requesters — their language is their own
profile's business, not the sender's).

Mechanics: applied AST-driven (acorn) over a whitelist of account-scoped handlers —
literal-only wraps, variables by hand — so every English source literal survives
byte-identical and all pre-existing static copy tests pass untouched. New
`tests/localize-coverage.test.mjs` locks: a ≥150-call-site floor, one representative surface
per flow family, the bearer-verbatim rule, and userLang pairing. 365/365, build green.

## 2026-08-27 (4) — Confirm-before-create + Please Pay Me™

- **One link, ever** (founder): a fee-bearing "please pay me R380" now explains the two
  outcomes FIRST and asks the requester to pick — 1️⃣ link for R380 (nets R371.40 by card)
  or 2️⃣ link for R390 (nets at least R380 however they pay) — and only then mints exactly
  one link. The old flow created immediately and offered "make it R390", which cancelled +
  recreated (two links, two codes). Free-band requests (< R50, no fee) still create in one
  step: there is nothing to choose. New `REQUEST_MONEY_CONFIRM` state (cancel/escape-safe,
  amount echoes accepted as picks); post-create copy simplified and em-dash-free.
- **Please Pay Me™** on the pay-page hero (founder: registration in progress; ™ per the
  pending-application convention, flips to ® at grant — one character).
- Static guards: the confirm gate provably precedes createPaymentRequest; the swap offer is
  gone from post-create copy; ™-not-® and the no-em-dash rule are pinned.

365/365, build green. ⚠️ Ships via the NEXT thread's commit — iCloud still TCC-blocked here.

## 2026-08-27 (3) — Pay-page polish + PayFast contact prefill (founder screenshots)

- **"Please Pay Me"** title-cased everywhere on the pay page. Deliberately NO (R) symbol:
  claiming a registered mark we do not own is false marking, and "Please Pay Me" is Capitec's
  live product name with our CIPC search still on the counsel brief. Revisit after counsel.
- **Em dashes stripped from all client-facing pay-page copy** (founder style rule for client
  interfaces); code comments untouched. Chat-message copy sweep handed to the next thread.
- **PayFast never asks for the number twice**: the pay page's captured number now rides the
  signed checkout as `cell_number`, pre-filling PayFast's "how can we get hold of you" step.
  New `cellNumber` param in @wapay/providers-payfast (canonical field order, omitted when
  absent, dist rebuilt). PayFast's own email/cell field cannot be REMOVED (their page, their
  KYC rule) but arrives pre-filled so the payer just taps Continue.
- Sender-pays re-raised (domestic-worker use case) and re-confirmed NOT available as a card
  differential (PayFast T&C 5.3 / SARB / PASA). The compliant equivalent already shipped:
  compose-time gross-up ("make it R390") = one displayed price every payer pays. Making that
  flow more prominent = next-thread item.

359/359, build green. ⚠️ Committed by the NEXT thread — iCloud repo unreachable (TCC) when
this shipped; all changes complete + tested in the fast copy.

## 2026-08-27 — Payment-request creation caps (abuse guard on the free-band subsidy)

The build-queue hardening item, made more urgent by free-under-R50: request creation now has two
env-tunable caps, enforced in `createPaymentRequest` (the single creation path):

- **Open-links cap** — max **10** live PENDING links per requester (`WAPAY_PAYREQ_MAX_OPEN`,
  0 disables). Counts only *unexpired* PENDING rows: expiry is lazy (a stale link keeps status
  PENDING until someone reads it), so counting raw PENDING would have permanently locked out any
  account with 10 expired unpaid links.
- **Daily cap** — max **20** creations per rolling 24h, any status (`WAPAY_PAYREQ_MAX_PER_DAY`,
  0 disables). Cancelled requests still count a creation, so cancel-and-recreate is not a bypass;
  the amount-change swap (one cancel + one create) stays far inside it.

Both are abuse guards, not money invariants — enforcement is approximate by design (two
concurrent creates can briefly exceed a cap by one; `postEntry` idempotency still guards every
rand). Cap errors are typed (`code REQUEST_LIMIT`, `limit OPEN|DAILY`) and the processor answers
them honestly instead of the generic "try again in a moment" (retrying a cap is futile and reads
as broken): the open-cap reply names the newest pending code with a concrete
*"cancel request PRXXXXXX"* to free a slot, mentions the 7-day self-expiry, and is localized.
Logged as `payrequest_create_capped`.

Tests: 3 new (359 total) — cap fires + typed error + per-account isolation + the
expired-PENDING-never-counts lockout guard; daily cap counts every status and frees after 24h;
static processor wiring (distinct branch, distinct log, localized, concrete cancel hint).

---

## 2026-08-27 — Small requests are FREE + compose-time quoting (fee incidence resolved)

The founder asked whether the pay-link fee should move to the PAYER ("if I ask for R20 I should
get R20"). Researched: **it cannot** — charging the payer more for card is a surcharge, prohibited
by **PayFast's own merchant T&Cs cl. 5.3** ("same price regardless of whether the payment is by
Card or cash"), SARB/PASA, and Visa/Mastercard scheme rules (SA is not on the permitted list; no
"convenience fee" carve-out). Breach lets PayFast terminate our only card rail. Receiver-pays is
the only compliant model — and the SA category norm. Recorded in the `no-card-surcharging-sa`
memory; flagged for the NPS counsel brief.

The instinct was right about the *problem* though (the requester's own typed amount is their
anchor; landing under it reads as a loss), so both halves are fixed without touching the payer:

- **Requests under R50 are FREE** — a deliberate, bounded subsidy. PayFast's fixed R2.30 floor
  makes ANY margin-positive fee on R20 exceed 15%, and a flat fee is *worse* at the bottom than
  the percentage — so the only real fix is to absorb it. Costs ~R2.50–R4.10 per absorbed payment
  and buys a card payer whose number we capture: a lead at roughly a tenth of the R35–R60 CAC of
  a Meta ad. Tunable via `WAPAY_PAYREQ_FREE_BELOW_CENTS` (0 disables).
- **Taper across the threshold** — without it the schedule was non-monotonic (ask R49 → net R49;
  ask R50 → net R45.60, i.e. *asking for more paid you less*). The fee is now capped so NET is
  strictly non-decreasing across R1–R3000, asserted exhaustively.
- **Compose-time quote** — the creation message now states what you'll NET before the link goes
  out, and offers the whole-rand ask that nets exactly what you wanted ("make it R55"), which
  routes through the existing, tested amount-change swap. The requester picks the displayed
  price; the payer always pays exactly what is displayed.

356/356, build green.

## 2026-08-26 (2) — Softer payment-request card fee (founder feedback)

The card fee deducted from the person GETTING PAID was rounded up to a whole rand,
landing R50 requests on an ugly flat 10% (R5.00) — most of which was PayFast, not us.
New `paymentRequestFeeCents` rounds up to the nearest **10 cents** instead (deposits keep
whole-rand — the depositor chooses the amount and a clean number reads better). Confirmed
against a real PayFast ITN (R3.18 on R24.00 = 3.2%+R2 excl VAT): every amount R5–R3000
stays margin-positive and never costs the requester MORE than before. R50 fee: R5.00 →
R4.40. WaPay-to-WaPay balance pay remains **free** (buildSend spend→spend, already in
code). Fee still quoted transparently at request creation. `tests/founder-feedback-0825`
pins the ≤-whole-rand and ≥-PayFast-cost invariants across the range. 354/354, build green.

## 2026-08-26 — OTT Payout API: client + documentation (money-out rail groundwork)

OTT sent the Payout API spec — the last thing blocking the payout BUILD. Shipped the client and
project docs (customer-facing withdrawals stay counsel-gated; live calls await generated test creds
+ IP allowlisting):

- **`lib/ott-payout.js`** — full client for all 9 endpoints (PerformPayout, GetBalance,
  GetActiveProviders(+Limits), GetBranchCodes, GetCountryCodes, GetPaymentStatus, ResendSMS,
  VerifyWH) + inbound webhook verification. HTTP Basic auth + SHA-256 request hash, both proven
  **byte-identical to OTT's two published golden vectors** (`Aladdin:OpenSesame`→base64,
  `11`+`123456789012`+apiKey→sha256). Integer-cents money-safety throughout; the OTT-VOUCHER payout
  PIN and recipient PII are never logged.
- **`classifyPayoutStatus`** — the money-safe status→settlement map: SETTLE only on 100; 98/99 and
  any UNKNOWN status stay PENDING (never release a hold we may have paid); explicit failures release.
- **`docs/OTT_PAYOUT_API.md`** — integration guide with the exact per-endpoint hash orders, the
  ledger mapping (reserveHold→payout→settle/hold/release, deterministic epoch-free reference), the
  two sandbox questions the spec leaves open (body encoding JSON-vs-form; amount/empty-optional hash
  formatting), and the launch gates.
- **Adversarial review caught three defects before any live call** (BUGLOG #28): the wire amount was serialised as a JS number while the hash used the 2dp string (every round-rand payout would have failed Invalid Hash — and my test had locked the bug in); transport failures threw instead of returning an indeterminate PENDING; status 3 released a hold that may already have been paid. All fixed, with the caller contract documented.
- `tests/ott-payout.test.mjs` (16 tests) pin the golden vectors, the PerformPayout hash field order,
  webhook verification, the settlement map, and secret hygiene. Suite 354/354, build green.

Next: generate test credentials in the payout portal → sandbox-verify the two open questions →
build the withdraw flow (ledger holds + KYC capture) behind the counsel gate → webhook route.

## 2026-08-25 (4) — Founder live-test batch: localization, flow-escape, safe directed requests

Acting on the founder's real-account test feedback, with a 15-agent adversarial review that
caught (and forced the rewrite of) a critical abuse vector before ship:

- **Deterministic surfaces now speak the user's language** (`lib/localize.js`): home/help/get-paid/
  airtime prompts translated via gpt-4o-mini into the profile language. Money, PR-codes, links and
  phone numbers are FROZEN as placeholders and the model output is rejected unless every placeholder
  returns in EXACT order and count (a reorder could invert "R5–R3000" → "R3000–R5"); fail-open to
  English; cached; 2.5s abort. "Speak Xhosa" now sets the language permanently (locked — rolling
  evidence only yields to a clear, sustained switch) and confirms natively in all 11 languages. The
  matcher was hardened so object phrasings ("reply to my sister in Xhosa", "change my Zulu voucher")
  never swallow the real message.
- **Universal intent-switch escape**: a clearly-stated NEW intent breaks out of ANY waiting state
  (family-aware — an in-flow answer never escapes, PIN digits never look like an intent), fixing the
  founder's stuck data/voucher loops.
- **WaPay-to-WaPay directed requests — SHIPPED SAFE.** "please pay me R50 from <name/number>" now
  delivers ONLY to someone the requester has already saved as a beneficiary, as a PURELY
  INFORMATIONAL nudge the payer opts into by typing "pay request <code>" — it never writes another
  user's conversation state, never renders their spoofable profile name as authority, and returns a
  neutral response so arbitrary numbers can't be probed for WaPay membership. (The first cut planted
  a "reply YES to pay" confirm in any stranger's chat with a spoofable sender — a phishing vector the
  review flagged critical; rebuilt before it ever deployed.)
- **"Buy 100 minutes"** clarifies rand-vs-minutes instead of silently equating.
- **Pay links are now `pleasepayme.co.za/<code>`** and the pay page greets "🙏 Please pay me / with
  WaPay" (founder decision; product stays WaPay-branded; old wa-pay.me links keep working).

337 tests, build green.

## 2026-08-25 (3) — Durable paid-request notifications (BUGLOG #26)

Founder's live R20 test paid perfectly but notified nobody: sends were gated on the
one-shot PENDING→PAID transition, and a mid-send invocation death (ITN had no
maxDuration) lost them permanently. Notifications now live in `lib/request-notify.js`
— idempotent flags in intent metadata, set only on a successful send; the ITN runs it
on EVERY delivery so redeliveries repair; `POST /api/admin/notify-request` repairs on
demand; ITN gets 30s, the WhatsApp webhook 60s. 317/317, build green.

## 2026-08-25 — Voucher balance on home, pay-link CTA button, request-paid template fallback, BSUID banked

- **Voucher balance (founder ask)**: the home screen and the deterministic balance answer now show `🎟️ Vouchers bought: R120 (3) — reply "my vouchers"` — SELF-bought vouchers only (gifts to others were given away), CANCELLED excluded, best-effort (a balance surface can never fail on the voucher query). Copy says **bought**, never "unspent": OTT gives us no redemption visibility yet — that ask is now item 3 in `EMAIL_TO_KEAMO_3.txt`; when OTT exposes voucher status we upgrade the line to true "active".
- **Pay-link presentation (founder ask)**: the requester's own copy is now a tappable CTA button ("View my payment page", plain-text fallback). The FORWARDABLE message keeps the visible short link deliberately — WhatsApp strips interactive buttons on forward, and the forwarded message is the payer's only road in.
- **Requester-notify template fallback**: a request paid on day 6 lands outside the requester's 24h service window, where free-form is rejected — the ITN now falls back to the env-gated `wapay_request_paid` template (spec in `docs/whatsapp-new-templates.md`; set `WAPAY_TEMPLATE_REQUEST_PAID` after Meta approval).
- **Meta template rule documented** (bit the founder live): body text may not start or end with a variable — paste-ready bodies for `wapay_payment_receipt` + `wapay_request_paid` in the templates doc.
- **WhatsApp usernames/BSUID banked** (`docs/whatsapp-bsuid-usernames.md`): BSUIDs already in webhooks; username adopters lose visible phone numbers — adoption plan queued (capture `user_id` now, resolution by msisdn-or-bsuid, REQUEST_CONTACT_INFO onboarding leg July 2026+); reserve the `wapay` business username (claimable since June 29). Merchant "pay me" card concept noted — printable TODAY with wa-pay.me/PR-links.
- Suite 304/304, build green.

## 2026-08-25 (2) — Payout agreement SIGNED; Collect analysed and deferred

- **Founder signed the OTT Payout Agreement.** `EMAIL_TO_KEAMO_4.txt` returns it and
  asks for the blockers: API credentials + base URL (sandbox/prod), documentation in a
  usable form, webhook spec, IP-allowlist process, and the activation checklist (KYC
  list, Annexure A settlement details, minimum pre-funding).
- **Collect: DEFER, do not sign** (`docs/WAPAY_OTT_COLLECT_ANALYSIS_2026-08-25.md`,
  40-agent adversarial review of the contract text). The wallet-credit inversion —
  redeeming Standard Bank Instant Money / Nedbank / VodaPay vouchers straight into a
  WaPay balance — is **expressly forbidden** by clause 16.3 ("the Consumer may only be
  paid out in cash"), reinforced by definition 1.9 read with 2.1.12. Collect as drafted
  needs premises, vendors and cash floats WaPay does not have (11.1 is literally
  unperformable). ⚠️ Signing it as a dormant contract is dangerous: warranty 17.4 plus
  24.2.4/25.2.4 turn it into a live misrepresentation claim.
- **But the prize is real**, which is why one email is worth sending: Reading B replaces
  a ~R20.70 PayFast cost per R500 loaded with ~R1.19 EARNED, and inverts the float
  direction. `EMAIL_TO_KEAMO_5_COLLECT.txt` asks the two decisive questions: does a
  digital-settlement variant exist, and is "cash only" OTT's rule or a bank scheme rule
  (if the latter, an OTT side letter protects us against nobody).

## 2026-08-25 — Payout commercials: VAT-true rail costs + banded CashSend fees

Read the signed-ready **OTT Payout Agreement** (Annexure A) and corrected two margin
errors baked into the fee model:

- **VAT was being ignored.** Supplier rates are quoted EXCL VAT and WaPay is not
  VAT-registered, so that VAT is an unrecoverable real cost. `cashoutRailCostCents`
  now grosses every rail cost up (`VAT_BPS`, `inclVatCents`): Pay@ R8.65→R9.95,
  PayShap R2.50→R2.88, RTC R4.50→R5.18, CashSend R9.96→R11.46. Margin was
  previously overstated by ~15% on every withdrawal.
- **A flat R14 CashSend fee went underwater above ~R738 face** (the 0.3% switching
  fee rises with the amount). Customer fees stay FLAT but are now **banded** —
  the shape already approved for deposits: R50–R700 = R16, R701–R1500 = R21,
  R1501–R3000 = R28. Every rail is now margin-positive at every cent from R50 to
  R3000, asserted exhaustively in `tests/payout-fees.test.mjs`.
- **The 0.3% is CashSend/VAS only** (Annexure A 3.2), NOT PayShap/RTC (3.3, "Bank
  EFT Products") — locked by test, because a stray percentage on PayShap would
  erode the one rail the withdrawal margin rests on. PayShap earns a constant
  **R3.12** at any ticket size and is the rail to steer customers to.

Suite 313/313, build green. Payout code itself is still unbuilt — blocked on OTT
Payout API credentials + base URL (Keamo). Collect agreement reviewed: it makes
WaPay a PHYSICAL cash-out agent with a vendor terminal base holding float —
wrong shape for a WhatsApp wallet, formally declined.

## 2026-08-22 (3) — Card payers auto-register + 41-agent adversarial-review hardening

**Every card payer becomes a WaPay lead (founder ask)**: the pay page card leg is a POST form capturing the payer's WhatsApp number (required client-side; the API never blocks a payment on a bad/missing number — the requester getting paid outranks the growth hook). The number rides the SIGNED PayFast session (`custom_str1`), so the ITN sends the receipt to whoever actually paid — a later checkout click can never redirect it. Back from PayFast, `?r=1` renders a confirming state with NO pay buttons (double-charge guard) plus a "Get my receipt + my own WaPay" wa.me button (prefilled `Receipt PRXXXXXX`). The processor answers that ask for ANY sender BEFORE the onboarding gate — a brand-new payer gets their receipt, then falls straight into onboarding. The ITN pushes a purely-transactional receipt (free-form when the payer's service window is open; env-gated template fallback `wapay_payment_receipt` — spec in `docs/whatsapp-new-templates.md`, awaiting Meta creation + `WAPAY_TEMPLATE_PAYMENT_RECEIPT`).

**Adversarial review before ship (5 lenses × per-finding refuters, 41 agents): 28 confirmed findings, all fixed** — though a parallel-session push (`619a285`) briefly carried the PRE-fix versions to prod; this commit replaces them (BUGLOG #25). Highlights: `@wapay/whatsapp` send functions never throw — they resolve `{ok:false}` — so the catch-based template fallback was dead code (now branches on the result); last-click-wins receipt hijack → `custom_str1` binding with ITN persisting the true payer; payer number moved out of the GET query string (platform logs) into the POST body; `/api/health?config=1` now FAILS CLOSED behind `WAPAY_INTERNAL_API_KEY`; the receipt intercept is anchored + code-alphabet-restricted (`/i` matching had hijacked "receipt problems"/"is my receipt prepared"); a payer charged after the requester cancelled is never told "no payment was taken"; POPIA copy honesty (both uses of the number disclosed, no upsell inside push receipts, template spec stripped to pure Utility). BUGLOG #24. Suite 297/297, build green.

## 2026-08-22 (2) — Amount-change swap for payment requests

"Change my amount to R1000" now swaps in one step: the newest PENDING request is cancelled (old link announced dead), a fresh request is created at the new amount, and the forwardable message follows — links are single-use, so edit = cancel + recreate, standing behavior (deterministic matcher + orchestrator knowledge). PayFast real rate confirmed from stored ITN: 3.2% + R2.00 excl VAT — depositFeeCents defaults are correct, margin-positive on every card transaction. Suite 290/290.

## 2026-08-22 — Fee flip, question-answering, short domain prep, project constitution

- **Payment-request fee direction flipped (founder decision)**: the PAYER pays exactly the request amount (no fees, and the page says so); the card fee is deducted from what the REQUESTER receives. Creation copy quotes both outcomes upfront. Balance payments remain fully free.
- **Questions no longer trigger flows**: "Where does the money go when they pay me?" was hijacked into the create-request flow (live sighting) — interrogatives without create-verbs now escape to the AI, whose request-money knowledge is dialed in (mechanics, fee direction, instant balance landing).
- **Short pay-link domains prepped**: host rewrite for pleasepayme.co.za / pleasepayme.io → /pay/:code; PAYLINK_BASE_URL env switches generated links to the short domain the moment DNS is attached.
- **CLAUDE.md project constitution added**: money-safety + policy invariants, engineering discipline, parallel-session rules, and the context-handover policy — every Claude thread reads it automatically at session start.
- Verified: the emailed OTT issuer credentials are STALE (401) — the live key is the rotated one in local .env (GetBalance R100k confirmed). 269/269 tests.

## 2026-08-21 (2) — Full QA audit: 45-agent sweep, 38 confirmed findings, all money/critical/major fixed

Six-dimension adversarial audit over everything shipped this week (payment requests, deposit fee + ITN, voucher flows, routing/states, orchestrator contract, ledger invariants) + live SSR smoke of the public pay page against prod. Money-severity: timestamp-poisoned VAS settle idemKeys (every vend would deliver-but-not-charge — BUGLOG #17), payment-request card leg not exactly-once (#18), fee-free self voucher booking the R3 anyway (#20), Blu redemption 1-in-481 cash-strand (#17). Critical/major: PIN-attempt burning (#19), unreachable broke-checkout resume (#21), bearer-PIN strand on failed claim send (#22), and an 11-item routing/state batch (#23) incl. multilingual YES words, phone-as-amount, deposit-status vs deposit-link, contact-share hijack. Suite 269/269, build green. Known-open minors logged in BUGLOG #23.

## 2026-08-21 — 🙏 Payment requests ("please pay me") — shareable links, two payment legs

"Please pay me R150" / "payme link" (any language — REQUEST_MONEY orchestrator action, live-verified incl. isiZulu) creates a shareable request (`payment_requests`, prod-applied: PR-prefixed letters-only codes, R5–R3000, 7-day lazy expiry, PENDING→PAID exactly once). The user gets a forwardable message + `wapay.co.za/pay/<code>`. The public page (`pages/pay/[code].js`) offers both legs:

- **Pay from a WaPay balance — free**: deep-links back into WhatsApp ("Pay request <code>") → confirm → wallet PIN → `buildSend` (free spend→spend) posted with the request code as idemKey, so exactly ONE payer can ever pay it (a racing payer replays harmlessly and is told). Both sides get instant receipts; the requester is notified with their new balance.
- **Pay by card/EFT — no WaPay account needed**: `/api/pay/checkout` mints a PayFast intent (route `payrequest`, payer covers the banded payment fee, requester credited FACE) and the ITN marks the request PAID atomically. Every non-WaPay payer sees the get-your-own-WaPay hook.

Insufficient balance on the in-chat leg becomes the standard top-up checkout moment. `tests/payment-requests.test.mjs` (+11, suite 269/269). Also: OTT negotiation email drafted (`EMAIL_TO_OTT_NEGOTIATION.txt` — Payout asymmetries, Merchant 6% fee, ops annexure, Collect parked).

## 2026-08-20 (2) — User memory, GPT-5.5 brain, fee-free self vouchers, voucher history

- **Root cause of every live voucher failure found: `OTT_BASE_URL` (and the OTT credentials) were never set in Vercel** — the OTT client crashes at construction in production. USER ACTION: copy the four `OTT_*` vars from local `.env` into Vercel and redeploy. (The crash-release guard worked: the stranded hold auto-released with `execute_crashed:Missing env OTT_BASE_URL` — that log line was the diagnosis.)
- **User memory system** (`Account.profile` JSONB, prod-applied; `lib/user-profile.js`): language (evidence-counted — one foreign test line can't flip it), preferred deposit method (written by ITN success=CARD, redemption success=VOUCHER), last electricity meter, product interests. Injected into the orchestrator every turn as `KNOWN USER PROFILE`; deposit-with-amount offers BOTH load methods until the preference is known (then straight to their rail).
- **Language bug fixed** (bot answered "Okay" in isiZulu after one zu test line): reply language = the CURRENT message's language, history is context only, neutral messages fall back to the profile language. Live-verified.
- **Model upgrade: gpt-5.5 orchestrator + gpt-5.4-mini agents** (probed live; GPT-5-family params adapted — `max_completion_tokens`, `reasoning_effort: none`, no temperature). **Golden eval: 132/132 = 100%** across all 11 languages (up from 99.2% on gpt-4o), ~1s per call. Env-tunable as before.
- **Self OTT vouchers are fee-free** (fees belong on money-IN and on sending to others; WaPay still earns the OTT issuing commission). Copy: "⏳ Generating your OTT voucher..." for self ("sending" is reserved for sending to people).
- **Broke checkout**: insufficient balance for a voucher now quotes the shortfall, sends a PayFast button for exactly that top-up, and **resumes the purchase automatically** on the next message after the money lands (`RESUME_VOUCHER_PURCHASE`).
- **Voucher history + retrieval**: "my vouchers" lists date/value/serial/status from `pending_gifts`; "voucher pin <serial tail>" re-sends a PIN **behind the wallet PIN** (verifyPIN with lockout).
- Suite 258/258.

## 2026-08-20 — Deposit fee, OTT self-purchase, state escapes, policy sweep, ledger repair

Founder live-testing batch (first fully auto-credited deposit confirmed: R30 → "✅ Deposit received", closing the deposit E2E objective):

- **Deposit payment fee**: card/EFT deposits now charge gross = credit + fee (`depositFeeCents`: 4.2% + R2.30 rounded up to a rand — env-tunable `WAPAY_DEPOSIT_FEE_BPS`/`_FIXED_CENTS` until PayFast's real rate card is read). Quoted before the tap ("R30 deposit + R4 payment fee = *R34*", button pays gross); ITN verifies gross, credits face, books the fee to `REVENUE:FEE:DEPOSIT` (`buildLoad` gained `customerFeeCents`). Deposits are no longer loss-making.
- **OTT voucher self-purchase**: "buy an OTT voucher" (any phrasing/language — deterministic short-circuit + orchestrator `self=true`) → confirm (amount+fee) → wallet PIN → OTT issue → **PIN delivered in-session immediately** via the atomic claim flow. Insufficient balance becomes a checkout moment (shortfall + both load options). The stale "🎮 Lifestyle & OTT Vouchers" (Netflix/Uber) menu can no longer swallow OTT-voucher asks.
- **Trap-state escapes**: real sentences/questions inside `AWAITING_VOUCHER_PIN` and `DEPOSIT_CARD_AMOUNT` now escape to the full router (orchestrator included) instead of looping "Invalid Voucher PIN" (live sighting: "I want to use my bank account").
- **Policy/stale-content sweep (3-agent workflow, all fix-now findings applied)**: `showCategoryProducts` + context-aware follow-ups now coming-soon gated; "what can I buy" advertises live categories only; **every betting word scrubbed from WhatsApp-facing copy** (menus, gates, errors, keyword maps — Meta policy); 'ott'/'voucher'/'send money' keywords reserved for the money rail; no-API-key fallback menu cleaned; orchestrator HELP no longer teases cash-out. Dead code deleted: legacy `message-processor.js` (V1), `chat.ts`/`chatWithAI`, orphan AI states, `renderHome` dead vars.
- **Ledger repair + crash-proof holds** (BUGLOG #15/#16): R36 of stuck ACTIVE holds released, R20 unbacked double-credit removed — founder balance now R50.00 = exactly the journal. Voucher execute releases its hold in the outer catch on any crash.
- Suite 247/247.

## 2026-08-19 — 🎉 OTT float landed (R100k) + comma-amount parser fix — send-money UNBLOCKED

OTT IT Support loaded the R100,000 test float — and the very first balance check found a real bug: OTT formats large amounts with comma thousands separators (`"100,000.00"`) and `randToCents` rejected them, failing GetBalance. Fixed: well-formed comma grouping (and only that) is stripped before exact string-math parsing; malformed comma patterns still throw. This also protects voucher issuing at the R1000 cap (`"1,000.00"`). Live-verified: balance R100,000.00. New `tests/ott-rand-parsing.test.mjs`; suite 238/238. **The voucher-gift ("send money") live test is now unblocked.** Test vouchers for merchant redemption received from OTT (stored locally, gitignored — redemption client still needs OTT's Merchant API docs + credentials). Deposit cash-in copy expanded to the founder's step-by-step wording.

## 2026-08-19 — Contact-card sends, remembered beneficiaries, cash-vs-bank copy

Founder asks from live testing, all shipped:

- **Share a contact to send money**: the webhook now handles `contacts`-type messages (previously silently dropped). Mid-flow, a shared card fills the number the flow was asking for; fresh, it starts a send-money ask with the recipient prefilled ("💸 Send money to Philly (0798743910) — how much?"). Invalid/foreign numbers get a polite fallback.
- **Remembered beneficiaries** (`beneficiaries` table, applied to prod; `lib/beneficiaries.js`): every successful gift recipient and every shared contact is upserted per (account, msisdn) — names come from contact cards and are never overwritten with null. "send R50 to Philly" now resolves by name: new `recipientName` slot in the orchestrator (verified live: "send R50 to Philly" → SEND_VOUCHER + name), dispatch looks it up (unique hit proceeds, ambiguity lists options, miss asks for the number), and the `VOUCHER_GIFT_RECIPIENT` state accepts names too. The full number at confirm remains the human gate on every resolved name.
- **Deposit prompt rewritten — cash vs card/bank**: option 1 CASH (pay the cashier at any major retailer, get a Blu Voucher code, send it in); option 2 CARD/BANK (PayFast: cards, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan, Zapper). The orchestrator's product truth carries the same framing.
- **Withdrawals explained**: the balance is spend-only; cash-out runs through WaPay vouchers two ways — cash at participating retail partners, or paid into a bank account via PayShap (voucher-partner rails, rolling out). Withdrawal questions no longer fast-path to the generic help menu (verified live in en + af).
- **Deposit-status PENDING carries a retry line** — prompted by a live FNB decline (2026-08-19): the bank declined the charge on PayFast's page, so no ITN ever fires and the intent stays PENDING forever; the status answer now says nothing left the account and how to retry. (Server side was verified clean — the decline happened between FNB and PayFast.)
- Suite 233/233.

## 2026-08-18 — AI orchestration engine: two tiers, 11 languages, structured outputs

The single temperature-0.7 gpt-4o call (bare `JSON.parse` of free text) is replaced by a two-tier engine in `packages/ai/src/orchestrator.ts`:

- **Tier 1 — orchestrator (gpt-4o)**: detects language (all 11 official SA languages) + domain (MONEY/AIRTIME/DATA/ELECTRICITY/SEND/DISCOVER/CHAT), and completes trivially-clear intents in one call (fast path: balance, deposit status, help, home).
- **Tier 2 — category agents (gpt-4o-mini)**: per-domain slot extraction + a reply in the user's language.
- Every call uses OpenAI **strict structured outputs** at temperature 0 with 15s fail-fast timeouts. Models env-tunable (`WAPAY_ORCHESTRATOR_MODEL`, `WAPAY_CATEGORY_AGENT_MODEL`) for the later Claude migration.
- The processor's free-text path (`handleAIChat`) now dispatches through `dispatchOrchestratorAction`: model output is treated as **untrusted input** — msisdn re-validated (`normaliseMsisdn`+`isValidSaMsisdn`), amounts integer-checked, the model's meter slot deliberately never used (the flow collects meters). Actions map onto the SAME deterministic preview→PIN flows as the keyword router; `SEND_VOUCHER` reuses `resolveGift`. The engine proposes; it never executes.
- Prompts carry the money-truth rules (never state balances/status — return the action; the ledger answers) and the honest product list (no betting/Netflix claims).
- **Live eval: 132-case golden corpus** across all 11 languages with realistic typos/code-switching (`tests/fixtures/orchestrator-golden.json`, generated by 11 parallel language agents; harness `scripts/eval-orchestrator.mjs`): 99.2% first run, the single miss (EN redeem-voucher phrasing) fixed by a prompt sharpening and re-verified. Slot extraction (amounts to the cent, msisdns) 100% on hits.
- Wiring tests `tests/orchestrator-routing.test.mjs` lock the invariants (re-validation, no direct money movement in dispatch, strict schema, temp 0).
- **Adversarial review (4-dimension multi-agent workflow) found 9 issues, all fixed pre-ship**: worst-case latency cut from ~60s to ≤20s (10s timeouts, no provider retries inside the webhook budget); `productQuery` now routes to the smart product pipeline instead of dying in an unread entities key; coming-soon categories keep their gate on the AI path; a model-carried airtime recipient survives the amount ask; deposit ask joins conversation history; provider errors are logged before normalization. Plus three money-safety hardenings: **the voucher confirm + PIN prompt now show the FULL recipient number** (a model-proposed destination must be verifiable by the sender before a bearer voucher goes out — masking stays in logs); **receipt-shaped AI replies are deterministically blocked** (`looksLikeReceipt` — the official thread can no longer be tricked into minting fake proof-of-payment via "repeat after me" / translation attacks); **13+ digit runs are redacted** from logs and stored conversation history (`redactBearerDigits` — a 16-digit voucher PIN is money; phone numbers survive for slot-filling). Suite 222/222.

## 2026-08-18 — Deterministic deposit-status intent

"Did my payment go through?" / "where is my money" / "payment status" now short-circuit **before the AI path** to `handleDepositStatus`, which reads the account's newest PayFast intent (`getLatestDepositIntent`, newest-first by `requestTs`) and answers factually: SUCCESS → amount + live balance; PENDING → "PayFast is still confirming your R… — I'll message you here the moment it clears" (the ITN confirmation is that message); FAILED → plain statement + retry hint. Every reply carries the live balance, closing the founder's stale-balance complaint. The matcher (`matchDepositStatusRequest` in `lib/deposits.js`, pure) is deliberately narrower than the deposit-link pattern — "I want to deposit money" still routes to the deposit prompt. Tests: `tests/deposit-status.test.mjs` (+8, suite 209/209).

## 2026-08-18 — PayFast deposit UX: preamble + tappable button

The card-deposit reply is no longer a raw URL. `handleCardDepositLink` now sends a WhatsApp interactive **CTA-URL** message: a preamble that explains the round trip ("I'll take you to PayFast … pay by card or Instant EFT … you'll be brought straight back to this chat"), a *Secured by PayFast* footer, and a `Pay R<amount> now` button that opens the checkout. New `sendWhatsAppCtaUrl` / `buildCtaUrlPayload` in `@wapay/whatsapp` (pure payload builder, Meta limits enforced — 20-char button cap verified against the worst-case deposit amount). If the interactive send is rejected the handler logs `deposit_cta_fallback` and falls back to the old plain-text link — presentation can never block a payment. Tests: `tests/deposit-cta.test.mjs` (+8, suite 201/201).

## 2026-08-18 — `0253633` — PayFast modern ITN source range; wa.me return

The first real R20 deposit's ITN was rejected `SOURCE_IP_REJECTED`: PayFast's modern network (observed 102.216.36.1) postdates the documented 2019-era CIDR list. The range was added and the source-IP check demoted to warn-only unless `PAYFAST_ENFORCE_SOURCE_IP=true` (signature + server POST-back remain the strong checks). The R20 was credited manually with the intent's idemKey (replay-safe). Return/cancel URLs now deep-link to `wa.me/27760497624` so "Back to WaPay" reopens the chat instead of stranding the payer on the API landing page.

## 2026-08-18 — `8b19401` — Deposit option 2 collects an amount; single-screen bank home

Choosing card/EFT from the deposit menu now asks for the amount (new `DEPOSIT_CARD_AMOUNT` conversation state, accepts "20" / "R20" / "deposit R20", cancellable) instead of dead-ending. "hello"/"home" renders the single-screen bank-style home the founder approved.

## 2026-08-18 — `75370ba` — AI knows the real deposit options; typo-tolerant deposit routing

The AI prompt was answering deposit questions from stale knowledge (inventing options). Prompt now reflects the two real options (Blu voucher, card/EFT). Deposit intent matching made typo-tolerant; "home" escapes the voucher-PIN state.

## 2026-08-18 — `667b3a7` — PayFast money on-ramp

"deposit R100" in chat mints a signed PayFast checkout link (card/Instant EFT). `@wapay/providers-payfast` builds the checkout URL and verifies ITNs 5-step (signature over raw fields **including empty ones** and the merchant passphrase — review caught the passphrase omission that would have silently failed every live payment — plus source IP, amount, status, server confirmation). `lib/deposits.js` stores deposit intents whose row id is `m_payment_id` and whose derived idemKey makes ITN redeliveries credit exactly once. Verified ITN → ledger credit at FACE → WhatsApp confirmation with new balance. Caps R10–R3000. Root `pnpm test` fixed for Node 24 glob form. 193/193 tests.

## 2026-08-18 — `9c27da7` — Voucher gift: send money as an OTT-issued voucher

"Send R50 to 084…" became a real feature: preview (R3 flat fee) → YES → PIN → `reserveHold` → OTT `GetVoucher` (deterministic reference from the idemKey) → `ConfirmVoucher` → `settleHold` (category VOUCHER, rail OTT) → row in `pending_gifts`. The recipient gets the `wapay_voucher_received` template (no PIN in it); the voucher PIN is delivered when they reply — the claim **is** the onboarding loop. Timeout recovery per the OTT spec (`CheckVoucher` then confirm/reject); `RejectVoucher` + `releaseHold` when delivery is impossible. Voucher PINs never logged (static-test enforced). `pending_gifts` migration applied to prod. Docs (`CAPABILITIES.md`, `CHANGELOG.md`, `BUGLOG.md`) brought in-repo. 168/168 tests. Live E2E blocked on OTT float + Reseller agreement.

## 2026-08-18 — `6096585` — Mute-bot fix: await processing before ACK

The deployed webhook ACKed 200 to Meta and then processed the message in a fire-and-forget async block. Vercel serverless kills work after the response, so processing never ran and the bot went silent after the `44b51c9` deploy. This commit restores the correct ordering — verify signature → process the message (awaited) → ACK — and hardens it: the static wiring test now enforces the ordering and bans void-async in the webhook. Also gives the user-manager prisma import a `.js` extension so local simulation matches production module resolution. Bot confirmed working by the founder the same evening.

## ~2026-08-17 — `44b51c9` — Semantic search layer + OTT issuing client

Two additions (deployed to Vercel 2026-08-18):

- **Semantic search**: pgvector migration, `lib/vas-embeddings.js`, and `hybridProductSearch` in `lib/vas-search.js` — semantic-first product search with lexical fallback. 854/854 products were subsequently embedded (text-embedding-3-small) and live-verified. Not yet wired into the chat free-text path.
- **OTT client** (`@wapay/providers-ott`): voucher issuing client with `getVoucher / checkVoucher / confirmVoucher / rejectVoucher`, deterministic references, enforced timeout recovery (`TIMEOUT_CHECK_REQUIRED`), AUTH/USER_INPUT/RETRYABLE error taxonomy, and `GetAPIKey` protected (it rotates the live key). Sandbox GetBalance verified live.

## ~2026-08-16 — `83a68fe` — Voucher template rename

Recipient-notification template aligned to `wapay_voucher_received` (created in Meta, category Utility, pending approval). This is the template that lets gift/voucher notifications reach numbers that have never messaged the bot.

## ~2026-08-16 — `f9b52eb` — Catalog endpoint fix

The VAS catalog sync was calling a dead Blu endpoint and silently importing only 20 products. Fixed the endpoint; catalog went from 20 to 831 products. Account reset tooling added alongside.

## 2026-08-15 — `2360f18` — Money-safe ledger, webhook security, gifting

The foundation commit:

- **Ledger**: `lib/ledger-core.js` (chart of accounts, fee model, balanced-entry builders) + `lib/ledger-post.js` (atomic idempotent `postEntry`, `reserveHold/settleHold/releaseHold`, `claimMessage` dedupe, reconciliation) + Prisma migration `20260810_ledger_core` (two-tier wallets, unique idemKey, holds, processed_messages, CHECK constraints). Later verified 21/21 against the live DB.
- **Webhook security**: HMAC signature verification over the raw body wired into `pages/api/webhooks/whatsapp.js` (401 before ACK), leaked fallback verify-token removed, per-message dedupe.
- **Money-safe refactor**: airtime (reference pattern), then data and electricity execute routes moved onto ensureWallet → reserveHold → provider → settleHold/releaseHold; balance endpoint fixed (SPEND wallet, 503 on DB failure); preview routes gated behind internal auth.
- **Gifting** (`lib/gifting.js`): the V1 wedge — send airtime/data to another number as a SPEND (goods), never a transfer; bare cash-send refused and redirected; recipient notification template-aware.

## Before 2026-08-15 — pre-history (January baseline)

The original V1.01 build: WhatsApp onboarding (OTP, PIN, consent templates), Blu voucher redemption for wallet load, Blu VAS vending (airtime/data/electricity), single gpt-4o chat, Vercel deployment. Stable but money-unsafe (non-atomic flows, unsigned webhook) — the problems the 2026-08-15 commit exists to fix. See `docs/BUGLOG.md` for the specific defects found and closed.
