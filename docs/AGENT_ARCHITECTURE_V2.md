# The Pay agent: architecture v2 (the moat)

**Version 1.8 · 2026-09-18 · build f91e317** (the version table is section 15; the visual map is docs/architecture/pay-agent-architecture.html, published at https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB)

## How this document is used

This file is the architecture of record for the WaPay chat. It says what we build towards. The code says what has shipped. When they differ, the code is behind, not the document.

Every ship that changes what is true here updates section 13 and the visual map in the same commit. The map is `docs/architecture/pay-agent-architecture.html`, assembled from the sources beside it with `node docs/architecture/assemble.js` and republished to https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB so the link never changes. This record is the territory. The page is the map.

Nobody diverges from the target silently. A session that finds the target wrong, or cannot build it as written, adds a section 11 entry in its form: claim, verdict (stands, corrected, refuted), evidence. The target changes only through such an entry.

The version line sits at the top of this file and in the map's status heading:

`Version <major>.<ship> · <date> · build <sha>`

The major number changes when the target (sections 1 to 12) changes. The ship number changes with every section 13 entry. History: the version table below.

## Where we are (2026-09-18 evening)

**Phase 2 is deployed behind the pilot list and Phase 3 has not started.** Latest code build `f91e317`.

**The promotion gate: one condition met, one not started.** The eval half is
met (156 cases, all eleven languages, 100% on action against the two-tier
engine's 100% on the shared 132). The week of real agent turns has **not begun**:
as of this build `agent_turns` holds zero rows. The list carries the founder's
number and that number is correct, but until 2026-09-18 the gate matched the
list entry as raw text, so three of the four ways a human writes the number
would have matched nobody while the old engine answered normally
(BUGLOG #73). The clock starts on the first message he sends from it, and the
Mission Control card now reports whole clean days against the seven needed.

Complete for every customer (Phases 0 and 1): the customer record and the last 12 turns, both sides, in every model turn; execute routes closed; strict PIN states; claim release, typing indicator; INIT pay-out reconcile; registry-rendered surfaces; habits, "what do you know about me" and "forget me"; nightly balance integrity; policy engine before proposals and withdrawals.

For the shadow list `WAPAY_AGENT_V3_MSISDNS` only (Phase 2): one model call over the record and typed tools; pre-model guards; per-customer budget; proposals through the same confirm and PIN steps; output gates, provenance guard; clarify state; an `agent_turns` row per turn. First live eval: 11 of 12, p50 1.9 s, p95 3.7 s. Everyone else: regex hooks and the two-tier engine.

Phase 3 gate (section 13, verbatim): the eval on the full set per language at or above the two-tier engine's pass rate, and a week of shadow turns with no gate firing on money copy.

Incident: the bot was mute from the Phase 0 deploy (2026-09-16) to hotfix `398475f` (2026-09-17) because the webhook used `runWithSendScope` without importing it (BUGLOG #67). Rule: a webhook change ships only with the route runtime test green, and the first production message is watched in `processed_messages` before the deploy is called done.


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

### Added 2026-09-18 (session after `c1821e0`)

- **Corrected: C11's "configure a real requirement".** The design row and the
  handover both say the policy engine should be given a real requirement, a
  consent for cross-user actions being the obvious first. **Verdict: amend the
  row, do not configure it.** Evidence. (1) A `TERMS_AND_CONDITIONS`
  requirement would be a tautology: `message-processor-v2.js` refuses every
  capability until `onboardingState === 'S5_COMPLETED'`, and that state is only
  reachable through the two `recordConsent` calls in
  `packages/auth/src/onboarding.ts` `handleS4PinSet`, so every customer who can
  reach a capability already holds the consent. It could never add a block,
  only produce false negatives. (2) It would not address the risk the memory
  rule `cross-user-actions-need-consent-gate` is about: the 2026-08-25 phishing
  vector was A reaching an arbitrary stranger B, and the control for that is the
  relationship gate plus informational-only delivery, both already shipped. A
  checkbox on A's own account changes nothing about whether A may reach B, so
  configuring one would LOOK like satisfying the rule while leaving the vector
  untouched, which is worse than an honest amber row. (3) The blast radius is
  every customer: `account.consents` is never loaded on the inbound path
  (`getOrCreateUser` selects only `wallets`), and `evaluatePolicy` fails closed,
  so one descriptor line would tell every customer to accept terms they cannot
  accept in chat. **The engine stays a gate with nothing yet to gate, on
  purpose. It becomes real when the first requirement that can actually refuse
  something arrives; the candidate named in section 7 is the partner module
  (bank-account verification), whose KYC tier is a requirement the flow does
  not already own.**
- **Corrected: the consent model has no `revokedAt`.** `lib/policy.js`
  `isUnrevoked` reads `c.revokedAt`, which does not exist on the Prisma
  `Consent` model, so against production data the branch is dead and only the
  hand-built test fixtures exercise it. A revoked consent cannot be represented
  today. Not fixed here: it needs a schema decision, and nothing depends on it
  while no requirement is configured. Recorded so the first requirement does
  not inherit it silently.
- **Corrected: the legacy conversation ring was 63 call sites, not "about
  twenty"** (`docs/HANDOVER_V1.5.md`). All 63 were in the processor and there
  were no readers anywhere. Deleted 2026-09-18 with both helpers.

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
- 2026-09-16, Phase 2 wired (changelog entry 37): the shadow gate
  `WAPAY_AGENT_V3_MSISDNS` in the processor, `handleAgentTurn` (C4 guards,
  the per-customer budget from C17, C6 record, C7 registry lines, C9 loop, C10
  tools, C11 output gate and provenance guard, C17 ledger row on every path),
  the `AGENT_CLARIFY` state, the `WITHDRAW` dispatch case into the existing
  withdraw flow. First live eval: 11 of 12 on the English golden subset, p50
  1.9 s, p95 3.7 s. The pre-ship review (BUGLOG #65, #66) added three rules
  to keep: the model sees the customer's line in its memory form (redacted),
  never raw; a refused or guarded turn never counts toward the model budget;
  a failed send throws so the claim is released. Not yet: promotion beyond
  the shadow list (Phase 3 gate:
  the eval on the full set per language at or above the two-tier engine's
  pass rate, and a week of shadow turns with no gate firing on money copy),
  the regex-hook deletions, the classifier retirement, Mission Control cards
  (C19), `agent_jobs` and `notifyCustomer` (Phase 4).

- 2026-09-17, hotfix `398475f` (changelog 38, BUGLOG #67): the webhook used
  `runWithSendScope` without importing it since `3915d81`, so nothing in
  Phases 0 to 2 had answered a customer before this build; the route is now
  loaded and run by a test. `4b3f478` (changelog 39, BUGLOG #68): the withdraw
  flow names a method the balance cannot cover and never states an
  unreachable ceiling. `9bc355e` (changelog 40, BUGLOG #69): fuel and
  voucher execute routes prove ownership before the PIN, the voucher crash
  guard is disarmed once OTT has issued, the output gate runs for every
  customer's model reply, the on-inbound reconcile covers INIT.
- 2026-09-17, verification pass (four read-only verifiers, file and line
  evidence at HEAD; the table drives the phase map). Backlog they opened,
  kept here as the Phase 3 and 4 list: C4 is three code guards, not the
  design's ordered table of ten; C8 loads no focus knowledge yet; C9 has no
  per-tool timeout; C10's propose_note writes without the confirm turn; C12's
  WITHDRAW case is shadow-only; C14 writes no event rows for money outcomes
  without a message; C16 habits are computed in JavaScript over the last 40
  rows, not SQL; C18 evaluates English only and does not fail the build; C19
  has neither card; C20 has no 10-minute schedule and only five rows per daily
  sweep; C21 (notifyCustomer) is unbuilt, so a pay-out that finalises outside
  the 24-hour window is told by a template; the localizer has no per-language
  eval; no partner module exists; the shadow gate sits after the reconcile,
  gift-claim, state and business hooks rather than at the very top; the
  policy engine has nothing configured that can return anything but allow.

- 2026-09-18, the streamlining review and the eval gate (changelog 41 and 42,
  BUGLOG #70 and #71). The founder's principle is now composition policy in
  both prompts: if you already know the answer, offer it rather than asking the
  customer to find it; best matching product at the lowest rate, in the shape
  they asked for, with the fee stated in the same breath; recommending is not
  doing. The withdraw flow offers at every refusal instead of listing menu
  numbers. **The eval half of the Phase 3 gate is met:** 156 cases across all
  eleven languages, 99.4% overall and 100% on action and outcome, against the
  two-tier engine's 100% on the shared 132, so the agent matches the engine it
  replaces in every language (`docs/testing/agent-eval-2026-09-18.md`). The
  remaining half is a week of shadow turns with no money gate firing, now
  visible on the Mission Control conversations card (C19, shipped).

- 2026-09-18, the async tier and the handover (changelog 43 to 46, BUGLOG #72).
  C21 `notifyCustomer` picks the rail that crosses the 24 hour window; C18 has
  a frozen baseline the runner fails against; C19's pay-out half reports what
  the parked rows hold; C13's internal-auth gate fails closed in production;
  C14 gains its first event-row producer; C20's `agent_jobs` table and drain
  land early from Phase 4, with the recorded decision that the fuel reconcile
  stays on the customer's turn until a ten-minute drain exists.

- 2026-09-18 evening, the session after `c1821e0` (changelog 47 to 52,
  BUGLOG #73 to #75). **The pilot week had not started and could not have been
  seen to fail.** The first read of `GET /api/admin/conversations?days=7`
  returned 19 customer messages, 20 replies, the list live with one number, and
  zero agent turns; `agent_turns` had never received a row. The gate compared
  the list entry to Meta's wa_id as raw text, so three of the four ways a human
  writes a South African number matched nobody, silently, while the old engine
  went on answering. The list moves to `lib/shadow-list.js` and matches on
  canonical digits; the Mission Control card now reports each entry by its last
  four digits with whether it is readable and whether an account has written
  from it, beside whole clean days against the seven the gate needs, the clock
  reset by the newest money gate. The number on the list was in fact correct,
  so nothing had been lost yet; the failure mode was.
  - **C16.** `propose_note` no longer writes. It is pure, returns a pending
    note, and the runtime asks the customer and writes through the new
    deterministic `addNote` on an explicit yes. The model is no longer the
    author of any customer fact.
  - **C14.** The legacy JSON ring is deleted: 63 write sites in the processor,
    no readers, each one a read-modify-write of a column that also holds live
    flow state. Migration `20260918_drop_conversation_ring` clears the residue
    and the erasure path clears it per account (BUGLOG #74: "forget me" had
    never touched it). Event rows now cover every way the pay-out sweep can
    fail to tell a customer, and the PayFast ITN's deposit confirmation.
    BUGLOG #75: a gift claimed but never sent is put back on any failure, not
    only on a send that answers not-ok.
  - **Phase 3 prep.** The three dead things are deleted (the second WhatsApp
    client, `postBluDeposit`, `UserSavedAccount`). Thirteen functions are
    exported from the processor IN PLACE and the first batch of source-text
    locks is rewritten as behaviour: source surgery falls from 19 sites to 6,
    and two tests that had been asserting against drifted fakes are now
    asserting against the real code.
  - **C11.** Amended rather than configured; see the section 11 entry.
  - **C19.** The conversations card shows what the parked pay-outs hold against
    the rail's float, fetched separately so a slow supplier cannot take the
    card down.
  - Not done, deliberately: C16's habits in SQL. The JavaScript version can
    only UNDER-count over a 40-row window, the eval that gates Phase 3 renders
    no habits at all, and two test stubs would silently warn on a ninth query.
    It is an optimisation with a real chance of a quiet regression and it waits.

## 14. Open questions for the founder

1. Vercel plan (Hobby or Pro): decides whether the 10-minute reconcile cron is
   a `vercel.json` entry or a UniFuel-runner trigger. The daily floor and the
   on-inbound reconcile are in place either way.
2. Counsel and Didit before cash-out opens beyond the allowlist (unchanged).
3. Which partner product is first (recommendation: bank-account verification).

## 15. Version history

| Version | Date | Build | What changed |
|---|---|---|---|
| 1.0 | 2026-09-16 morning | none; review run against `240526c` | The decision: one composing model over the per-customer record and typed tools; specialists as tools, knowledge modules and off-path workers; the money flows untouched. Sections 1 to 12 written from the 39-agent review. The section 11 corrections, including the refuted idemKey read model. Supersedes the recon §5.3 phasing and amends HANDOVER_V1.4 tasks 1 to 6. |
| 1.1 | 2026-09-16 evening | `3915d81` | Phase 0 shipped (changelog 35, BUGLOG #56 to #64): C1 typing indicator and claim release, C2 `say()`, C5 strict PIN states, C6 context pack into the two-tier engine, C7 built, C11 wired, C13 execute routes hardened, C14 `conversation_turns`, C20 in part, the Transactions handler. Two rules kept: GetPaymentStatus request errors never release a hold; receipt provenance is settled money only. |
| 1.2 | 2026-09-16 night | `ea48cd4` | Phase 1 shipped (changelog 36): C7 wired into home, help, the fallback, the product list and the AI knowledge; C16 habits, "what do you know about me", "forget me"; the nightly integrity check; C14 cascade from the account. Phase 2 modules (C4, C8, C9, C10, C11 output gate, C17, C18) in the tree, dormant. |
| 1.3 | 2026-09-16 late night | `a803950` | Phase 2 wired (changelog 37, BUGLOG #65, #66): the shadow gate `WAPAY_AGENT_V3_MSISDNS`, `handleAgentTurn`, the `AGENT_CLARIFY` state, the WITHDRAW dispatch case; first live eval 11 of 12. Three rules kept: the model sees the redacted line, never raw; a refused or guarded turn never counts toward the budget; a failed send throws so the claim is released. |
| 1.4 | 2026-09-17 morning | `398475f` | Hotfix (changelog 38, BUGLOG #67): the missing `runWithSendScope` import that muted the bot since `3915d81`. No change to the target. C1's delivery contract is now proven by a runtime route test. Rule added: a webhook change ships only with that test green, and the first production message after a webhook deploy is watched before the deploy is called done. |
| 1.5 | 2026-09-17 morning | `4b3f478` | Withdraw affordability (changelog 39, BUGLOG #68) from the founder's first live test after the hotfix. No change to the target. |
| 1.6 | 2026-09-17 | `9bc355e` | Verification pass and three gaps closed (changelog 40, BUGLOG #69); the phase map, the preface, this table and section 13's backlog added; the page sources move into the repo under docs/architecture. |
| 1.7 | 2026-09-18 | `c1821e0` | The streamlining review and the work order (changelog 41, 42; BUGLOG #70, #71); `notifyCustomer` (43, BUGLOG #72); the frozen eval baseline and the held total (44); the internal-auth gate closed and the first event row (45); `agent_jobs` and its drain (46). **The eval half of the Phase 3 gate is met**: 156 cases, all eleven languages, 99.4% overall and 100% on action and outcome. |
| 1.8 | 2026-09-18 evening | `f91e317` | The pilot gate could not have started (BUGLOG #73) and an empty week could not be told from a broken one; `propose_note` stops writing customer facts; the 63-site JSON ring deleted with its erasure gap (BUGLOG #74); the three dead things retired; the first batch of source-text locks rewritten as behaviour, 19 surgery sites down to 6; the rest of C14's event rows and a gift that could strand (BUGLOG #75); C11 amended in section 11 rather than configured; C19 held against float. |
