# Conversation audit (first run 2026-10-19)

Two scripts and a review brief, so every customer conversation can be swept again and the
findings land in one place.

1. **Export, redacted:** `node --env-file=.env scripts/audit/export-conversations.mjs <outDir> [shards]`
   writes `turns.jsonl`, `accounts.json` and `shard-N.md` (numbers masked as `[number]`,
   first names only, account ids instead of phones). Keep the output OUTSIDE the repo: it is
   customer text.
2. **Deterministic sweep:** `node scripts/audit/scan-conversations.mjs <outDir>` writes `scan.md`
   and `scan.json`: wrong-fact words (eWallet, R20 minimum), date promises, betting words, em
   dashes, leaked internals, error lines, live products called coming soon, unanswered last
   turns, repeated bot text, clarification runs, third-tier gates, long replies, and what
   customers asked for that WaPay cannot do yet.
3. **Judgement:** give each shard to a reviewer (a person or an agent) with the brief in
   `docs/audits/REVIEW_BRIEF.md`; findings come back as `findings-N.md` + `.json`.
4. **The report:** `docs/audits/conversation-audit-<date>.md` (what was found, what was fixed,
   what is a pattern, what stays open). Every confirmed bug also gets a BUGLOG entry with its
   lock test; the report links them. That folder is the store of bug reports.

Rules: the export never enters git; the reviewer brief states what is true today so a
reviewer never flags correct behaviour; a finding without a quoted line is not a finding.
