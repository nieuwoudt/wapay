# The daily conversation audit

*Built 2026-10-19 from docs/audits/DAILY_AUDIT_BRIEF.md, after the first audit by hand (docs/audits/conversation-audit-2026-10-19.md: 93 problems across 348 customers). Every night the new conversations are swept and reviewed without anyone asking, the findings are stored with their recurrence, Mission Control shows found, open and resolved over time, and the checker reads today's switches so a feature launch updates it by itself.*

## 1. How it runs

The 02:00 UTC cron (`pages/api/cron/daily-vas-sync.js`, the one cron on the Hobby plan) calls `runDailyAudit` once, inside its own try/catch with a hard cap of 25 seconds (less when the earlier steps used the function's budget). It is logged as `cron_daily_audit` and never returned, so it can neither fail nor delay the cron.

`runDailyAudit({ prisma, now, since, dry, deadlineMs })` in `lib/audit/run.js`:

1. **The window.** `since` = the last finished run's `until`, or 24 hours ago, never more than 7 days back; `until` = now.
2. **Export** (`lib/audit/export.js`): every account with a turn in the window, its turns plus the ten turns before the window for context, redacted exactly as `scripts/audit/export-conversations.mjs` redacts (six or more digits become `[number]`, "Name on the account: [name]", the answer to a full-name ask is `[name]` by position), with the facts the shard header carried (state, source, entry, links made and paid, created). Account ids only. `WAPAY_AUDIT_MAX_ACCOUNTS` (default 400; the first ad day brought about 300 active accounts) caps a run, busiest first; accounts over the cap are NOT read (the next window starts where this one ended), and the summary says how many were left out.
3. **Rules** (`lib/audit/rules.js`): the deterministic sweep as pure functions: the FNB eWallet, a R20 minimum, a date promise, a word about games of chance, an em dash, an internal name, an error line, a live product called coming soon, a coming-soon purchase started, the first-link example answered with a link, an unanswered last message, the same bot text three times, two clarifications in a row, a reply over 1,200 characters. Plus the pattern counts: what customers ask for that is coming soon, the third gate tier, business asks.
4. **The brief** (`lib/audit/brief.js`): "what is true today" is GENERATED from the registries (`worksToday`, `launchScopeFor`, `comingSoonPhrases`, `feeSchedule`, the pay-out methods read from the rail with the production list as the fallback), then the severity rubric, the correct-behaviour list, `docs/audits/PROCESS_CHECKS.md`, and the titles of the findings still open (so the reviewer reuses them and recurrence counts).
5. **Review** (`lib/audit/review.js`): the accounts rendered as transcripts, chunked by about 25 accounts or 60,000 characters, each sent once to the reviewer (`WAPAY_AUDIT_REVIEW_MODEL`, default the fast category-agent model, `gpt-5.4-mini`), four chunks at a time (`WAPAY_AUDIT_REVIEW_CONCURRENCY`), through `callStructuredOnce` in `packages/ai/src/orchestrator.ts`, the single model door (docs/GOLDEN_THREAD.md 1.1): names the export knows become `[[N1]]`, phones `[[P1]]`, references `[[S1]]`, and a secret refuses the call. The tokens are left in the answer, so what is stored never carries a name. The answer is strict JSON, parsed tolerantly (bad JSON gives no findings and a logged error). Without `OPENAI_API_KEY` the review is skipped and the run says `reviewed:false`. A chunk that will not fit the budget is skipped, never started.
6. **Store** (`lib/audit/store.js`): findings are keyed by `fingerprint = sha1(category + normalised title)`. A new one is `open`; one seen in two or more runs is `recurring`; one not seen in the last two runs that had conversations is `resolved` by the rule, or by hand through `POST /api/internal/audit-resolve`. A resolved finding seen again reopens as recurring and keeps the note. Each row keeps its occurrences, the distinct accounts (ids and timestamps, the newest 20), one bot quote and one customer quote.
7. **The run row** (`audit_runs`): since, until, accounts, turns, P1/P2/P3 (distinct findings), reviewed, error, and a summary (counts after the run, the patterns, the review's own numbers, the top recurring titles).
8. **The ops summary**: one WhatsApp message to `WAPAY_OPS_ALERT_MSISDNS` (`opsPersonAlert`, once per run) and one e-mail to `ALERT_EMAIL` (`sendOpsAlert`): counts by severity, the backlog, the top recurring titles, the Mission Control link (`WAPAY_ADMIN_URL`). Counts and titles only; never a customer name, number or message.

`dry:true` computes everything and returns it without writing or sending.

## 2. How to read it

- **Mission Control, Health tab** reads `GET /api/admin/audit`: `latestRun`, `counts` (open, recurring, resolved), `trend` (one point per run day: found = distinct findings seen, resolved = resolved in that run, open = the unresolved backlog after it), `findings` (open and recurring, plus resolved in the last 30 days, P1 first) and `recurring` (by occurrences). A finding shows its title, why it is wrong, the fix, how many accounts and one quote of each side.
- **The nightly WhatsApp line** says in five lines whether the day was clean: found, the backlog, the top recurring titles. A P1 found means read the finding the same morning.
- **Fixing a finding:** every confirmed bug gets a BUGLOG entry and a lock test, as before. Then either let the rule resolve it (two runs without it) or mark it: `POST /api/internal/audit-resolve { fingerprint, note }` with the BUGLOG number. If the next run sees it again, it comes back as recurring with the note still attached: a regression.
- **Reading a run by hand:** `POST /api/internal/audit-run?dry=1` (internal key) returns the whole computation; `?since=2026-10-18T00:00:00Z` widens the window (at most 7 days back). Locally, against production, reading only and with the model off (counts, never a message):

```
node --env-file=.env -e "const p=(await import('./lib/prisma.js')).default;const {runDailyAudit}=await import('./lib/audit/run.js');const r=await runDailyAudit({prisma:p,dry:true,deps:{model:null}});console.log(JSON.stringify({ok:r.ok,accounts:r.accounts,turns:r.turns,truncated:r.truncated,counts:r.counts,ruleCounts:r.ruleCounts,patterns:r.patterns}));await p.\$disconnect()"
```

  Leave out `deps:{model:null}` to include the reviewer (one real model call per chunk, through the boundary).

## 3. How to add a feature's checks

When a feature ships, the audit must judge it the same night:

1. **The truth takes care of itself** when the feature is on a registry switch: `lib/capabilities.js` rows, `lib/vas-config.js` switches, `feeSchedule()` and the pay-out method list are read at run time, so `VAS_LIVE_AIRTIME=true` moves airtime from "coming soon" to "live for every customer" in the brief with no code change. A feature outside the registries (a new flow, a new rule in chat) needs a line in `truthBlock()` in `lib/audit/brief.js`, with a test in `tests/audit-loop.test.mjs`.
2. **The process checks** are hand-maintained: add a section to `docs/audits/PROCESS_CHECKS.md` (what correct looks like, what to flag), in the same commit as the feature.
3. **A deterministic rule** for anything a regex can catch with no judgement: add it to `RULES` (bot text) or as a block in `scanExport` in `lib/audit/rules.js`, with a fixture test. Prefer a rule to a reviewer instruction: a rule is free, runs every night, and never drifts.
4. **A known title** is reused by the reviewer automatically: the open findings' titles are in the brief.

## 4. Switches and limits

| Env | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | unset locally | without it the review is skipped (`reviewed:false`), the rules still run |
| `WAPAY_AUDIT_REVIEW_MODEL` | `WAPAY_CATEGORY_AGENT_MODEL`, else `gpt-5.4-mini` | the reviewer model; `gpt-5.5` reads more carefully and takes longer (use the internal route for it) |
| `WAPAY_AUDIT_REVIEW_CONCURRENCY` | 4 | chunks read at the same time (at most 8) |
| `WAPAY_AUDIT_MAX_ACCOUNTS` | 400 | accounts per run, busiest first; the rest are left out and counted |
| `WAPAY_ADMIN_URL` | `https://wapay-api.vercel.app/admin` | the link in the ops summary |
| `WAPAY_OPS_ALERT_MSISDNS`, `ALERT_EMAIL` | | the summary's two channels (unset = logged, not sent) |
| `WAPAY_REASONING_EFFORT` | `none` | shared with the chat; the reviewer uses the same setting |

Budget: the cron gives the run at most 22 seconds of work (25 with the cap); the internal route gives 50. The export of a 300-account day takes about 4 seconds on the pooler; the review takes what is left after a 6 second reserve for the writes and sends the chunks in parallel. On a busy night the cron run may still read fewer chunks (`reviewed:false`, `chunksSkipped` in the summary); `POST /api/internal/audit-run` can be called by hand for a full read, and the rules always run to the end.

## 5. Tables and migration

`packages/domain/prisma/migrations/20261019_audit_loop/migration.sql` creates `audit_runs` and `audit_findings` (idempotent). Apply by hand against the pooler before the code deploys, then `pnpm prisma:generate`:

```
node --env-file=.env scripts/apply-migration.mjs 20261019_audit_loop
```

Until the tables exist the run fails cleanly (`audit_run_failed` in the log, nothing sent).

## 6. Privacy, stated plainly

- The model receives: redacted transcripts (the memory already hides PINs, IDs, account numbers and the name typed at the withdrawal's name step), account ids, the facts above. Known names, phones, e-mails and references become tokens at the boundary; a surviving secret refuses the whole chunk (`AI_PRIVACY_BLOCK`, logged by kind). Nothing is restored on the way out.
- The store keeps quotes of at most 200 characters from the redacted memory with known names masked; the ops summary and the logs keep counts and titles only.
- The routes: `audit-run` and `audit-resolve` need the internal key; `admin/audit` needs the admin session or the key; all three are read-only on customer data.

## The precision gate (added after the first real run, 2026-10-19 13:52 UTC)

The first run over production found 59 distinct problems and called 54 of them P1 wrong facts;
reading them, 50 were the reviewer misreading four things: the payer's card methods (it called
them unsupported), who carries the card fee (it read "the payer never pays a fee" as a
contradiction of "the fee comes off what you receive"), the fee arithmetic, and the business
invite list taken as a rule about opening an account. Two changes:

- The truth block now states those four facts outright, with worked fee examples computed by
  the same functions the chat uses (`paymentRequestFeeCents`, `grossedUpRequestCents`), and says
  that a "coming soon" line is never a wrong fact.
- The schema asks for `rule` (the truth line contradicted, copied) and `confidence` (0 to 1).
  `gateFinding` in `lib/audit/review.js` drops a wrong-fact finding whose bot line says coming
  soon, drops a finding that reasons from the invite list when nobody mentioned a business, and
  turns a P1 without a cited rule or with confidence under 0.8 into a P3 titled "Verify: …".
  Deterministic findings are untouched. `tests/audit-precision.test.mjs` locks it.

The trial rows from that first run were deleted and the loop was run again on the same day.
