# The prompt to start the next thread with

Paste everything below the line into a new session opened on the WaPay workspace.
Keep this file updated at the end of every session, the way `WAPAY_STATUS.md` is.

---

You are picking up the WaPay build mid-flight. Production is healthy and serving
build `c1821e0`. Do not start by exploring: read these four, in this order, and
then start work.

1. `WaPay V1.01/docs/HANDOVER_V1.5.md` — written for you. The five rules that
   break things, where the build actually is, every unfinished row with its
   exact gap and file, the order the next phase must happen in, how to verify
   you have not broken anything, and the traps the last session hit.
2. `WaPay V1.01/docs/AGENT_ARCHITECTURE_V2.md` — the architecture of record. It
   says what we are building towards. Section 13 is the shipped log, section 15
   is the version table. Every ship updates section 13 and the visual map in the
   same commit. That is my decision, not a style preference.
3. `WAPAY_STATUS.md` — the living status. Bump its version when you change what
   is true.
4. `WaPay V1.01/docs/CHANGELOG.md`, newest six entries (41 to 46), and
   `docs/BUGLOG.md` #67 to #72. That is the last two days.

## Where the build stands

Phases 0 and 1 of the architecture are live for every customer. Phase 2, the Pay
agent, is deployed but answers only numbers on `WAPAY_AGENT_V3_MSISDNS`, which
currently holds one number, mine. Phase 3 has not started. Two Phase 4 items
landed early: the notify helper and the jobs table.

The gate into Phase 3 has two conditions and both must hold before anyone is
promoted off the pilot list.

- **Condition one is met.** The agent scores 99.4% over 156 cases in all eleven
  languages, 100% on action and outcome, against the two-tier engine's 100% on
  the shared 132. Report: `docs/testing/agent-eval-2026-09-18.md`.
- **Condition two is open.** One week of real agent turns with no money gate
  (RECEIPT, PARTNER, BETTING) firing. Measure it at
  `GET /api/admin/conversations?days=7`, which is the Mission Control
  conversations card.

Current state: 874 unit tests, build green, chat QA harness 29 of 29.

## What to start on

Work in this order. Finish each one properly, with tests, before moving on.

1. **Check the shadow week.** Read the conversations card. If agent turns have
   accrued and no money gate has fired, tell me how many days of clean turns we
   have. If a gate fired, that is your first priority: find out why, from the
   `agent_turns` row, and fix it.
2. **The amber rows in `HANDOVER_V1.5.md` section 3**, in the order they appear
   there. They are bounded and each names its own file and gap. The two most
   worth doing are `propose_note` writing a customer fact without a confirming
   turn, which breaks the standing rule that the model never writes customer
   facts, and the old JSON conversation ring still being written at about twenty
   call sites in the processor although nothing reads it any more.
3. **Phase 3 preparation that does not need the gate:** retire the dead code
   listed in `HANDOVER_V1.5.md` section 4 item 4, and begin rewriting the
   source-text test locks as behaviour tests. Until those locks are rewritten
   nothing can be moved out of the processor, so this unblocks the whole phase.
4. **If the gate closes while you are working, start Phase 3 properly:** promote
   one language, watch it, then the next.

## How I want you to work

- Edit and test in the fast copy `~/Projects/wapay`, never install in iCloud.
  Rsync back and commit from the iCloud repo. The exact commands are in the
  handover.
- Run the unit suite, then the build, then the chat harness, in that order and
  never in parallel. Never push with a red test.
- Migrations are applied to production before the code that reads them deploys.
- Money rules are absolute and are listed in the handover. The AI proposes and
  never executes. The AI never states a balance or a status from its own head.
- My rules for how the chat reads are in the handover section 8. The short
  version: if you already know the answer, offer it rather than sending me back
  to a menu; name the option that costs least and say the price in the same
  breath; recommending is not doing.
- Tell me what you did in plain words. Do not show me code unless I need to go
  there.

## When you finish a phase, or when you are running out of room

Two things, in this order, and do not skip them.

**First, push as far as you can.** Do not stop at a tidy boundary if there is
more you can finish safely. I would rather you ship four things and tell me
about them than ship two and hold the rest.

**Second, update the phase map and show it to me.** The map is the picture I
open to see where the build stands. Its sources are in
`WaPay V1.01/docs/architecture/`. Regenerate it from the code, not from the
changelog: verify each row against the tree before you change its badge, the way
the last session's verification did when it refused to mark two rows shipped
that were not. Then assemble with `node docs/architecture/assemble.js` and
publish the resulting HTML to
https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB, passing that URL so the link
never changes. Tell me, in the same message, what moved on the map and why.

Then write the next handover, the same way `docs/HANDOVER_V1.5.md` was written,
and update this prompt file for the session after you.

## The questions I owe you an answer on

I will come back to you on these. Carry them, ask me again if I go quiet, and do
not block on them: everything above can proceed without them.

1. **My shadow week.** I am testing on my own number. I will send you the six
   messages and my starting balance. Expect screenshots.
2. **The Vercel plan**, Hobby or Pro. It decides whether the ten-minute pay-out
   sweep is a `vercel.json` cron or a trigger from elsewhere. Until I answer,
   the sweep runs daily and the fuel reconcile stays on the customer's turn, and
   that second one is a deliberate decision recorded in the changelog: do not
   move it before the drain exists.
3. **The WhatsApp template for pay-out outcomes.** I need to identify or submit
   an approved UTILITY template whose body takes amount, method and reference in
   that order, then set `WAPAY_TEMPLATE_PAYOUT_OUTCOME`. Until then a pay-out
   that settles more than a day after my last message reaches me only if direct
   send is on.
4. **OTT's sandbox.** Two live pay-outs both came back "Failed to retrieve
   record" with nothing paid. I am asking them what their sandbox actually
   returns. Do not change the reconciler's behaviour on a guess.
5. **The leaked Blu QA and Meta secrets.** Not yet rotated. Mine to do.
6. **The optional cost variables** `WAPAY_EVAL_PRICE_INPUT_USD_PER_M` and
   `WAPAY_EVAL_PRICE_OUTPUT_USD_PER_M`, dollars per million tokens, and
   `WAPAY_USD_ZAR`. They only turn on the cost figure in Mission Control.

Start by reading the four documents, then tell me what you found on the shadow
week and what you are doing first.
