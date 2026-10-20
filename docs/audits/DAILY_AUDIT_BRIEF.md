# Brief: the daily conversation audit loop (written 2026-10-19 for the builder agent)

## Why
The first audit (docs/audits/conversation-audit-2026-10-19.md) found 93 problems across 348
customers by reading every conversation once, by hand, with agents. The founder wants that
to happen every day without anyone asking: new conversations swept and reviewed, findings
stored with their recurrence, a report Mission Control can show (found, open, resolved over
time), and a checker that stays current when a feature launches.

## What exists already (reuse, do not rewrite)
- `scripts/audit/export-conversations.mjs`: the redaction rules (numbers ≥6 digits, the
  full-name step by position, "Name on the account: …"). Port them into a library function.
- `scripts/audit/scan-conversations.mjs`: the deterministic rules. Port them into a pure
  library module with fixtures.
- `docs/audits/REVIEW_BRIEF.md`: what a reviewer judges against. The "what is true today"
  part must now be GENERATED from the registry so a feature launch updates the checker:
  `worksToday()` / `launchScopeFor()` / `comingSoonPhrases()` in `lib/capabilities.js` and
  `lib/vas-config.js`, `feeSchedule()` in `lib/fee-facts.js`, the live pay-out methods
  (`resolveProviders` in `lib/payouts.js`, best effort, fall back to the production two:
  PayShap and cash at Absa or Nedbank). Hand-maintained process checks live in
  `docs/audits/PROCESS_CHECKS.md` (one section per feature; create it).
- The model: `packages/ai/src/orchestrator.ts` shows the OpenAI client and the privacy
  boundary (`packages/ai/src/boundary.ts`: `tokenize`, `restore`, `findSecrets`). Every
  string sent to the model crosses the boundary. The audit sends redacted transcripts and
  account ids only, never a name, number, PIN or code (docs/GOLDEN_THREAD.md).
- Ops delivery: `opsPersonAlert({ text, key })` in `lib/ops-alerts.js` sends one WhatsApp
  message to the ops numbers once per key; `sendOpsAlert({ subject, detailsHtml })` in
  `lib/email.js` is the e-mail. Use both for the daily summary.
- The cron: `pages/api/cron/daily-vas-sync.js` runs at 02:00 UTC (the only cron on the
  Hobby plan, see vercel.json). Add the audit as a step there that can never fail the cron.
- Migrations: `packages/domain/prisma/migrations/<date>_<name>/migration.sql`; `migrate
  deploy` is unbaselined on production, so the SQL is applied by hand against the pooler and
  then `pnpm prisma:generate`. WRITE the migration; do not apply it.

## Deliverables
1. `lib/audit/export.js`: `exportTurns({ prisma, since, until, maxAccounts })` → accounts
   with their turns since `since` (plus the 10 turns before `since` per account for context),
   redacted exactly as the script does, grouped per account, with the account facts the
   shard header carried (state, source, entry, links made and paid, created).
2. `lib/audit/rules.js`: the deterministic sweep as pure functions over that export →
   findings `{ severity, category, title, accountId, at, botQuote, userQuote, why, fix,
   rule }` plus the pattern counts (asks for coming-soon products, unanswered, loops,
   clarification runs, gate tiers).
3. `lib/audit/brief.js`: `buildReviewBrief()` → the reviewer brief text: the generated
   "what is true today" block + the severity rubric + the correct-behaviour list +
   `docs/audits/PROCESS_CHECKS.md` content. Deterministic; unit-tested in both switch worlds
   (hold on, hold off).
4. `lib/audit/review.js`: `reviewAccounts({ brief, accounts, model, maxChars })` → model
   findings as the same shape, parsed tolerantly (bad JSON → no findings, logged). Chunk by
   about 25 accounts or 60k characters per call. Through the boundary. Skipped cleanly when
   `OPENAI_API_KEY` is unset (then the run is deterministic only, flagged `reviewed:false`).
5. `lib/audit/store.js` + schema: tables `audit_runs` (id, startedAt, finishedAt, since,
   until, accounts, turns, p1, p2, p3, reviewed, error, summary json) and `audit_findings`
   (id, fingerprint = sha1(category + normalised title), severity, category, title, why,
   fix, firstSeenRunId, lastSeenRunId, occurrences, accountsJson (ids + timestamps, max 20),
   sampleBotQuote, sampleUserQuote, status open|recurring|resolved, resolvedAt, resolvedNote).
   Status rules: open = seen in the latest run; recurring = seen in two or more runs;
   resolved = not seen in the last two runs after having been seen, or marked by hand.
6. `lib/audit/run.js`: `runDailyAudit({ prisma, now, since, dry })` = export → rules →
   review → upsert findings → write the run → compute the trend → send the ops summary (counts
   by severity, the top recurring titles, the link to Mission Control). `dry:true` returns the
   result without writing or sending.
7. Routes: `POST /api/internal/audit-run` (internal key; `?since=ISO`, `?dry=1`),
   `POST /api/internal/audit-resolve { fingerprint, note }` (internal key),
   `GET /api/admin/audit` (requireAdmin) returning exactly:
   `{ latestRun, counts: { open, recurring, resolved }, trend: [{ date, found, resolved, open }],
   findings: [...], recurring: [...] }` where a finding is `{ id, fingerprint, severity,
   category, title, occurrences, firstSeenAt, lastSeenAt, status, accounts, sampleBotQuote,
   sampleUserQuote, why, fix }` (accounts = a count). Mission Control's Health tab reads this.
8. Cron: one call to `runDailyAudit` inside `daily-vas-sync.js`, try/catch, logged, 25 s cap.
9. Tests `tests/audit-loop.test.mjs`: the rules on fixtures (eWallet, R20, loop, unanswered,
   example echo); the brief reflects the switches; fingerprint stability and recurrence;
   the review parser on good, partial and bad JSON; the routes refuse without the key or
   session; the cron step never throws.
10. Docs: `docs/audits/DAILY_AUDIT.md` (how it runs, how to read it, how to add a feature's
    checks), `docs/audits/PROCESS_CHECKS.md` (onboarding, pay links, send, add money,
    withdraw, ad flow, business, close account: what correct looks like, what to flag), a
    CHANGELOG entry draft at the top of docs/CHANGELOG.md numbered 99, env.template lines
    (`WAPAY_AUDIT_MAX_ACCOUNTS`, `WAPAY_AUDIT_REVIEW_MODEL`).

## Rules
- Edit only the files above. Do not touch `pages/admin/index.js`, `pages/api/admin/metrics.js`
  or `pages/api/admin/growth.js` (another writer is in them). No commits, no pushes, no Vercel,
  no `prisma migrate`, no `pnpm qa:chat` (the database pooler allows one harness at a time).
- Reading the production database with `node --env-file=.env` is allowed for a dry run; never
  write to it. Keep every customer identifier out of logs and out of the model's input.
- `node --test tests/*.test.mjs` must stay green; `node --check` every file you touch; run
  `pnpm build:packages` only if you change `packages/`.
- Finish with a message of at most 25 lines: files written, the test command and result, how
  to run the dry run, the migration file path, and anything you could not do.
