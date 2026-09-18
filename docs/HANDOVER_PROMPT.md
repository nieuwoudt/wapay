# The prompt to start the next thread with

Paste everything below the line.

---

You are picking up the WaPay build mid-flight. Production is healthy and serving
build `1d9f1b8`. Do not start by exploring: read these four, in this order, then
start work.

1. `WaPay V1.01/docs/HANDOVER_V1.6.md` — written for you. The five rules that
   break things, where the build actually is, the first thing to check and what
   the last session found when it checked it, what changed, what to do next in
   order, how to verify you have not broken anything, and the traps that cost
   the last session time.
2. `WaPay V1.01/docs/AGENT_ARCHITECTURE_V2.md` — the architecture of record. It
   says what we are building towards. Section 13 is the shipped log, section 15
   the version table, section 11 the corrections. Every ship updates section 13
   and the visual map in the same commit. That is my decision, not a style
   preference.
3. `WAPAY_STATUS.md` — the living status. Bump its version when you change what
   is true.
4. `WaPay V1.01/docs/CHANGELOG.md` entries 47 to 52, and `docs/BUGLOG.md` #73 to
   #75. That is the last session.

**Where the build stands.** Phases 0 and 1 are live for every customer. Phase 2,
the Pay agent, is deployed but answers only numbers on
`WAPAY_AGENT_V3_MSISDNS`, which holds one number, mine. Phase 3 has not started,
but all of its preparation is now done: the dead code is retired and the worst
of the test locks are rewritten. Two Phase 4 items landed early, the notify
helper and the jobs table. Currently 895 unit tests, build green, chat harness
29 of 29, agent eval 100% on action in all eleven languages against a frozen
baseline.

**The gate into Phase 3 has two conditions and both must hold before anyone is
promoted off the pilot list.** Condition one is met: the agent matches the
two-tier engine in every language. Condition two has **not started**: as of the
last session `agent_turns` held zero rows, because the pilot gate had been
matching only one spelling of a phone number (BUGLOG #73). That is fixed, my
number on the list is correct, and the clock starts on my first message from it.

**What to start on, in order.**

1. Check the week: `GET /api/admin/conversations?days=7`, and read the `shadow`
   block. `started`, `cleanDays` and `cleanDaysNeeded` answer it directly. If
   turns have accrued with no gate fired, tell me how many clean days we have.
   If a money gate fired, that is your first priority: find out why from the
   `agent_turns` row and fix it.
2. The remaining source-text test locks, section 5 item 2 of the handover. Six
   surgery sites over four files, then about thirty ordinary text-assertion
   files. Keep the assertions that genuinely check source shape.
3. Habits in SQL is section 5 item 3 and is deliberately NOT done; read why
   before you decide to do it, and fix the eval fixture first if you do.
4. If the gate closes while you work, start Phase 3 properly: promote one
   language, watch it, then the next.

**How I want you to work.** Edit and test in `~/Projects/wapay`, never install
in iCloud, rsync back (never with `--delete`) and commit from the iCloud repo.
Unit suite, then build, then harness, in that order, never in parallel, never
push red. Migrations reach production before the code that reads them. Money
rules are absolute: the AI proposes and never executes, and never states a
balance or status from its own head. My rules for how the chat reads are in
handover section 8: if you already know the answer, offer it rather than sending
me back to a menu; name the option that costs least and say the price in the
same breath; recommending is not doing. Tell me what you did in plain words, not
code.

When you finish a phase, or when you are running out of room, two things in this
order. First, push as far as you safely can. I would rather you ship four things
and tell me than ship two and hold the rest. Second, update the phase map and
show it to me. Its sources are in `WaPay V1.01/docs/architecture/`. Regenerate it
from the code, not the changelog: verify each row against the tree before
changing its badge, the way the last two verifications did when they refused to
mark rows shipped that were not. Assemble with `node docs/architecture/assemble.js`
and publish the HTML to [Pay Agent Architecture](https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB)
passing that URL so the link never changes — and rsync to iCloud BEFORE you
publish, or you will publish the stale copy. In the same message tell me what
moved and why. Then write the next handover and update docs/HANDOVER_PROMPT.md
for the session after you.

**The questions I owe you an answer on.** Carry these, ask again if I go quiet,
and do not block on them.

1. My shadow week. I am testing on my own number and will send you six messages
   and my starting balance, with screenshots.
2. The Vercel plan, Hobby or Pro. It decides whether the ten-minute pay-out
   sweep is a cron entry or a trigger from elsewhere. Until I answer, the sweep
   runs daily and the fuel reconcile stays on the customer's turn. That second
   one is a deliberate recorded decision: do not move it before the drain exists.
3. The WhatsApp template for pay-out outcomes. I need an approved UTILITY
   template whose body takes amount, method and reference in that order, then
   `WAPAY_TEMPLATE_PAYOUT_OUTCOME` gets set.
4. OTT's sandbox. Two live pay-outs both returned "Failed to retrieve record"
   with nothing paid. I am asking them what it actually returns. Do not change
   the reconciler on a guess.
5. The leaked Blu QA and Meta secrets, not yet rotated. Mine to do.
6. The optional cost variables `WAPAY_EVAL_PRICE_INPUT_USD_PER_M`,
   `WAPAY_EVAL_PRICE_OUTPUT_USD_PER_M` and `WAPAY_USD_ZAR`. They only turn on
   the cost figure in Mission Control.
7. Whether to spend a pass on `apps/` and CI. The last session found `apps/` is
   dead weight and CI is probably red for reasons unrelated to the code, and
   wrote it up rather than touching it (handover section 9 item 8).

Start by reading the four documents, then tell me what you found on the shadow
week and what you are doing first.
