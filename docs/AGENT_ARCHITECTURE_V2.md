# The Pay agent: architecture v2 (the moat)

*Decision record and engineering reference, written 2026-09-16 from a 39-agent
review (6 read-only readers, 4 independent designers, 3 judges, 1 synthesis, 24
refuters, 1 completeness critic) run against commit `240526c`. The founder's
page with the diagrams is "Pay Agent Architecture"
(https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB). This file is the version a
Claude session builds from. It supersedes the phasing in
`docs/AGENT_ARCHITECTURE_RECON.md` §5.3 and amends `docs/HANDOVER_V1.4.md`
tasks 1 to 6 (section 10 below says how). Version 2.0.*

---

## 1. The decision

**Architecture or implementation?** The architecture on paper (recon §5) is
right and was never built. What runs is the pre-agent runtime: 29 deterministic
intercept points of which 27 answer with a template before any model sees the
message, and a two-tier classifier (`packages/ai/src/orchestrator.ts:50-54`
calls it "gpt-5.5 orchestrates, gpt-5.4-mini runs the category agents") whose
two models share only a free-text note and see no fact about the customer.
History records the customer's own words on 3 code paths against 59 for the
bot's. The fix is not a bigger orchestrator on top of the regex layer; it is one
composing model over a per-customer record and typed tools, the regex layer
deleted group by group, the money flows untouched.

**"A main Pay agent that talks to specialist agents."** Right about ownership,
wrong about inference. Each product owns its truth, tools and flow in one
module. But specialists are never separate model calls on the WhatsApp path:
every hop costs one to three seconds on a channel that cannot stream, a second
prompt to keep truthful (the withdrawal position was written in eight places),
and a second output to gate. Specialists are (1) tools the one brain calls,
(2) knowledge modules attached only when live and in focus, (3) workers off the
request path that message the customer back. The founder's picture survives as
the brain's tool list.

**What the moat is.** Not the model and not the number of agents. The
per-customer record under one WhatsApp identity, read on every turn (every
deposit, send, purchase, pay-out and pay link across every product), plus a
policy-gated registry that any partner product plugs into as a module. Plumbing
first, brain second.

## 2. What runs today (verified at `240526c`)

| Fact | Where |
|---|---|
| 29 intercept points before the model; 27 answer without it | `message-processor-v2.js:887-2017` (`processMessage`, `handlePostOnboarding`, `detectExplicitIntent` with 38 regexes) |
| The model receives 4 profile facts + 5 history lines (one is the current message again) + ~10k chars of product truth in four wordings | `:5559-5575`, `lib/user-profile.js:113-124`, `lib/spend-catalogue.js:236` |
| Nothing from the ledger reaches the model; it can trigger two point lookups it never sees (balance; latest deposit or pay-out status) and there is no transactions, statement or history read anywhere | `orchestrator.ts:64-80`, `:740` (home card prints Transactions, no handler) |
| History: 3 user-side writes vs 59 assistant-side; the current message is written before the 5-line read; the ring is a non-atomic rewrite of the whole JSON column | `:2420, :2427, :5544`, `user-manager.js:264-296` |
| "Deterministic" replies are gpt-4o-mini translation calls for non-English customers (227 sites, 2.5 s abort, fails to English) | `lib/localize.js:64-118` |
| Product truth hand-written in 9 surfaces; the withdrawal position in 8 places; the AI read the global switch while home read the per-customer pilot list | see BUGLOG #57 |
| Three execute routes public and mis-ordered; 6 of 9 PIN states lenient; balance readers pick `wallets[0]` | BUGLOG #56, #58, #59 |
| Delivery is at-most-once with silent loss: claim before process, never released, every error ACKed 200 | `whatsapp.js:161, :351-356` (BUGLOG #60) |
| 27 of 63 test files read the processor as source text (143 literal assertions); the processor exports one symbol | relocation breaks locks; exporting in place does not |

## 3. Target components

Layer, kind (LLM / deterministic / data / policy / channel / worker), what it
does, what it maps to today.

| # | Component | Kind | Responsibility | Today |
|---|---|---|---|---|
| C1 | Webhook edge | channel | HMAC, pulse, claim as in-flight, typing indicator, release the claim and answer 500 when a turn threw before sending anything (Meta redelivers) | `whatsapp.js` |
| C2 | Sender (`lib/say.js`) | channel | records the assistant side of every turn by construction, splits over 4,000 chars, checks the result; imported into the processor under the name `sendWhatsAppText` so 268 call sites and the source-text tests stay untouched | new |
| C3 | Turn runtime | deterministic | orders the turn: pack, guards, prompt, agent, tools, policy, dispatch, gates, send, persist; 20 s deadline with a fact-built fallback; the shadow gate `WAPAY_AGENT_V3_MSISDNS` at the top of `handlePostOnboarding` so shadow numbers skip the regex chain | replaces `handleAIChat` + the hook chain |
| C4 | Guard list | deterministic | the only pre-model answers, one exported ordered table: dedupe, receipt code, onboarding, language switch, shared contact, STOP/START, codes, 16-digit voucher PIN, PR codes, an open money state | `:916-957`, `:1213-1273` |
| C5 | State machine and money flows | deterministic | `handleConversationState` unchanged in contract: preview, confirm, PIN, idempotent execute; strict `\d{4,6}` in every PIN state | `:3349-5516` |
| C6 | Context pack (`lib/context-pack.js`) | data | ONE `Promise.all` batch over the source tables: wallets by type + active holds, provider requests (deposits, VAS, fuel, pay-outs), pay links, gifts sent and received, beneficiaries, the pending pay-out, the last 12 turns; rendered as `KNOWN CUSTOMER FACTS` | shape at `pages/api/admin/customer.js:41-95` |
| C7 | Capability registry (`lib/capabilities.js`) | policy | `capabilitiesFor({ waId, account })`: what is live for THIS customer, with label, one-liner, start command, fee line, limits, policy block, topic; renders home, help, fallback, welcome, product list and the prompt lines; scopes the model's tool list | new; replaces 9 hand-written surfaces |
| C8 | Prompt assembler | deterministic | stable cacheable prefix (persona, composition rules, money rules, registry one-liners, FEES) + per-turn tail (customer record, turns as real messages, the message once); a capability's full knowledge only when in focus | `orchestrator.ts:202-330` text reused |
| C9 | Pay agent | LLM | one call with strict function tools via a model adapter; outcomes: reply, clarify (a question plus a pending intent), tool calls, proposal; max 2 rounds and 3 tools; a proposal ends the loop; 8 s per call, 0 retries; composes in the customer's language; never sees a PIN turn | new `packages/ai/src/agent.ts` |
| C10 | Tool registry (`lib/agent/tools/*.js`) | deterministic | read tools: `get_transactions` (with server-side totals), `get_products`, `get_fee_quote`, `where_accepted`, `get_payout_status`, `get_pay_links`, `how_it_works`; proposal tools: `start_send`, `start_withdraw`, `start_buy_airtime/data/electricity`, `start_deposit`, `start_pay_link`, `start_fuel`, `start_voucher_load`, `propose_note`; plain JavaScript beside the helpers; a test asserts no tool imports a model client | new |
| C11 | Policy engine and output gates (`lib/policy.js`) | policy | `evaluatePolicy` → allow, deny, require (KYC tier, consent version, per-customer gate, limit); output gates: receipt shape, numeric provenance scoped to balances, statuses and totals, bearer digits, partner and betting lexicon, length | lifts `looksLikeReceipt :5531`, `redactBearerDigits :5518` |
| C12 | Proposal dispatcher | deterministic | re-validates slots exactly as `dispatchOrchestratorAction :5628-5641`; starts a flow at its FIRST step only; never sets a confirm or PIN state; never imports a ledger writer | `:5628-5880` |
| C13 | Preview and execute routes | deterministic | two-phase spend unchanged; internal auth, ownership before PIN, crash release on every route | `pages/api/vas/*` |
| C14 | Conversation store (`conversation_turns`) | data | append-only, both sides, event rows, redacted, dated, 30-day retention; `conversationData` keeps flow state only | replaces the 10-line ring |
| C15 | Movements read | data | the pack reads the source tables directly; NO separate events table keyed by ledger idemKey (see §11); later: additive per-account columns on journal lines so the read is indexed | `admin/customer.js` |
| C16 | Customer model | deterministic | habits computed in SQL (usual airtime number and amount, meter, deposit rail, cadence, people), customer-stated notes with provenance, "what do you know about me", "forget that", an erase script; no model-written memory in v1.4 | `lib/user-profile.js` kept |
| C17 | Turn ledger and audit (`agent_turns`) | data | one append-only row per turn with a JSON payload (prompt hash, tools, proposal, decision, gates, tokens, cost, outcome); AuditLog rows for proposals that reach a preview | new |
| C18 | Eval runner | deterministic | the golden corpus through the agent with pack and tools; action, shape, language, latency p50/p95 and cost; English plus two languages first; non-zero exit on regression | `scripts/eval-orchestrator.mjs` discards timings today |
| C19 | Mission Control cards | data | conversations (gates fired, deadlines, cost) and pay-outs (pending with held total, drift vs the rail's float) | after C17 |
| C20 | Jobs runner and `notifyCustomer` | worker | one `agent_jobs` table drained on a schedule: pay-out sweep, nightly balance integrity check, retention, future quote and credit workers; messages the customer back and writes into the turns | `reconcilePendingPayouts` has no scheduled caller today |
| C21 | Localizer | LLM | gpt-4o-mini for canned money strings only (confirm, PIN prompt, receipt), never on model-composed text; kept as a fallback for low-resource languages until their eval passes | `lib/localize.js` |

## 4. One turn in the target

1. Webhook: verify, pulse, claim in-flight (~20 ms). Typing indicator in the background (customer sees typing within ~0.5 s).
2. Context pack: one batch (40 to 80 ms). Record the user turn once, after the read.
3. Guard list: an answer here ends the turn with no model call.
4. Registry + prompt assembly (~2 ms).
5. Pay: model call 1 (target p50 ~1.2 s). Outcome: reply, clarify, tool calls, or proposal.
6. Tools in parallel with per-tool timeouts, then model call 2 (30 to 800 ms + ~1 s). Two rounds at most.
7. Proposal: re-validate, `evaluatePolicy`, call the flow starter at its first step; the flow's own preview mints the confirm state.
8. Output gates; a block is logged by rule id and replaced by a fact-built line.
9. Localizer for canned money strings only.
10. Send: one message by default; a one-line fact-built acknowledgement first only when a tool round ran (Meta bills in-window replies from 1 October 2026).
11. Turn ledger row; claim done; ACK. Watchdog at 20 s sends the fact-built fallback.

Targets, to be measured by C18, never quoted as measurements: guard turn under
1 s; reply-only p50 ~2.3 s; one tool round p50 ~3.5 s; proposal p50 ~3.2 s.

## 5. Memory

Three tiers the runtime owns; the model reads them and may propose one kind of
write (a customer-stated note, number-free, confirmed once).

- **Working**: `conversation_turns` (both sides, event rows for money outcomes
  with no message, redacted before storage, dated, 30-day retention, one DELETE
  for erasure) plus flow state in `conversationData` (30-minute idle expiry
  kept). The out-of-band senders (OTT pay-out webhook, reconcile route, ITN,
  card settlement) write through the same `say()` so the next turn's Pay knows
  what was already said.
- **Episodic**: read straight from the ledger, the holds and the provider,
  pay-link and gift tables in one batch per turn. There is no second copy to
  drift. A pending or failed pay-out appears with its rail status because it is
  read from the row the flow wrote.
- **Semantic**: habits computed in SQL from the same tables, notes the customer
  stated with provenance, language, KYC and pilot flags as today. No
  model-written memory in v1.4; a number-free summary is a later option that
  lands only with a change to the rule in `lib/user-profile.js` and `CLAUDE.md`.

All three render into one `CUSTOMER RECORD` block in the system prompt every
turn. Every balance, status or total the model states as fact must come from
that block or a tool result this turn (limits, fee examples and echoed amounts
pass); totals over many rows come from `get_transactions` server-side sums,
never model arithmetic.

## 6. The enterprise spine

- **Policy engine** between a proposal and a flow start: allow, deny, require
  (KYC tier, consent version, per-customer gate, limit). Regulated advice
  classes are never proposable; counsel-approved wording lives here.
- **Output gates**: receipt shape, scoped numeric provenance, bearer digits,
  partner and betting lexicon, length. A block degrades to a fact line, never
  to silence or "didn't catch that".
- **Audit**: one turn table with a JSON payload; AuditLog rows for proposals
  that reach a preview; message → proposal → preview → idemKey → ledger entry
  is one query. A nightly job re-derives every wallet balance from the journal
  (`deriveBalanceFromJournal`) and raises drift in Mission Control.
- **Delivery and degraded mode**: claim released on failure and a 500 so Meta
  redelivers a turn that sent nothing; outbound idempotent per message id; a
  per-customer budget of model calls per hour; when the model is down the
  guards and the record still answer balance, status, help and the open flow.
  Tool results and customer text are data in the prompt, never instructions.
- **Jobs**: one `agent_jobs` table drained every 10 minutes on Vercel Pro (or
  from UniFuel's runner with the shared internal key), with the daily VAS sync
  as the floor on Hobby: the pay-out sweep (PENDING and INIT rows), the
  integrity check, retention, future quote workers. `notifyCustomer` picks
  in-window text, direct send or a template and records the turn.
- **Evals**: the golden corpus through the agent with pack and tools, scoring
  action, shape, language, latency and cost; English plus two languages first;
  the harness rewritten from exact copy to shape-and-fact assertions;
  promotion per language gated on both; "model-agnostic" claimed only after a
  second provider has run the corpus.

## 7. Adding a financial product (the extensibility contract)

A product is one module and nothing in the agent, the prompt or the processor
changes: a descriptor in the registry (id, label, one-liner, start command,
`liveFor`, limits, fee line, policy block), its tools (read tools and one
proposal tool with strict schemas), its flow (pure steps in the
`lib/payout-chat.js` shape), its knowledge (brief and walkthrough, attached
only when live and in focus), and the table its flow writes, registered as a
pack source. Counsel first for three of them: recommending "the best insurance"
is FAIS intermediary activity, a credit enquiry needs NCA-grade consent and
purpose, bank linking runs on an aggregator's terms with a sponsor bank. First
partner module: bank-account verification (least regulated, needed to verify
pay-out recipients, proves the contract).

**Sending money as easily as a text.** `start_send` resolves the recipient
from the record (a saved name, a shared contact card, a number) and the
registry picks the rail by who the recipient is: a WaPay customer gets a
balance transfer, anyone else a voucher today and a pay-out once cash-out is
open. The model names the person and the amount; it never chooses the rail.

## 8. Phases

Working days for one Claude session at a time; on a calendar with one founder
reviewing, six to eight weeks, the founder's number on the new brain in week
two or three.

- **Phase 0, safety and spine (days 1 to 4).** Internal auth, ownership before
  PIN and crash release on the three open execute routes; strict PIN shape in
  every PIN state; the INIT pay-out reconciler; `say()` recording both sides
  into `conversation_turns` (out-of-band senders included); the user turn
  recorded after the read; the context pack fed into the existing
  `orchestrate()` as `KNOWN CUSTOMER FACTS`; the per-customer withdrawal gate
  threaded into the knowledge and the prompt; claim release; typing indicator;
  template seeding off the customer's turn; the scheduler decision and the
  reconcile cron; a real Transactions list behind the home card; balance by
  wallet type. Founder sees: ledger-aware answers, one withdrawal truth,
  "typing", Transactions works, a parked pay-out reconciled without asking.
- **Phase 1, registry, movements, policy (days 5 to 8).** The registry with
  descriptors for the 11 existing capabilities, every surface rendering from
  it and the hand-written copies deleted, a test that no surface names an
  unregistered capability; the pack's movement list from the source tables;
  the nightly integrity check; the policy engine; habits in SQL; "what do you
  know about me" and "forget that".
- **Phase 2, the Pay agent behind the shadow list (days 9 to 16).** The agent
  loop with strict tools; the guard list; the tool registry with the no-model
  import test; output gates; flow starters exported in place (never moved);
  the shadow gate at the top of `handlePostOnboarding`; the turn ledger; the
  clarify outcome and `propose_note`; per-customer call budget and degraded
  mode; the eval runner; harness rewritten to shape-and-fact checks.
- **Phase 3, promote and delete (days 17 to 24).** Promote per language.
  Delete the pre-model regex groups in two batches with the eval as the gate
  (question hooks first, then intent hooks). Retire the two-tier classifier
  and the dead code (second WhatsApp client, the bypassing ledger writer
  `packages/domain/src/ledger.ts postBluDeposit`, `UserSavedAccount`). Rewrite
  the remaining source-text test locks as behaviour tests. Mission Control
  cards.
- **Phase 4, async tier and memory depth (weeks 5 to 6).** `agent_jobs`,
  `notifyCustomer`, fuel reconcile off the per-turn path, additive per-account
  journal columns, a second model provider through the corpus, the optional
  number-free summary behind a flag with the rule change, the first partner
  module. Voice notes and photos as a pre-agent channel step: deferred,
  explicitly not in v1.4.

## 9. Where this disagrees with the brief

- Specialists as separate model agents: no (section 1).
- A memory agent: memory is a query and a read model, not a model.
- Streaming like ChatGPT: impossible on the Cloud API (whole messages, no
  edit). Typing indicator, one composed message in two to four seconds, a
  fact-built first bubble only when a tool round runs.
- "Empowered by all sources of information": a curated, redacted record and
  read tools, never raw access; confirm, PIN and receipt copy stay templates.
- "Gets to know me over time" does not mean the model remembers freely.
- "Super robust and enterprise" means fewer moving parts with an audit trail,
  evals and gates. The processor gets smaller.
- Insurance, credit and bank linking are counsel-first.
- "Like ChatGPT" should not mean open-ended chat inside a money product; the
  persona stays on the customer's money and the life around it.
- The calendar: about 24 working days, six to eight calendar weeks.

## 10. Mapping onto HANDOVER_V1.4 tasks

| Task | Disposition | Change |
|---|---|---|
| 1 Context pack | change | keep the one-round-trip pack and feed the existing model call first; the movement list is the per-turn batch over the source tables (a projection keyed by ledger idemKey cannot represent holds or pending pay-outs); status and "what did I buy" become agent compositions, the deterministic list stays for the home-card tap and as the fallback |
| 2 Registry | keep | plus: scopes the tool list; policy block per descriptor; knowledge attached only in focus |
| 3 Composition policy | change | keep the day-one fixes as a bridge; enforcement moves into the prompt plus a shape check; harness assertions become shape-and-fact; bridge deleted in Phase 3 |
| 4 Agent loop | change | tools as plain JS beside the helpers; `get_context` dropped (pack always prefetched); two rounds and three tools; HOW IT WORKS leaves the every-turn prompt; shadow gate at the top; fallback composed from the pack |
| 5 Pay-out operations | keep | scheduler decided in Phase 0; INIT reconciler added |
| 6 Memory hygiene | change | append-only turns table instead of atomic merges of a ring; `say()` wrapper; redaction of bank account and ID numbers typed in the withdraw flow |
| order | change | safety first (execute routes, PIN states, claim release) |
| not in the handover | add | numeric provenance, policy engine, turn ledger, claim release, typing indicator, jobs table, erase script, clarify outcome, propose_note, degraded mode, call budget |
| not in the handover | drop | model-written summary on the hot path, model specialists, MCP in-process, streaming, multi-message by default |

## 11. What the adversarial pass corrected

Twelve claims, two refuters each (code lens; operations and regulatory lens).
Seven stood. Four were corrected in wording. One was refuted and changed the
design.

- **Refuted: a `customer_events` read model keyed by ledger idemKey.** An
  idemKey is per journal entry, not per customer (one send touches two
  wallets), and holds, pending and failed pay-outs never reach the journal at
  all, so that table could not have shown the founder's parked PayShap. The
  pack reads the source tables directly (C15).
- **Corrected: "no read path to the ledger".** The model can trigger two
  point lookups it never sees; there is no list, statement or history read.
- **Corrected: test lock-in.** 27 files read the processor as text; relocating
  flow starters breaks them, exporting in place breaks nothing. So: export,
  never move, until Phase 3.
- **Corrected: the money boundary wording.** The dispatcher may only start a
  flow at its first step, never sets a confirm or PIN state, never imports a
  ledger writer. `PAYOUT_PIN` and `PAYREQ_PIN` are gated by flow-owned state
  (an intent id, a request code), not a preview id. Delete the dead
  non-idempotent `postBluDeposit`.
- **Corrected: latency and cost.** Every latency is a target; the "~1 s per
  call" figure was an unlogged impression. Prompt volume drops by about a
  third on two-call turns and rises on today's fast-path turns; the saving is
  the uncached tier-1 call and the context sent twice.

The completeness critic added: the clarify outcome, the conditional two-bubble
rule, server-side totals, the note-extraction path, degraded mode and the call
budget, the moat statement, the send rail rule, the narrower provenance guard,
fewer persistence surfaces (one turn table; AuditLog only for proposals that
reach a preview), voice and image explicitly deferred, and the calendar.

## 12. Invariants preserved (never weaken)

Everything in `CLAUDE.md` money-safety 1 to 10 and `docs/AGENT_ARCHITECTURE_RECON.md`
§5.4: integer cents; ledger-only writes through `postEntry`; two-phase holds;
deterministic idemKeys; the AI proposes and never executes; the AI never states
a balance or status from its own head (now enforced mechanically by the
provenance gate over the record); bearer secrets never in history; PIN-shaped
input only reaches `verifyPIN`; quotes binding; no betting words on WhatsApp;
the pay-out partner never named while withdrawals are off; no em dashes and no
date promises in customer copy.

## 13. Shipped against this document

See `docs/CHANGELOG.md` and BUGLOG #56 onward for each landing. The section
below is updated on every ship.

- 2026-09-16, Phase 0 shipped (changelog entry 35, BUGLOG #56 to #62): C1
  (typing indicator, claim release), C2 (`lib/say.js`), C5 (strict PIN states),
  C6 (`lib/context-pack.js`, fed into the existing two-tier engine as the
  KNOWN CUSTOMER FACTS block), C7 (`lib/capabilities.js`, built and tested;
  home and help wiring is Phase 1), C11 (`lib/policy.js` wired before a
  proposed flow and before a withdrawal; output gate: provenance-aware receipt
  guard), C13 (execute routes hardened), C14 (`conversation_turns`, both
  sides, retention in the daily cron), C20 partly (`sweepPayoutsAndNotify`,
  the cron route, the daily floor, the on-inbound reconcile; the jobs table
  itself is Phase 4), the Transactions handler and status disambiguation (the
  Phase 0 bridge for Task 1). Not yet: C3, C8, C9, C10, C17, C18 (Phase 2),
  registry rendering of home/help/welcome (Phase 1), C15 index columns and C16
  habits (Phase 1), a Vercel schedule for the 10-minute sweep (needs the plan
  decision, section 14). The pre-ship adversarial review (five lenses, 42
  findings, 31 confirmed and fixed; BUGLOG #63, #64 and the changelog entry)
  added two rules to keep: GetPaymentStatus request errors never release a
  hold, and the receipt guard's provenance is settled money only.
- 2026-09-16, Phase 1 shipped (changelog entry 36): C7 wired into home, help,
  the fallback, the product list and the AI knowledge (one fuel gate); C16
  habits in the record plus "what do you know about me" and "forget me"; the
  nightly integrity check of C17; C14 cascade. Phase 2 modules built and
  tested, dormant until the shadow gate lands: C9/C8 (`packages/ai/src/agent.ts`,
  `prompt.ts`), C10 (`lib/agent/tools`), C4 guards and C11 output gate
  (`lib/agent/guards.js`), C17 (`lib/agent/turn-ledger.js`, `agent_turns`),
  C18 (`scripts/eval-agent.mjs`).

## 14. Open questions for the founder

1. Vercel plan (Hobby or Pro): decides whether the 10-minute reconcile cron is
   a `vercel.json` entry or a UniFuel-runner trigger. The daily floor and the
   on-inbound reconcile are in place either way.
2. Counsel and Didit before cash-out opens beyond the allowlist (unchanged).
3. Which partner product is first (recommendation: bank-account verification).
