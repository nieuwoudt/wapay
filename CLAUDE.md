# WaPay — Project Constitution

Every Claude session (and every human) working in this repo follows these rules. They exist because money moves through this code and because multiple development threads run in parallel.

## What this is

WaPay is a **live WhatsApp wallet for South Africa** (Next.js on Vercel, Postgres/Supabase, Prisma). Users load money (Blu voucher cash-in, PayFast card/EFT), buy airtime/data/electricity (Blu QA), buy/send OTT vouchers ("send money"), and create payment requests ("please pay me"). Conversation runs through a two-tier AI orchestrator (GPT-5.5 + GPT-5.4-mini, strict structured outputs) that only ever PROPOSES actions — execution is deterministic and PIN-gated.

## Where things are

- **Canonical repo:** iCloud `…/Desktop/WaPay /WaPay V1.01` (folder name has a trailing space — ALWAYS quote paths). Push to `main` auto-deploys Vercel.
- **Fast working copy:** `~/Projects/wapay` (no .git). **Edit and test here**, then rsync back (exclude `node_modules .next .pnpm-store .env dist .git *.log .ott-test-vouchers.local.json`), then commit+push from the iCloud repo. NEVER `pnpm install` in iCloud.
- **Secrets:** local `.env` only (never committed). Prod DB URL, OTT credentials, OpenAI key live there; production env lives in Vercel.
- **Project state docs** (READ AT SESSION START, UPDATE ON EVERY SHIP):
  - `…/Desktop/WaPay /WAPAY_BUILD_TRACKER.md` — running status, newest entry wins
  - `docs/CHANGELOG.md` — one dated section per meaningful commit
  - `docs/BUGLOG.md` — every bug: symptom → root cause → fix → guard
  - `docs/CAPABILITIES.md` — the single honest answer to "what works?"
  - Strategy/agreements/research live as `WAPAY_*.md` next to the tracker

## Money-safety invariants (never weaken)

1. **Integer cents only.** No floats in money math, ever.
2. **All money movement goes through `lib/ledger-core.js` builders + `lib/ledger-post.js` `postEntry`** — balanced double-entry, atomic, idempotent by `idemKey`. NOTHING else may mutate `Wallet.availableCents/pendingCents`. Manual credits = `postEntry` with an idemKey, never direct wallet updates (BUGLOG #16).
3. **idemKeys are deterministic and epoch-free.** Raw `Date.now()` digits in any id that feeds an idemKey will be rejected by ledger-core's guard AT SETTLE TIME — after the provider delivered (BUGLOG #17). Use base36 stamps, UUIDs, or letters-only codes.
4. **Two-phase spend:** `ensureWallet → reserveHold → provider call → settleHold` / `releaseHold`. Every crash path must release its hold (hoist the idemKey; release in the outer catch — BUGLOG #15).
5. **Cross-rail exactly-once:** when two rails can satisfy the same obligation (e.g. a payment request paid by balance OR card), they must share ONE idemKey so `postEntry` replay arbitrates (BUGLOG #18).
6. **The AI proposes; it never executes.** Model output is UNTRUSTED INPUT: re-validate every slot (msisdn via `isValidSaMsisdn`, integer amounts, never the model's meter). Money actions end in the deterministic preview→confirm→PIN flows.
7. **The AI never states balances or transaction status** — those are actions answered from the ledger. Receipt-shaped AI replies are blocked (`looksLikeReceipt`).
8. **Bearer secrets** (voucher PINs, 13+ digit runs): never logged, never in stored conversation history, delivered via WhatsApp only. Failed delivery reverts the DELIVERED mark (BUGLOG #22).
9. **Only PIN-shaped input (`\d{4,6}`) reaches `verifyPIN`** — anything else burns lockout attempts (BUGLOG #19).
10. **Quotes are binding:** whatever fee the preview quoted is what the ledger books (BUGLOG #20).

## Policy invariants

- **Zero betting/gambling references in any WhatsApp-facing copy** — Meta cannot grant SA gambling permission; violation risks the entire WABA (see memory + `WAPAY_BETTING_RESEARCH_2026-08-19.md`). Betting UX belongs on the web, never in chat. Tests enforce this — keep them passing.
- **No cash-out claims in copy.** OTT vouchers are spend-only (OTT in writing, 2026-08-19). Withdrawals ship only after the Payout agreement is signed AND counsel clears it.
- **Coming-soon categories** (LIFESTYLE/BILLPAY/GAMING/REMITTANCE) stay gated everywhere (`isCategoryLive`).
- **Fees are flat and quoted before confirmation.** Fee direction on payment requests: the REQUESTER pays, never the payer (2026-08-22).

## Engineering discipline

- **Tests before ship:** `node --test tests/*.test.mjs` (glob form — Node 24) must be 100% green, plus `pnpm build` compiles. Never push red.
- **Every bug gets a BUGLOG entry with a regression guard.** A bug without a guard is not closed.
- **Static tests** read the processor source to lock wiring/copy invariants — when you change copy deliberately, update the test in the same commit.
- **Conversation states must never trap:** cancel/home keywords + `isConversationalEscape` to the router on real sentences. YES-words include yebo/ewe/ja/ee/eya.
- **Vercel constraints:** 60s function cap; NEVER fire-and-forget after `res.send()` (the mute-bot bug — webhook awaits before ACK, tests enforce).
- **OTT API:** NEVER call `GetAPIKey` — it rotates the live key. GetBalance is the safe connectivity check.
- **Migrations:** idempotent SQL in `packages/domain/prisma/migrations/`, applied to prod via raw SQL (`migrate deploy` doesn't work — unbaselined), then `prisma generate`.

## Parallel sessions & handover policy

Multiple Claude threads may work this repo simultaneously. To avoid collisions:

1. **Start of session:** read the tracker's newest entries + `git log --oneline -5` + `git status` in the iCloud repo AND diff the fast copy (`rsync -rcn`) before assuming state. Uncommitted work you didn't write = another session's work in flight — inventory it, never clobber or revert it.
2. **Before pushing:** `git fetch` first. If the remote is ahead with an identical tree, adopt the remote commit. If a `.git/index.lock` exists: check `ps`/`lsof` for a live git process; only remove the lock when none holds it, then `git reset --mixed HEAD` if the index is corrupted (iCloud sync can kill git mid-write — files on disk are untouched).
3. **Ship in small commits** with the tracker/CHANGELOG updated in the same push, so a parallel thread reading the tracker sees the truth.
4. **Running out of context:** write a HANDOVER entry in the tracker before the thread dies: deployed HEAD, what's mid-flight, exact next steps, open user actions, and any credentials/answers received but not yet applied. The next thread starts from the tracker + memory index + `docs/CAPABILITIES.md`.
5. **Memory:** durable strategic facts (agreements, regulatory positions, contacts, locked decisions) go in the auto-memory files, not just the chat.

## Known sharp edges

- iCloud TCC can silently revoke file access mid-session — fix: System Settings → Privacy & Security → Full Disk Access toggle.
- The trailing space in `WaPay ` breaks unquoted shell paths.
- PayFast: no payout product (collections only); ITN source-IP check is warn-only (modern ranges); passphrase is part of the signature.
- Emailed OTT credentials can be stale — the portal (API Settings) is the truth; verify with GetBalance before rotating anything into Vercel.
