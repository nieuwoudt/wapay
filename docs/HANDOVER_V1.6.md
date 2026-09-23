# Handover v1.6 — the Pay agent, after the pilot gate was found broken

**Written 2026-09-18 evening at build `1d9f1b8`. Read this before touching anything.**

This replaces `docs/HANDOVER_V1.5.md`, which is still accurate about the rules
and the traps; where the two differ on where the build stands, this one is
right. The architecture of record is `docs/AGENT_ARCHITECTURE_V2.md` (now
version 1.8): section 13 is the shipped log, section 15 the version table,
section 11 the corrections. The visual map is `docs/architecture/`, assembled
with `node docs/architecture/assemble.js` and published to
https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB (now Version 7) by passing
that URL so the link never changes. **Every ship updates section 13 and the map
in the same commit.** Founder decision, not a style preference.

---

## 1. The five rules that break things if you ignore them

Unchanged from v1.5, and all five still earn their place.

1. **Edit and test in `~/Projects/wapay`. Never `pnpm install` in iCloud.**
   Rsync back and commit from `"…/Desktop/WaPay /WaPay V1.01"` (the folder name
   has a trailing space: always quote it). The known-good line:
   `rsync -a --exclude node_modules --exclude .next --exclude .pnpm-store --exclude .env --exclude dist --exclude .git --exclude '*.log' --exclude '.ott-test-vouchers.local.json' ~/Projects/wapay/ "…/WaPay V1.01/"`
   **Never add `--delete`.** This session did once and it removed five brand
   fonts that exist only in iCloud (`marketing/brand/fonts/Archivo-*`,
   `Public-Sans-*`); `git checkout -- marketing/` restored them and the fast
   copy now has them too, but the next `--delete` will find something else.

   **The corollary, which cost a red HEAD on 2026-09-23: because the rsync
   never deletes, DELETING A FILE WITH `rm` IN THE FAST COPY DOES NOTHING TO
   THE REPO.** `git add -A` sees no deletion, the file stays tracked, and your
   local suite is green while everyone else's is red. `tests/agent-note-confirm.test.mjs`
   lived on like that for four days after the behaviour it tested was
   reversed, and a peer session found it, not me. **Delete with `git rm` in
   the iCloud repo.** After removing anything, check:
   `for f in $(git ls-files); do [ -f ~/Projects/wapay/"$f" ] || echo "ORPHAN: $f"; done`

   **And when another session is live, stage by path, never `git add -A`.**
   A peer had uncommitted pay-out work sitting in the shared fast copy; an
   `add -A` would have committed their work in progress under my message
   (this is BUGLOG #25 happening again). `git status` in the iCloud repo shows
   what is really yours.
2. **Never run `pnpm qa:chat` while `pnpm build` is running.** Suite, then
   build, then harness, sequentially.
3. **Never write JavaScript with backticks or JSX inside `node -e "…"`.** Write
   a `.cjs`/`.py` patch file or use the Write and Edit tools.
4. **Migrations are idempotent SQL applied to production BEFORE the code that
   reads them deploys:** `node --env-file=.env scripts/apply-migration.mjs <name>`.
   The apply script splits on `;\n`, so a `DO $$ … $$` block fails.
5. **Money rules are absolute.** Integer cents; every movement through
   `lib/ledger-core.js` and `postEntry` with a deterministic, epoch-free
   idemKey; the AI proposes and never executes; the AI never states a balance or
   status from its own head; quotes binding; voucher PINs, wiCodes and STS
   tokens never logged or stored in history; no betting words in customer copy;
   the pay-out partner never named while withdrawals are off for that customer;
   no em dashes in customer copy; never promise a date.

---

## 2. Where the build actually is

| Phase | State |
|---|---|
| 0, safety and spine | Shipped for every customer |
| 1, registry, movements, policy | Shipped for every customer |
| 2, the Pay agent | Deployed, answering only numbers on `WAPAY_AGENT_V3_MSISDNS` |
| 3, promote and delete | Not started. Its preparation is now done (see section 4) |
| 4, the async tier | `agent_jobs` + drain and `notifyCustomer` landed early |

**The promotion gate has two conditions.**

- **Condition one is MET.** 156 cases in all eleven languages, 100% on action
  in every language against a frozen baseline, no regression on this build
  (`pnpm eval:agent`, `docs/testing/agent-eval-baseline.json`).
- **Condition two has NOT STARTED.** Not "is open": `agent_turns` held **zero
  rows** when this session began and still does. See section 3.

**Do not promote anyone off the pilot list until both hold.**

---

## 3. The first thing you should check, and what this session found

Run this and read `shadow`:

```bash
curl -s -H "x-internal-api-key: $WAPAY_INTERNAL_API_KEY" \
  "https://pleasepayme.co.za/api/admin/conversations?days=7" | python3 -m json.tool
```

It now answers the question directly:

```
"shadow": {
  "count": 1, "live": true,
  "entries": [{ "tail": "1175", "valid": true, "hasAccount": true, "turnsInWindow": 0 }],
  "started": false, "firstTurnAt": null, "moneyGateFired": false,
  "cleanDays": 0, "cleanDaysNeeded": 7
}
```

`started: false` means the week has not begun. `cleanDays` counts whole days
since the first agent turn, **reset by the newest money gate**, so it is the
promotion condition as a number rather than a judgement.

**What the founder is owed on this (BUGLOG #73).** The first reading showed 19
customer messages, 20 replies, the list live with one number, and zero agent
turns; `agent_turns` had never received a row since the table was created. The
messages were landing (claimed `wamid` rows and `status-sent` pulses in
`processed_messages`) and all 19 were his. The gate compared the list entry to
the wa_id Meta sends as raw text, so of the four ways a person writes a South
African number into the Vercel dashboard — `27787051175`, `+27787051175`,
`0787051175`, `+27 78 705 1175` — three matched nobody, silently, while the old
engine went on answering perfectly well. **His entry was in fact the correct
one**, so nothing had been lost; the failure mode had. The list now lives in
`lib/shadow-list.js` and matches on canonical digits, and the card reports each
entry so an empty week can never again be confused with a broken one.

**The clock starts on his first message from that number.** Nothing else is
needed: the variable is set in production and the number resolves to an account.

---

## 4. What changed in this session

Six pushes, `047e07e` → `1d9f1b8`. Changelog entries 47 to 52, BUGLOG #73 to #75.

- **The pilot gate** (§3 above), plus the Mission Control diagnostics and clean-day count.
- **`propose_note` no longer writes** (C16). It is pure: no database, no clock,
  no context, `accepted: false` on every path. It returns a pending note; the
  agent loop ends the turn on it, **below** the proposal check so money always
  wins and **above** the reply check so the model cannot narrate a memory it has
  not got; the runtime asks in its own words, gates the model-authored text,
  parks only once the customer has seen it, and writes through the new
  deterministic `addNote` on an explicit yes. Anything that is not a yes or a no
  keeps nothing and is answered as a fresh message. The model is now the author
  of no customer fact anywhere.
- **The legacy JSON conversation ring is deleted** (C14). **63** write sites in
  the processor, not the "about twenty" v1.5 recorded, and no readers anywhere.
  Each was a read-modify-write of a column that also carries live flow state and
  the inbound dedupe list. Migration `20260918_drop_conversation_ring` (applied
  to production before the code) clears the residue, and the erasure path clears
  it per account: **"forget me" had never touched it** (BUGLOG #74), so a
  customer who asked to be forgotten kept ten of their own messages.
- **Event rows finished** (C14). All three ways the pay-out sweep can fail to
  tell a customer now write the ledger fact into the history the agent reads,
  through one `recordUntold` helper, and all three are counted. The PayFast ITN
  writes one when a deposit lands and the confirmation does not send.
  **BUGLOG #75**: `claimPendingGifts` marks a gift DELIVERED before anything is
  sent; the send-failure branch always put it back, but a throw anywhere else in
  the loop did not, so a gift could sit DELIVERED with the recipient holding
  nothing. Every claim is now tracked and reverted on any failure. No event row
  on that path on purpose: saying a voucher was delivered when the PIN never
  arrived would be a false fact in the agent's memory.
- **Phase 3 prep, done.** The three dead things are deleted (the second
  WhatsApp client, `postBluDeposit`, `UserSavedAccount`), and the first batch of
  source-text locks is rewritten as behaviour: thirteen functions exported from
  the processor **in place**, surgery down from 19 sites to 6.
- **C11 amended, not configured**, and **C19** shows held against the rail's
  float. A failed consent write at onboarding is no longer silent.

---

## 5. What to do next, in order

1. **If the founder has messaged from the pilot number, the week has started.**
   Watch `cleanDays` and `gates`. If a money gate fires (RECEIPT, PARTNER,
   BETTING), that is your first priority: find the `agent_turns` row, read its
   `gatesFired` and `payload`, and fix the cause before the clock restarts.
2. **Finish the source-text locks.** Six surgery sites remain, over four files,
   and each reaches for something that is not a top-level function:
   `productQueryIndicators` (a const array inside a function body,
   `chat-qa-findings.test.mjs`), `onboardingOtpDisabled` (`business-chat.test.mjs`),
   two object literals (`help-conversational.test.mjs`) and a lookup map
   (`phase0-review.test.mjs`). Beyond those, about 30 files still read the
   processor as text with ordinary string assertions; the pattern to follow is
   in `docs/CHANGELOG.md` entry 50 and `tests/shadow-list.test.mjs`. Keep the
   assertions that genuinely check source SHAPE (hook order, "this file imports
   no model client", coverage floors) — those are legitimate and should stay.
3. **Habits in SQL (C16), deliberately not done.** `lib/context-pack.js`
   computes habits in JavaScript over the last 40 provider rows. It can only
   UNDER-count, the eval that gates Phase 3 renders no habits at all
   (`buildSyntheticPack` in `scripts/eval-agent.mjs` has no `habits` key), and
   two test stubs (`tests/context-pack.test.mjs`, `tests/phase0-review.test.mjs`)
   have no `$queryRaw`, so a ninth query would silently warn there. It is an
   optimisation with a real chance of a quiet regression. If you do it: add it as
   one more parallel entry in the pack's `Promise.all`, and fix the eval fixture
   first so the change is visible to the gate.
4. **When the gate closes, Phase 3 proper**: promote one language, watch it,
   then the next; then delete the pre-model regex groups in two batches (question
   hooks first, then intent hooks) with the eval as the gate; then retire
   `packages/ai/src/orchestrator.ts`.

---

## 6. How to know you have not broken it

```bash
node --test tests/*.test.mjs   # 895 at this build, all green
pnpm build                     # must be green before any push
pnpm qa:chat                   # 29 scenarios against the live brain, run LAST
pnpm eval:agent                # 156 cases vs the frozen baseline; exits 1 on regression
```

`pnpm build:packages` is needed after any change under `packages/`, because both
the app and the tests resolve `@wapay/ai` to `dist/`.

The harness needs OpenAI credit; check for `credit_balance_exhausted` before
believing a regression. After any deploy that touches the webhook, watch the
first real message land:

```sql
select "waMessageId", "processedAt" from processed_messages
where "processedAt" > now() - interval '30 minutes' order by "processedAt" desc;
```

---

## 7. Traps this session hit, so you do not

- **`rsync --delete` deleted five brand fonts.** See rule 1.
- **The iCloud copy is not the fast copy.** A publish of the phase map was
  refused as "identical content resent" because the map had been regenerated in
  `~/Projects/wapay` and the publish pointed at the stale iCloud file. Rsync
  first, then publish.
- **The em-dash lock covers comments too.** `tests/agent-tools.test.mjs` scans
  every file under `lib/agent/tools/` for an em or en dash, including a header
  comment. So does the "definitions, not mentions" trap: a test that greps a
  file for a symbol will match your own comment explaining that you removed it.
- **`tests/phase2.test.mjs` locks handleAgentTurn to exactly five `await
  ledger(` calls.** Adding a sixth breaks it. This session avoided it by
  reusing the existing reply tail rather than adding a branch with its own send
  and ledger row, which was also the simpler design.
- **There is a SECOND `AGENT_CLARIFY` handler**, inside `handleSharedContact`,
  whose `else if (state)` answers "you're busy with another step" for every
  other state. A new agent-owned state must be added there too.
- **Model nondeterminism in the harness.** "buy R30 airtime" has two legitimate
  landings and one of them reaches the preview route over HTTP, which the
  harness cannot serve. It read as a failure every other run; the assertion now
  accepts it. Re-run before believing a single red scenario.
- **Review agents read the code as of their read time.** One of this session's
  verifiers refuted a claim that had been true an hour earlier. Re-check
  verdicts against the current tree.
- **macOS has no `timeout`.** A backgrounded `timeout 600 node …` never runs.

---

## 8. The founder's standing rules for chat

His words, now the composition policy in both prompts:

1. **If you already know the answer, offer it.** Never a menu when you are
   holding the answer. One recommendation, one word to escape it.
2. **Best matching product, lowest rate, always, and say the rate.** Keep the
   shape they asked for; cross over only when nothing in their shape works, and
   say why.
3. **Recommending is not doing.** Money still goes preview, confirm, PIN,
   execute, with the number recomputed on yes.

Quality bar: a real conversation, never a menu dump, always the right number,
knows every live feature and the customer's history. Two lines and one question
for a capability ask. Lists, not paragraphs.

---

## 9. Open items that need the founder, not you

1. **Send the six messages from the pilot number.** The shadow week cannot start
   without them, and it is the only thing standing between here and Phase 3.
2. **The Vercel plan** (Hobby or Pro): decides whether the ten-minute pay-out
   sweep is a cron entry or a trigger from elsewhere. Until then the sweep runs
   daily and the fuel reconcile stays on the customer's turn, which is a
   recorded decision, not an oversight.
3. **An approved UTILITY template** for `WAPAY_TEMPLATE_PAYOUT_OUTCOME`, body
   taking amount, method and reference in that order (`payoutOutcomeParams` in
   `lib/payouts.js` is the contract). Env changes only take effect on REDEPLOY.
4. **Ask OTT what their sandbox returns for a pay-out.** Two live tests both
   came back "Failed to retrieve record" with nothing paid. Do not change the
   reconciler on a guess.
5. **Rotate the leaked Blu QA and Meta secrets.** Still outstanding.
6. **Counsel and Didit** before cash-out opens beyond the allowlist.
7. **Optional cost variables** `WAPAY_EVAL_PRICE_INPUT_USD_PER_M`,
   `WAPAY_EVAL_PRICE_OUTPUT_USD_PER_M`, `WAPAY_USD_ZAR`: they only turn on the
   cost figure in Mission Control.
8. **A founder call, written up rather than taken:** `apps/` is dead weight (it
   is outside `build:packages` and cannot compile), but removing it touches
   `pnpm-workspace.yaml` and two root scripts (`dev:api`, `dev:ops`), and four
   tests reach into package `dist/` folders by relative path while CI never runs
   `build:packages`. Related: `.github/workflows/tests.yml` caches pnpm before
   installing it and never builds the packages, so CI is likely red for reasons
   unrelated to the code. Worth one deliberate pass, not a drive-by.
