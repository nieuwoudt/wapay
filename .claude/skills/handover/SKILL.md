---
name: handover
description: Write the end-of-session handover for WaPay in the compaction-safe six-item shape (problems + resolutions, options tried/set aside, exact decisions, where things stand, what is open, hard-to-reconstruct details) into the build tracker and CHANGELOG, then save durable facts to memory. Use when the session is ending, context is running long, or the user says "hand over", "wrap up", "write the tracker".
---

# /handover — tracker + CHANGELOG + memory, in the shape a new context can resume from

## Why this shape
Claude Fable 5.1 resumes best from a summary that keeps six things exactly (Anthropic prompting guide, "Tell the model what to preserve in compaction summaries"). Our tracker handovers follow the same six items so the next thread never redoes work or loses a constraint.

## Steps

1. **Establish truth** (batch): `git -C "<iCloud repo>" log --oneline -5`, `git status --short`, `rsync -rcn --itemize-changes` between the fast copy and iCloud (exclude `node_modules .next .pnpm-store .env dist .git *.log .ott-test-vouchers.local.json`), the last test run result, the last build result. Never claim "green" without the output in this session.
2. **Write the tracker entry** at the TOP of `…/Desktop/WaPay /WAPAY_BUILD_TRACKER.md` as `# 🤝 HANDOVER — <date> (<one-line state>)` with these six sections, in order:
   1. **Problems met and how they were resolved** (bugs found → BUGLOG numbers).
   2. **Options raised, tried, set aside, and why.**
   3. **Decisions, constraints, preferences — stated exactly** (quote the founder where possible).
   4. **Where things stand** (deployed HEAD, tests N/N, build, what is in the fast copy but not yet committed, which files).
   5. **Open items / next steps / founder actions** (env names, Vercel redeploy reminder, credentials received but not applied).
   6. **Hard-to-reconstruct details** (names, numbers, exact wording, links, template names, error codes).
3. **CHANGELOG**: one dated section at the top of `docs/CHANGELOG.md` per meaningful commit, plain prose, what changed and why, test/build counts.
4. **BUGLOG**: every bug found gets symptom → root cause → fix → guard. A bug without a guard is not closed.
5. **CAPABILITIES**: flip any row whose state changed.
6. **Memory**: durable strategic facts (decisions, regulatory positions, contacts, integration facts that cost real debugging) go into the auto-memory directory with the frontmatter shape, and a one-line pointer into `MEMORY.md`. Check for an existing file first; update rather than duplicate.
7. **Coordinate before committing**: inventory every differing path from step 1; `git add` selectively; never commit files another session authored. If SendMessage is available, agree the split with the live peer session first.

## Rules
- Use the user's own words for decisions; condense your reasoning to conclusions.
- Convert relative dates to absolute.
- Mention env vars only take effect on REDEPLOY whenever you hand over env instructions.
