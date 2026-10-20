# Launch scope: what customers may use today, and the switches

*Decided by the founder on 2026-10-18, the day the first Click-to-WhatsApp ad went
into Meta's review. Shipped the same day (CHANGELOG 91). One place to read what is
live for customers, what reads "coming soon", and how each item is switched on.*

## 1. The decision

Airtime, data and prepaid electricity, cash top-ups with a Blu voucher, top-ups with an
OTT voucher PIN, and buying a WaPay (OTT) voucher for yourself are **built and testable
but not active for customers**. Every customer surface says **"coming soon"** (never a
date) and then what works today. "We continue building this in the background."

Live and untouched: getting paid with a "please pay me" link, adding money by card or
Instant EFT, **sending money** (the founder, same day: "stays on, 100%, including to
non-members"; the round-5 build moves it from an OTT voucher to a ledger transfer),
withdrawals (PayShap, Nedbank and Absa cash, FNB eWallet), balance, transactions,
business accounts, PIN reset.

Why now: the ad brief's section 2 promised customers exactly this truth list, the regular
chat still sold airtime, data and electricity on Blu's QA credentials (no production
credentials exist, `docs/BUGLOG.md` #116), and the OTT issuing contract is signed but the
product decision on vouchers is still open.

## 2. The switches (Vercel env, read at call time, no cold start needed)

**The master hold comes first.** `WAPAY_LAUNCH_HOLD` unset (the shipped default) holds
every product in the table below off for everyone, whatever the per-product switches and
tester lists say. The founder tested from his own number on 18 October and saw
electricity and fuel open, because that number sat on two tester lists from earlier
rollouts with their switches still on; the hold makes the code default win over any
switch left behind. `WAPAY_LAUNCH_HOLD=off` releases it, and the per-product switches
and allowlists apply again exactly as described.

| Switch | Default | Turns on | Tester-only form |
|---|---|---|---|
| `WAPAY_LAUNCH_HOLD=off` | **hold** (unset) | releases the table below | n/a |
| `VAS_LIVE_AIRTIME=true` | off | buying airtime (self or any number, Blu) | `+ VAS_ALLOWLIST_AIRTIME=27…,27…` |
| `VAS_LIVE_DATA=true` | off | data bundles (Blu) | `+ VAS_ALLOWLIST_DATA=…` |
| `VAS_LIVE_ELECTRICITY=true` | off | prepaid electricity (Blu) | `+ VAS_ALLOWLIST_ELECTRICITY=…` (the existing idiom) |
| `VAS_LIVE_BLU_LOAD=true` | off | cash top-up with a Blu voucher PIN | `+ VAS_ALLOWLIST_BLU_LOAD=…` |
| `VAS_LIVE_OTT_LOAD=true` | off | top-up with an OTT voucher PIN (also needs `OTT_MERCHANT_API_KEY`) | `+ VAS_ALLOWLIST_OTT_LOAD=…` |
| `VAS_LIVE_OTT_VOUCHER=true` | off | buying a WaPay (OTT) voucher for yourself | `+ VAS_ALLOWLIST_OTT_VOUCHER=…` |
| `WAPAY_WICODE_LIVE=true` (existing) | off | fuel vouchers | `+ VAS_ALLOWLIST_FUEL=…` |
| `WAPAY_PAYOUT_ENABLED=true` (existing) | **on in production** | withdrawals | `WAPAY_PAYOUT_ALLOWLIST` |

Rules: while the hold holds, nothing below it is on for anyone; once released, a switch on
with no allowlist is on for everyone, an allowlist narrows an ON switch to the named
WhatsApp numbers, and an allowlist alone switches nothing on. Nothing needs to be set in
Vercel for today's launch: the code defaults are the launch scope.
`lib/vas-config.js` is the one module every gate reads; `launchScope(waId)` is the
object every copy builder takes.

## 3. What each surface says while a switch is off

| Surface | Wording (English; the processor localises) |
|---|---|
| Home card | live products keep their lines (`💸 *Send*: "send R50 to 083..."`, `💳 *Deposit*: "deposit R100" by card or Instant EFT`, withdraw); nothing off gets a product line; one line names everything off: `🔜 *Coming soon*: airtime, data, electricity, fuel vouchers, cash deposits with a Blu or OTT voucher and a virtual card` (founder, 18 October: the home card must say the categories, cash deposits and the virtual card are coming soon) |
| Help menu | no Airtime, Data, Electricity or Voucher line; Send money, Get paid, Deposit, Withdraw, Business, Forgot PIN remain |
| "buy airtime", "buy R50 electricity", "show MTN bundles", the AI's BUY_* proposals, a parked PIN step | `📱 Airtime is coming soon on WaPay. I will tell you the moment it is live.` + `Right now you can get paid with a "please pay me" link, add money by card or Instant EFT, send money to any SA number and withdraw to your bank or as cash at an ATM.` |
| "Can I buy electricity?" (how it works) | the same coming-soon shape, never the steps, no YES offer |
| "redeem voucher", "add money", "deposit" | the card / EFT amount ask, then `Cash top-ups with Blu and OTT vouchers are coming soon on WaPay. I will tell you the moment they are live.` |
| a typed 12/16-digit voucher PIN, a parked voucher-PIN step | `🎟️ Cash top-ups … coming soon … Keep your voucher safe. For now you can add money by card or Instant EFT: say "deposit R100".` + what works |
| "can I deposit with an OTT voucher?" (question) | `Not yet. Cash top-ups … coming soon … say "deposit R100"` |
| "buy an OTT voucher for R50" | `🎟️ Buying a WaPay (OTT) voucher for yourself is coming soon on WaPay …` + what works |
| "what can I buy" | the catalogue of what works, then `🔜 Coming soon: airtime, data, electricity, fuel vouchers and cash top-ups with Blu and OTT vouchers.`; no product menu, no "buy airtime" tip |
| fee questions | no Blu cash fee quoted, `Airtime, data and electricity are coming soon, so there is no product fee to quote today.` |
| the model (orchestrator product truth, brain knowledge, FEES block, HOW IT WORKS) | `COMING SOON, NOT AVAILABLE TODAY (absolute): …` with what works today; the withdraw truth unchanged |
| the Pay agent's tools and prompt | `start_buy_airtime`, `start_buy_data`, `start_buy_electricity`, `start_voucher_load`, `start_fuel` are not offered; the capability list ends with a coming-soon line the model must not offer or start; a purchase command ("Buy airtime", "Buy fuel", a bare "data") is answered by the flow's coming-soon reply before the model (`lib/agent/guards.js` `comingSoonCommand`), questions still reach the model |
| onboarding fallback list | `💳 Add money by card or Instant EFT`, `🔜 Coming soon: airtime, data, electricity, fuel vouchers and cash top-ups with Blu and OTT vouchers` |
| ad arrivals | unchanged: the brief's own sentence, `Airtime, data, electricity and fuel are coming soon.` |

Never a date, never a betting word, never an em dash (locked by `tests/launch-scope.test.mjs`).

- **The withdraw gate's add-money line** (`lib/payout-gate.js`, tiers 1 to 3) names "a cash voucher bought at a till" only while `BLU_LOAD` is live for that number; otherwise "card or bank" (BUGLOG #118, CHANGELOG 95).

## 4. Where the gates sit (so nothing can be bought while off)

`pages/api/webhooks/message-processor-v2.js`: the airtime, data and electricity intent
cases (keyword and orchestrator), the smart product query's airtime and electricity
branches, the context-aware airtime case, the airtime product list, the three preview
functions, every parked ask, confirm and PIN step of the three categories (a flow parked
before the switch flipped is released, never continued), the data-slots entry; `REDEEM_VOUCHER` and
`VOUCHER_PIN` intents, the `AWAITING_VOUCHER_PIN` and `AWAITING_DEPOSIT_METHOD` states,
`handleVoucherRedemption` and `attemptOttRedemption`; the OTT self-purchase short-circuit,
the orchestrator's `SEND_VOUCHER` with `self`, and the gift preview when the intent is the
self-purchase. The send flow to another number is not gated here.

Per-customer everywhere (`isCategoryEnabledForWaId`, `isRailLiveFor`); the global check
(`isCategoryLive`) is left for menus only. `lib/capabilities.js` rows read the same
functions, so the Pay agent's tools, home, help, the welcome list and the model prompt
cannot drift from the flows.

## 5. How to test it (founder, own number, production)

1. `hi`: the home card has no Buy line, Send live, Deposit by card or Instant EFT, and one coming-soon line naming airtime, data, electricity, fuel vouchers, cash deposits and a virtual card.
2. `buy airtime`, `buy R50 electricity`, `show MTN bundles`: coming soon and what works; no amount, meter or bundle ask.
3. `redeem voucher`: the card / EFT amount ask with the cash position; `cancel`.
4. Type any 16 digits: coming soon, keep the voucher; no "Processing Voucher".
5. `buy an OTT voucher for R50`: coming soon; no confirm.
6. `Can I buy electricity?`, `What can I buy with this?`, `how much does it cost to deposit cash?`: the coming-soon shape, the catalogue of what works, no Blu fee.
7. `send R20 to <a friend>`: unchanged today (a voucher until the round-5 ledger send lands); `please pay me R50`, `deposit R100`, `withdraw R20`: unchanged.
8. To try a product privately: set `WAPAY_LAUNCH_HOLD=off`, the product's switch to `true` and its allowlist to your number, redeploy, repeat the step; the rest of the world keeps "coming soon". Your number is on the electricity and fuel tester lists already (`VAS_LIVE_ELECTRICITY`, `VAS_ALLOWLIST_ELECTRICITY`, `WAPAY_WICODE_LIVE`, `VAS_ALLOWLIST_FUEL` are set in Vercel), so releasing the hold alone brings those two back for you.

## 6. Not in this change

The send flow (round 5: member transfer and held gifts on join, no voucher), the under-18
rule (none: anyone with a WhatsApp account may open an account; a nominal 16 and above,
not enforced), the Blu production credentials, the OTT voucher product decision. The
`SEND` row's copy still says a non-member gets a WaPay voucher, which is true until the
round-5 build.
