# WaPay conversational agent: recon and the architecture shift

*Written 2026-09-13 after the founder's live-chat review. Six read-only readers mapped the stack (orchestrator, routing, memory, catalogue, fees, QA locks); every high-severity claim below was put to two independent refuters, and the ones that survived are marked verified. Line numbers refer to the tree at commit `c32a8ac`; the Phase 0 fixes landed in `0d5e477`.*

## 1. What the founder saw, and why

| Reply on the phone | Which path wrote it | Root cause (verified) | State |
|---|---|---|---|
| "Not yet, but cash-out is coming soon through our payouts partner…" (with `WAPAY_PAYOUT_ENABLED=true` since 2026-09-11) | The AI's MONEY or CHAT specialist | `buildBrainKnowledge()` pushed an ungated "withdrawals are not available YET but are COMING SOON" paragraph into every tier-2 prompt, labelled authoritative and placed after the flag-aware line in PRODUCT_TRUTH; the MONEY and SEND specialist prompts hard-coded "spend-only, no cash-out"; `spendDestinationLines()` had no withdraw line; `cashoutScript()`, the one function written to flip, had no caller; PRODUCT_TRUTH was a module-level constant read once at import. Tests pinned the coming-soon text and never ran the knowledge block with the flag on. | Fixed (BUGLOG #43) |
| "I can't quote a cash-out fee yet because withdrawals are not live, and I don't want to guess." | The AI | The same contradiction plus MONEY_TRUTH_RULES ("NEVER include a number you were not given") with no fee number anywhere in the prompt. No such sentence exists in the code; it is the model's honest reading of a broken prompt. | Fixed (#43, #44) |
| "Cash deposits use a Blu voucher… the till may charge its own fee, so I can't quote that part." | The AI paraphrasing PRODUCT_TRUTH | No fee in the prompt. The Blu load keeps 6% (R100 credits R94) and was disclosed only in the success message. | Fixed (#44): the bot now says "the voucher network keeps 6%, so a R100 voucher adds R94" up front |
| "WaPay VAS Products: Mobile Airtime, Data Bundles, Prepaid Electricity" for "What can I buy with this?" | Deterministic `LIST_VAS_PRODUCTS` | `handleListVasProducts` rendered a static three-key map over a table whose rows are all Blu. It never read `lib/spend-catalogue.js`. Fuel could never appear there even when live. | Fixed (#45): opens with the catalogue-built list (vouchers, send, get paid, withdraw when live, fuel when live) |
| "Add Money to WaPay" menu for "How much does it cost to deposit money on here?" | Deterministic keyword trap | `detectExplicitIntent` classified any "deposit money / add money / load money" sentence as `REDEEM_VOUCHER` at confidence 1.0 and parked the customer in `AWAITING_VOUCHER_PIN`. The deposit fee (4.2% + R2.30, rounded up) was only ever stated after a checkout intent was minted. | Fixed (#44): `lib/fee-facts.js` answers price questions before the router, from the charging functions |

The same review found the bot writes "📄 Transactions" on the home screen with no handler behind it, and that a customer cannot ask a single question about their own past activity (section 3).

## 2. How the stack works today

**Routing.** `processMessage` runs an ordered chain of about twenty-six deterministic hooks before the model is consulted: receipt codes, language switch, onboarding gate, shared contacts, fuel reconciliation, pending gift claims, the conversation-state machine, home triggers, admin and business login, STOP/START, business sign-up, the fee hook and withdraw matcher (new today), slot parsing, card deposit, voucher history, pay-request codes, request money, OTT self-purchase, fuel, deposit status, active-category follow-ups, then `detectExplicitIntent` (a regex table: balance, help, deposit keywords, 16-digit PIN, "what can I buy", product queries, data and airtime patterns). Only the fall-through, `AI_CHAT`, reaches the model. This is why the bot feels menu-driven: most question-shaped messages are caught by a regex and answered with a template before the conversational layer exists.

**The AI.** One file, `packages/ai/src/orchestrator.ts`. Tier 1 (`gpt-5.5` by default) classifies language, domain and an optional fast action; tier 2 (`gpt-5.4-mini`) extracts slots and composes the reply. Both use strict JSON schemas, a 10-second timeout and no retries. Tier 2's system prompt is persona + language hints + PRODUCT_TRUTH + the per-request knowledge block + money rules + a per-domain action list. The model returns one of fifteen actions; `dispatchOrchestratorAction` re-validates every slot and hands off to the same PIN-gated deterministic flows the regex router uses. The model never moves money. That boundary is right and must survive any redesign.

**Context per turn.** A "KNOWN USER PROFILE" block (preferred language, deposit method, last meter, interests) and the last five history lines. Nothing about balance, transactions, open links, vouchers, withdrawals or KYC status reaches the model.

**A third model stage.** `lib/localize.js` translates every canned English string into the profile's majority-vote language with `gpt-4o-mini` (2.5-second timeout, fails open to English). Composed replies follow the current message's language; canned replies follow the historical majority, which is why a conversation can flip languages mid-flow.

**Latency.** One model call on the tier-1 fast path, two typically, up to five serial calls on a non-English request-money turn; worst case near 27 seconds inside Meta's webhook budget.

**Product truth was hand-written in six places** and only two followed the switches: PRODUCT_TRUTH in the prompt, the home screen's Buy line, the Help Menu, the no-OpenAI fallback, the onboarding welcome, and the VAS product list. Every capability launch required finding and editing all of them; every miss produced a customer-visible lie. Today's fixes make the cash-out position, fees and the product list read the gates; Phase 1 finishes the job with a registry.

## 3. Memory: what is stored and what the bot can use

Stored: a ten-message history ring inside `Account.conversationData` (no retention, no separate table), `Account.profile`, saved recipients, vouchers (`PendingGift`), deposits, VAS and payouts (`ProviderRequest`), pay links (`PaymentRequest`), and the full ledger (`JournalEntry`/`JournalLine`).

Used by the model: the profile block and five history lines. Verified defects:

- Only AI-routed turns record the customer's own words (one call site); every deterministic flow stores the bot's reply alone, so the model can see five bot monologues and no questions.
- The current message is written to history before history is read, so it appears twice in the prompt and effective recall is four turns.
- Electricity STS tokens are stored verbatim in history and re-sent to OpenAI on later turns; the redaction helper only covers the user turn and would not match the space-grouped token.
- Every `conversationData` write is a non-atomic read-modify-write, the same race that was fixed for `profile` with an atomic jsonb merge on 2026-08-28.
- No ledger or transaction read exists anywhere in the message processor. `listPayouts` is wired only to the business portal, `listRecentBeneficiaries` has no callers, `UserSavedAccount` and the whole `@wapay/nlp` package are dead code. "What did I buy last week", "send the same bundle again", "how much have I deposited this month", "who paid my link", "did my withdrawal go through" cannot be answered, and the home screen advertises Transactions anyway.
- The one memory-derived shortcut, "Buy airtime for <number>", is mis-parsed by the slot parser as a rand amount and dead-ends.

So the answer to "are we storing memories of customers' past transactions and using them as a tool" is: the data is all there, none of it reaches the conversation.

## 4. Why fuel, wiCodes and Yoyo do not come up

The gate is correct and deliberate: FUEL is bound to `WAPAY_WICODE_LIVE` plus the per-user `VAS_ALLOWLIST_FUEL`, and until Yoyo issues production credentials to UniFuel every customer must see "coming soon", because test wiCodes do not redeem at pumps. Yoyo is never named to customers by design (the brand is "UniFuel fuel voucher").

What was wrong is that fuel could not appear even when live: the product list had no FUEL key, PRODUCT_TRUTH never mentions fuel, and the Help Menu, fallback and welcome are static. The knowledge block does describe fuel correctly when live. Three defence gaps remain for Phase 1: the fuel preview and execute API routes carry no capability gate (only the chat handler does), the FUEL_CONFIRM and FUEL_PIN states never re-check the gate, and UniFuel's own `testMode` signal is shown to staff but not wired to the customer gate.

## 5. The architectural shift

### 5.1 On "MCP servers for every API"

MCP is a protocol between an agent client and tool servers across a process or network boundary. Our agent runs inside our own webhook function; there is no third-party client, and a WhatsApp turn has a ten-second budget. Putting MCP servers between our code and our own agent adds a hop, latency, an auth surface and operating cost for no benefit today.

What the Neon talk gets right, and what applies to WaPay, is the shape underneath: define tools centrally as a package with raw reads plus ergonomic workflow operations, categorised so the runtime can scope what an agent sees, and let the runtime discover and execute. Progressive discovery and code mode are client features for coding agents with hundreds of tools; we will have about twenty, all loaded. So: build `@wapay/tools` as an in-process TypeScript package, and expose the same package over MCP later for ops tooling (Claude Code, Mission Control) if that becomes useful. Same tools, no second implementation.

### 5.2 Target: "Pay" as a tool-using agent behind a hard money boundary

- **One agent loop per turn**, model-agnostic (the model ids are already env-tunable). System prompt = persona + policy + a **capability registry rendered from the gates** (`capabilities(waId)` returns what is live for this customer: VAS categories, fuel, withdrawals, card rails, business) + the FEES block from `lib/fee-facts.js`.
- **A context pack prefetched in one database round trip**: balance, the last five transactions summarised, open pay links, a pending withdrawal, KYC status, saved recipients, preferred language, and the last ten turns of history with both sides and bearer values redacted. Most turns then need zero tool calls.
- **Read tools** for anything deeper: `get_transactions(range)`, `get_fee_quote(kind, amount)`, `get_products(category, query)`, `get_vouchers`, `get_pay_links`, `get_payout_status`, `where_accepted(network)`.
- **Proposal tools**, never execution: `start_buy_airtime`, `start_buy_data`, `start_electricity`, `start_send`, `start_pay_link`, `start_deposit`, `start_withdraw`, `start_fuel`. Each returns a proposal the runtime turns into the existing confirm, PIN and idempotent execute flow. Slots are re-validated exactly as `dispatchOrchestratorAction` does now.
- **Budget**: at most three tool calls per turn, one model round-trip typical, the existing fail-closed canned reply on timeout.
- **Style**: the model composes answers from facts and never dumps a menu unless asked; confirmations, receipts and PIN prompts stay deterministic and localized.
- **Memory**: the context pack and `get_transactions` are the transaction memory; per-customer facts keep being written at success points; receipts are redacted before storage; a thirty-day retention job; atomic jsonb writes.

### 5.3 Phased plan

**Phase 0, done today.** Fees the bot can quote; cash-out truth follows the switch everywhere; catalogue-built "what can I buy"; the withdraw matcher accepts "cash-out" and "take my money out"; the AI fallback keeps the customer's words; chat QA scenarios for the exact founder exchange. 607 unit tests and 15 of 15 harness scenarios green; deployed as `0d5e477`. The harness run also settles a doubt raised by the readers: the configured model ids (`gpt-5.5`, `gpt-5.4-mini`) are accepted by the provider today, since every AI turn in the run returned a tier-1 or tier-2 result.

**Phase 1, about a week.** `lib/capabilities.js` as the single registry feeding PRODUCT_TRUTH, the home menu, the Help Menu, the fallback and the onboarding welcome. The context pack (balance, last five transactions, open links, KYC) in every AI turn. Both sides of every turn stored, receipts redacted, atomic writes, retention. Deterministic answers for "my transactions", "my withdrawals", "my links" and "who paid my link" from the helpers that already exist. Fuel API route gates and state re-checks; electricity advertised per allowlist. Two more from the completeness pass: the in-chat pay-link quote and the pay page still compute the fee on the PayFast rail while checkout and the FEES block follow the live rail (make every quote call `paymentRequestFeeCents(amount, primaryCardRail())`), and the agent's `category` enum lacks FUEL, so `LIST_CATEGORY` can never browse fuel even when it is live. Rewrite the test locks that block the redesign as behaviour tests: the `JSON.parse` rule, the 150-call localization floor, the per-action switch-case regexes, and the PayShap ban re-scoped to "while withdrawals are off".

**Phase 2, two to three weeks.** `@wapay/tools` and the agent loop behind a shadow list (`WAPAY_AGENT_V3_MSISDNS`), old and new run side by side on the 132-case golden corpus (extended with withdraw, fee and discovery cases in all eleven languages) and the chat QA harness; measure action accuracy, latency and cost; promote per language.

**Phase 3.** Retire the regex intent table and the category agents; deterministic flows remain only for money execution; optional MCP surface for operations.

### 5.4 What must be preserved

The money execution contract, which lives in the API routes and not in the chat layer (reserveHold, provider call, settleHold or releaseHold, idempotency keys derived from the preview id, PIN verified server-side for airtime and data); model output treated as untrusted input and re-validated deterministically, with the meter-number slot never entering flow state; the two anti-fraud guards on model-composed text (`looksLikeReceipt` blocks fake proof-of-payment, `redactBearerDigits` keeps bearer codes out of history and logs); localization of every money-journey string, with the one deliberate exception that bearer voucher claim messages are never translated; Meta policy (no betting vocabulary on the WABA, ever); the payout partner never named while withdrawals are off; no cash-out claims in the portal, admin and KYC copy locked by tests; no em dashes and no date promises in customer copy; the 24-hour-window template rules for outbound pushes.

## 6. Yoyo and the wiCode economics

Yoyo's written terms: 2.5% on every voucher issued, R0.20 per SMS, a R15,000 monthly retainer from the month production starts, float prepaid, no rebate except possibly KFC, and no pre-launch window. The fee benchmark (v1.2) models it: at a 5% convenience fee on a R500 voucher WaPay keeps R12.30 before the retainer and needs about 1,220 such vouchers a month (R610,000 issued) to break even; the customer pays R25 to spend R500 at a till that would take their card for nothing, and cashing out by PayShap (R8) is cheaper above R160. Recommendation in the founder reply of 2026-09-13.

## 7. Open after today

OTT must enable providers and load a float on the test account; counsel sign-off on cash-out before live credentials; Didit keys or KYC back on before live; rotate the OTT key that was pasted in chat; the Meta utility template for business requests; SHB's written confirmation on third-party processing before `WAPAY_ADUMO_ENABLED`.
