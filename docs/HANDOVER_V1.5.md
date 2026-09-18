# Handover v1.5 — the Pay agent, mid-build

**Written 2026-09-18 at build `a81ac51`. Read this before touching anything.**

You are picking up a build that is three phases into `docs/AGENT_ARCHITECTURE_V2.md`.
That document is the architecture of record: it says what we are building
towards, its section 13 is the shipped log, and its section 15 is the version
table. The visual map is `docs/architecture/` (assemble with
`node docs/architecture/assemble.js`, publish the HTML to
https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB passing that URL so the link
never changes). **Every ship updates section 13 and the map in the same
commit.** That is a founder decision, not a style preference.

---

## 1. The five rules that break things if you ignore them

1. **Edit and test in `~/Projects/wapay`. Never `pnpm install` in iCloud.**
   Rsync back and commit from `"…/Desktop/WaPay /WaPay V1.01"` — the folder name
   has a trailing space, so always quote it. The rsync line that is known good:
   `rsync -a --exclude node_modules --exclude .next --exclude .pnpm-store --exclude .env --exclude dist --exclude .git --exclude '*.log' --exclude '.ott-test-vouchers.local.json' ~/Projects/wapay/ "…/WaPay V1.01/"`
2. **Never run `pnpm qa:chat` while `pnpm build` is running.** The build wipes the
   packages' `dist` while the harness is importing it. Run suite, then build,
   then harness, in that order, sequentially.
3. **Never write JavaScript with backticks or JSX inside a `node -e "…"` shell
   string.** The shell eats backticks and unquoted attribute values, and it has
   silently corrupted source three times this session (`className=empty`, a
   template literal replaced by an empty expression). Write a `.cjs` patch file
   or use the Write and Edit tools.
4. **Migrations are idempotent SQL applied to production BEFORE the code that
   reads the new column deploys:**
   `node --env-file=.env scripts/apply-migration.mjs <name>`. The apply script
   splits on `;\n`, so a `DO $$ … $$` block will fail. Use `DROP … IF EXISTS`
   plus `ADD` instead.
5. **Money rules are absolute.** Integer cents only. Every movement through
   `lib/ledger-core.js` and `lib/ledger-post.js postEntry` with a deterministic,
   epoch-free idemKey. The AI proposes and never executes. The AI never states a
   balance or a status from its own head. Quotes are binding. Voucher PINs,
   wiCodes and STS tokens are bearer secrets: never logged, never stored in
   history. No betting or gambling words in customer copy. The pay-out partner
   is never named while withdrawals are off for that customer. No em dashes in
   customer copy. Never promise a date.

---

## 2. Where the build actually is

| Phase | State |
|---|---|
| 0, safety and spine | Shipped for every customer (`3915d81`, hotfix `398475f`) |
| 1, registry, movements, policy | Shipped for every customer (`ea48cd4`) |
| 2, the Pay agent | Deployed, answering only numbers on `WAPAY_AGENT_V3_MSISDNS` (`a803950`) |
| 3, promote and delete | Not started. Blocked on the gate below |
| 4, the async tier | Two items landed early (notifyCustomer, partly); the rest not started |

**The promotion gate has two conditions and both must hold.**

- Condition one is **met**: the agent scores 99.4% over 156 cases in all eleven
  languages, 100% on action and outcome, against the two-tier engine's 100% on
  the shared 132 (`docs/testing/agent-eval-2026-09-18.md`).
- Condition two is **open**: one week of real agent turns with no money gate
  (RECEIPT, PARTNER, BETTING) firing. The pilot list carries one number, the
  founder's. Nothing has accrued. The Mission Control conversations card is what
  measures it: `GET /api/admin/conversations?days=7`.

**Do not promote anyone off the pilot list until both hold.** If you are tempted,
read BUGLOG #67: a change that looked safe made the bot mute for fourteen hours.

---

## 3. Every partial row, what is missing, and where

These are the map's amber rows. Each one is a real, bounded piece of work.

### C13 execute routes — internal auth fails OPEN when unset
`lib/internal-auth.js:67-75` returns ok when `WAPAY_INTERNAL_API_KEY` is not set,
logging once. In production that means an unset variable silently opens five
money routes. Ownership-before-PIN and the crash guards are done on all five
(BUGLOG #56, #69). **Work:** fail closed when `NODE_ENV === 'production'`, keep
the dev bypass. Check the variable is actually set in Vercel before shipping, or
you will close the routes on yourself: `curl -s -o /dev/null -w '%{http_code}' -X POST https://pleasepayme.co.za/api/vas/airtime/execute -H 'content-type: application/json' -d '{}'`
must already print 401.

### C14 conversation store — no event rows, and the old ring is still written
Nothing anywhere writes a turn with `role: 'event'`. A money outcome that
produces no message (a deposit landing, a gift claimed) is invisible to the
agent's next turn. Separately `addToConversationHistory` still writes the legacy
JSON ring at about twenty call sites in the processor; nothing reads it any more.
**Work:** record an event turn on out-of-band money outcomes (start with the
PayFast ITN and the gift claim), then delete the ring writes in one pass.

### C16 customer model — habits in JavaScript, and a note tool that writes unasked
`lib/context-pack.js:358-363` computes habits in JavaScript over the last 40
provider rows; the design asks for SQL. More important:
`lib/agent/tools/proposals.js` `propose_note` writes a note immediately with no
confirmation turn, which breaks the standing rule that the model never writes
customer facts. **Work:** make `propose_note` return a clarify that asks once,
and only write on the yes. The SQL move is an optimisation, do it second.

### C11 policy engine — nothing configured can require anything
`lib/policy.js` is wired at both call sites, but every descriptor is
`POLICY_OPEN` except WITHDRAW's `minKycTier`, which both call sites deliberately
drop (the withdraw flow owns KYC). No consent is configured, and the design's
`limit` requirement type does not exist. **Work:** either configure a real
requirement (a consent for cross-user actions is the obvious first) or amend the
design row to say the engine is a gate with nothing to gate yet, and why.

### C12 proposal dispatcher — the WITHDRAW case is pilot-only
Inherent to Phase 2. It resolves when the agent is promoted. No work.

### C19 Mission Control — no float drift
The conversations card now reports parked pay-outs, what they hold and the
oldest age. The design also asks for drift against the rail's float, which lives
in a different route (`pages/api/admin/floats.js`, the `OTT_PAYOUT` row) and is
never joined to the parked total. **Work:** fetch both in the panel and show
held against float.

### C20/C21 notifyCustomer — built, but no template configured
`lib/notify.js` picks the rail that crosses the 24-hour window. The template rail
is inert until `WAPAY_TEMPLATE_PAYOUT_OUTCOME` names an approved UTILITY template
whose body takes amount, method and reference in that order
(`payoutOutcomeParams` in `lib/payouts.js` is the contract). **This is a founder
action**: someone must submit or identify the template in Meta. Until then the
direct-send and free-form rails are used.

### C20a the pay-out sweep — daily only
`vercel.json` carries one cron, the daily 02:00 run, which sweeps at most five
rows. `/api/cron/payout-reconcile` is deployed and gated but unscheduled, because
a ten-minute schedule depends on the Vercel plan. **Founder decision, open.**

---

## 4. Phase 3, in the order it must happen

Nothing here starts before the gate closes.

1. **Promote per language** from the eval table, one language at a time.
2. **Delete the pre-model regex groups in two batches**, the eval as the gate:
   the question hooks first (fee ask, how-it-works, withdraw matcher), then the
   intent hooks (category context, the eight intent groups, the smart product
   query, the second help menu).
3. **Retire the two-tier classifier** (`packages/ai/src/orchestrator.ts`).
4. **Retire the dead code**: the second WhatsApp client, the bypassing ledger
   writer `packages/domain/src/ledger.ts postBluDeposit`, the unused
   saved-accounts table. This one is safe to do at any time and reduces risk.
5. **Rewrite the source-text test locks as behaviour tests.** There are about 34
   files that read the processor as text. Until they are rewritten, **nothing can
   be moved out of the processor** — relocating flow starters breaks roughly 27
   of them. Exporting in place breaks none.

---

## 5. Phase 4

**`agent_jobs` and its drain are built** (`lib/jobs.js`, migration
`20260918_agent_jobs` already applied to production, drained by the daily cron).
The contract is in the module comment; the short version is that enqueue is
idempotent on `(kind, key)`, claims are atomic, a vanished worker's claim goes
stale after ten minutes, and a job that exhausts its attempts is FAILED for a
human rather than retried forever. To add a worker, add a handler to the
`handlers` map in `pages/api/cron/daily-vas-sync.js` and enqueue from wherever
the work is noticed.

**A decision recorded so it is not re-litigated:** the fuel reconcile was moved
into the queue and then moved back. It looks like background work, but it only
runs for a customer who already has a stuck fuel purchase, and it is the turn on
which their voucher code can be delivered. A nightly drain would have traded
that customer's same-turn delivery for a latency saving nobody else was paying.
It queues a belt-and-braces job only when the inline reconcile resolved nothing,
so the work still completes if the turn dies. **Move it to the queue when a
ten-minute drain exists, not before.** The same test applies to anything else
you are tempted to push off the turn: ask who is waiting for it.

Still to do: additive per-account journal columns so the movement read is
indexed, a second model provider run through the corpus, an optional number-free
memory summary behind a flag, and the first partner module, which is
bank-account verification. Voice notes and photos are explicitly deferred.

---

## 6. How to know you have not broken it

```bash
node --test tests/*.test.mjs      # 864 at this build, all green
pnpm build                        # must be green before any push
pnpm qa:chat                      # 29 scenarios against the live brain, run LAST
pnpm eval:agent                   # 156 cases vs the frozen baseline; exits 1 on regression
```

The harness needs OpenAI credit. When the account is empty every model path
falls back to a canned line and four scenarios go red for that reason alone;
check for `credit_balance_exhausted` in the log before believing a regression.

After any deploy that touches the webhook, watch the first real message land:

```sql
select "waMessageId", "processedAt" from processed_messages
where "processedAt" > now() - interval '30 minutes' order by "processedAt" desc;
```

A claimed `wamid…` row plus a `status-sent` pulse means the turn worked.
`webhook-ok` pulses with no `wamid` rows and no status pulses means every turn is
dying before its first send. That is exactly what BUGLOG #67 looked like.

---

## 7. Traps this session hit, so you do not

- `node --check` and `next build` both accept an identifier that is used but
  never imported. A `tsc --allowJs --checkJs --noResolve` sweep grepping for
  `TS2304` catches it. `tests/webhook-route-runtime.test.mjs` now loads and runs
  the webhook route for real; keep it green.
- macOS has no `timeout` command. A backgrounded `timeout 600 node …` silently
  never runs.
- The chat harness has no HTTP server, so any flow that calls a preview route
  over HTTP fails there with "Non-JSON response". Test such flows at the step
  before the HTTP call.
- A disclosure hook must never sit above an erasure hook in the router
  (BUGLOG #71). Check hook order whenever you add one.
- Review agents read the code as of their read time. Re-read their verdicts
  against the current tree before acting; one of them corrected a fix I had
  made an hour earlier, and it was right.
- Coordinate with live peer sessions (`ListAgents`, `SendMessage`) before
  committing from the iCloud repo.

---

## 8. The founder's standing rules for chat

His words, now the composition policy in both prompts:

1. **If you already know the answer, offer it.** Do not ask the customer to find
   it. Never "reply back", "choose 3" or a menu when you are holding the answer.
   One recommendation, one word to escape it.
2. **Best matching product, lowest rate, always, and say the rate.** Keep the
   shape they asked for: someone who said cash gets a cash option. Cross over
   only when nothing in their shape works, and say why.
3. **Recommending is not doing.** Money still goes preview, confirm, PIN,
   execute. Recompute the number when they say yes.

His quality bar, from four reviews: a real conversation, never a menu dump,
always the right number, knows every live feature and the customer's history.
Two lines and one question for a capability ask. Lists, not paragraphs.

---

## 9. Open items that need the founder, not you

1. Top up OpenAI when it runs dry; the whole conversational layer degrades.
2. Confirm the Vercel plan so the ten-minute pay-out sweep can be scheduled.
3. Identify or submit the UTILITY template for `WAPAY_TEMPLATE_PAYOUT_OUTCOME`.
4. Ask OTT what their sandbox returns for a pay-out. Two live tests both came
   back "Failed to retrieve record"; nothing was paid either time.
5. Rotate the leaked Blu QA and Meta secrets. Still outstanding.
6. Counsel and Didit before cash-out opens beyond the allowlist.
7. The rest of the standing list in `WAPAY_STATUS.md` section 7.
