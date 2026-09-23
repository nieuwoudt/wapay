# WaPay — Changelog

*One dated section per meaningful commit, newest first. This local working copy has no `.git`, so history is reconstructed from `WAPAY_BUILD_TRACKER.md` and the known deploy commits; dates marked ~ are approximate (the commit hash is exact, the day is the tracker's). Keep this file updated per commit going forward — that is the version-control discipline the repo is held to.*

---

## 2026-09-23 (60) — A stale test that made HEAD red for four days, the handover corrected where the founder had overtaken it, and the promotion clock made trustworthy (BUGLOG #81)

Three things, all found by someone else looking.

**A peer session found HEAD red, and it was mine.**
`tests/agent-note-confirm.test.mjs` asserted the contract the founder reversed
on 19 September: that `propose_note` writes nothing without a confirming turn.
Five failures, all of them that old contract. Its replacement,
`tests/agent-memory.test.mjs`, had been green throughout, which is exactly why
I never saw it. It survived deletion because it was removed with `rm` in the
fast copy, and the rsync to the repo deliberately carries no `--delete` (a
`--delete` once wiped brand fonts that exist only in iCloud), so the removal
never reached the repo, `git add -A` staged nothing, and the file stayed
tracked. **A file is deleted with `git rm` in the iCloud repo.** The handover
carries the rule and the orphan check; a backstop in `agent-memory.test.mjs`
fails one test with that instruction if any test mentions `AGENT_NOTE_CONFIRM`
again.

**The handover was telling the next session to restore a behaviour the founder
had rejected.** It still read "propose_note no longer writes". Corrected in
place with his words and the reason, alongside what did NOT change: no note may
contain a digit, so no balance, amount, PIN or account number can enter memory.

**The promotion clock is measured over all time now.** It was computed from the
agent turns inside the card's `days` window, which looks right until the week
is nearly won: on day seven the money gate that reset the clock falls out of a
seven-day window, so the count would jump rather than reach seven honestly, and
a quiet week would empty the window and report "not started" for a clock that
had been running. Same fault as the original pilot gate, a number that cannot
tell "nothing happened" from "something is broken". The card also shows the date
it opens.

That change took the card down with a 500 for four minutes (BUGLOG #81), which
is BUGLOG #67's shape again: an identifier used and never declared, accepted by
both `node --check` and the build.

**Where the pilot week stands:** 4 clean days of 7, 21 agent turns, no errors,
no gate since the two false positives of 19 September. It opens 26 September if
nothing fires.

Unit 919/919, build green.

## 2026-09-23 (59) — Pay-out requests reach OTT: empty optionals off the wire, problem documents recognised, a sandbox probe for supplier questions

OTT could not find either of the founder's pay-outs because neither was
ever created: our recipient object carried every optional field as an
empty string and OTT's .NET model rejected `bank_id: ""` at validation
with HTTP 400, and the problem document's `status: 400` was read as an
unknown OTT payout status and parked the money (BUGLOG #80). Empty
optionals are now omitted on the wire and integer-typed fields sent as
numbers, with the hash unchanged; RFC 7807 problem documents are
recognised, a 400 that names fields releases the hold at once, anything
else keeps it for reconcile; FAILED rows keep the HTTP status and a masked
body; the customer is told the fault is ours. `POST
/api/internal/payout-probe` (internal key, sandbox host only, no ledger)
sends one request exactly as the withdraw flow does and returns the masked
wire request and raw response. Run on the sandbox the same evening it found
the second defect: OTT hashes an absent `bank_id` as its Int32 default "0",
not ""; with that rendering the sandbox answered status 100 "Payment
successful" (paymentReference 126141): the first request from WaPay's
client that OTT has ever accepted. This proves the WIRE FORMAT through the
probe, which writes no ledger and no row; no customer withdrawal has
completed yet, and the next informative test is one R50 withdrawal through
the chat. `DEFAULT_HASH_STYLE` carries the proven convention. Two PayShap
probes the same evening got no response within the 20 s client timeout
while Nedbank answered in 1 to 12 s; the probe's GET (GetPaymentStatus)
showed both PayShap requests were created (126142, 126143) and ended
status 97, failed at provider, so the format is right for both providers
and PayShap on the test environment is slow and then rejected on OTT's
side (asked in the email to OTT). Note for the record: HEAD carried five red
tests in `tests/agent-note-confirm.test.mjs` before this change; the test
was obsolete (it asserted the confirmation step the founder reversed on
19 September), the sources were right, and the peer session deleted it in
6992691.

## 2026-09-19 (58) — Phase 4: the daily pay-out sweep stops hiding its own backlog, and a recorded decision about what must NOT move into the queue yet

**The sweep takes five rows a day and never said how many it left.** With a
daily floor that is a real hole: the sixth parked pay-out waits another
twenty-four hours, and so does the seventh, and nothing anywhere says so. The
sweep now reports `backlog`, the eligible rows it could not reach, and the
cron logs it at error level when it is non-zero. It is a floor, never an
overstatement: if it is above zero there is at least that much waiting. That
number is also the one that decides whether the ten-minute schedule is still
optional, so it belongs in front of the founder rather than in a row count
nobody derives.

**What was deliberately NOT done, so the next session does not redo the
thinking.** The design puts the pay-out sweep, the retention purge and the
nightly integrity check into `agent_jobs`. Moving them today would add
indirection and buy nothing, because the drain runs inside the same daily cron
that already runs them inline: the same invocation, the same sixty seconds, one
more layer. The value of the async tier arrives with a ten-minute drain, and
that waits on the Vercel plan. This is the same test the previous session
applied to the fuel reconcile and recorded: ask who is waiting for it.

Also not done, and why: additive per-account journal columns are an indexed
read for a movement list that today spans five accounts, and they are a schema
change on the money tables. The cost is real and the benefit is invisible at
this size. A second model provider through the corpus needs a second provider's
key. The first partner module, bank-account verification, needs a partner.

Unit 910/910, build green, chat QA harness 29/29.

## 2026-09-19 (57) — Phase 3, everything that is not gated: the source-text locks are finished, and "the eval as the gate" is now a mechanism rather than a slogan

Promotion is gated on the founder's pilot week, so nothing was promoted and no
hook was deleted. Everything else in Phase 3 that does not need the gate is
done.

**The source-text surgery is gone: 19 sites on 18 September, 6 this morning,
zero now.** The last five each rebuilt a literal by scraping this file with a
regex, so each literal was hoisted to a named module-level constant and
exported: `PRODUCT_QUERY_INDICATORS`, `MENU_ASK_RE`,
`PRODUCT_QUERY_STOPWORDS_RE` and `ACTION_CAPABILITY`, plus
`onboardingOtpDisabled`, which was already exported from `@wapay/auth` and had
simply never been imported. Behaviour is unchanged; the tests now run the real
code. This was the thing the handover called the blocker on everything else:
nothing could move out of the processor while the tests read it as text.

**"Delete the regex groups with the eval as the gate" did not work, because the
eval did not exercise what would be deleted.** The golden corpus covers
airtime, data, electricity, send, redeem, deposit, balance and help in all
eleven languages, but REQUEST_MONEY, BUY_FUEL, the product-browse hook and the
category-context hook had **no cases at all**. Deleting those four would have
proved nothing. Ten cases were added, and
`tests/phase3-deletion-readiness.test.mjs` now holds the deletion list itself:
every hook must still exist in the processor, so the table cannot rot, and must
either have a covering case or be recorded as blocked WITH A REASON.

**Running it immediately found three of my own expectations to be wrong, and
one real limit.** Fuel is a founder pilot, so the registry correctly keeps
`start_fuel` out of the tool list and the agent explains rather than proposes:
the cases now assert THAT, which is the better property, and the fuel hook is
recorded as blocked until fuel goes live. A steps question may be answered or
answered-and-offered, which is the founder's own rule, so both outcomes pass.
And an isiZulu phrasing of "please pay me" was genuinely ambiguous, reading as
a withdrawal; it was rewritten to ask for the link.

The corpus is 166 cases. Action accuracy 98.8%, no regression against the
frozen baseline. Unit 910/910, build green, chat QA harness 29/29.

## 2026-09-19 (56) — Airtime's flow is fixed and proven; the vend cannot reach a real number yet, and that is now said honestly. The same lesson applied to every VAS product (BUGLOG #78, #79)

The founder's retest went all the way through for the first time: "buy r10
airtime", "mine" resolved to his own number, the confirm named R10 and MTN, his
PIN was accepted. Then the vend failed with "the network is rejecting this
phone number".

**That message was untrue, and the truth matters (BUGLOG #78).** `BLU_BASE_URL`
points at Blu's QA host, which only vends to four whitelisted numbers. Of every
airtime purchase ever attempted in production, exactly one succeeded: 2 January
2026, to `0840012300`, a QA test number. Every attempt to a real number has
failed, in January and again now. The flow was never the problem after #76; the
supplier account cannot serve a real customer. Both airtime and data now check
before the preview is requested, so no confirm is shown and no PIN attempt is
spent on something that cannot complete, and the copy says it is our supplier
account on test access, that it is our side and not theirs, and that their money
has not moved.

**The founder asked for the lesson to be applied across the board, so it was**,
and it found another bug before a customer did. `ELECTRICITY_METER` defaulted a
missing amount to R50 (BUGLOG #79), which would have bought power nobody asked
for; it now asks. `tests/vas-flow-invariants.test.mjs` locks four invariants
for every VAS product rather than one product at a time: the chosen amount
always beats anything re-parsed from a reply (with the real parse of a bare
`0787051175` pinned as evidence, R787,051,175.00); no flow may ever default an
amount, swept across the whole processor so the shape cannot reappear; "mine"
and nine other phrasings mean self and are understood before any cancel branch,
while "my mother" is not; and a supplier limit is explained as ours, before the
confirm and the PIN, with no partner named and no date promised.

Unit 904/904, build green, chat QA harness 29/29.

## 2026-09-19 (55) — The phase map moves, and a graded table of what a customer can actually buy

Founder: the map does not look like we are moving, and show me the products
that are really live, with a tested-end-to-end column and a grade.

**The map moves.** Four rows turned green since 17 September and the header now
names them: C13 (all five execute routes), C14 (the conversation store), C16
(the customer model) and C19 (Mission Control), with C18 on the 18th. The
build, the date, the you-are-here marker and the per-column tallies all move on
every ship, and the gate box says the pilot week is RUNNING with its clock at
zero rather than "open".

**The new table is graded on production evidence, not on what the code
supports.** Every figure is a count of real rows in the production database on
19 September. It is not flattering and it is not meant to be:

- A, real money end to end: card and EFT deposits (4 settled, newest 12 Sep),
  pay links (4 paid, newest created 19 Sep), and reading your own money back.
- B, proven but on a supplier's test host: OTT vouchers (3 issued, 4 gifts
  delivered, none ever redeemed at a real till) and WaPay for Business.
- C, proven once: send money (1), fuel (1, no wiCode has worked at a pump).
- D: airtime. It last vended successfully on **2 January 2026**, nine months
  ago, which is what the founder meant by "this used to work".
- F, nobody has ever completed it in production: data bundles (zero rows),
  electricity (zero rows), loading a voucher, and withdrawals (3 attempts, 3
  failed, no money has ever reached a bank).

The three F grades on data, electricity and airtime are one story: the code is
live, the Blu credentials are QA, and nobody has ever pushed a single purchase
all the way through. One end-to-end purchase each is what moves them, and that
is now the first item on the founder list.

Published as Version 8.

## 2026-09-19 (54) — The founder's live session: airtime could not be bought at all, and two true answers about his own money were suppressed (BUGLOG #76, #77)

Six messages on his own phone, and the `agent_turns` rows behind them, found
three things. Two were serious.

**Airtime was broken end to end (BUGLOG #76).** "buy R10 airtime", then the
number, then "❌ Amount must be between R5 and R1000", three times. The slot
parser reads a bare `0787051175` as both a phone number and R787,051,175.00,
which is fair enough because the digits are genuinely ambiguous; the guard
that was supposed to keep the chosen amount compared digit-string prefixes and
silently stopped working for any number typed in the normal 0-form. The state
now simply prefers the amount the customer already chose, which needs no
heuristic: the question asked was "which number". Answering "mine" cancelled
the purchase outright, because it carries no digits and the not-a-phone-number
branch treats that as "get me out of here"; one generous self matcher now runs
first and covers every natural way of saying it.

**Two true answers were being thrown away (BUGLOG #77).** "What do you know
about me" and "a breakdown of my spend for last month" both came back as the
fallback line. Both fired the RECEIPT gate, which is one of the three that
decide promotion, so each also reset his clean-day clock. The guard only ever
knew the context pack, although the design has always said a figure may come
from the record OR a tool result this turn; and zero was in no set, so an
honest "completed spending total: R0" was treated as an invented figure. Tool
figures are now merged in as QUOTABLE, never settled, so the agent may list and
total them while a success claim still has to name money the ledger says
settled.

**And a test that was passing for the wrong reason.** The harness scenario
"status question is answered from the record, never invented" assumed the QA
wallet had no payment. That run really does settle an R30 pay-out, so the
agent naming it was correct and the scenario had only been passing because the
guard was suppressing a true statement. It now allows the R30 and checks that
no figure the wallet never saw is called paid.

Unit 900/900, build green, chat QA harness 29/29.

## 2026-09-19 (53) — Memory: remember as much as possible, and actually USE it. The notes had never reached the model at all

**Founder direction, and it reverses yesterday's change.** "We want to
deliberately remember as much as possible from each and every interaction,
unless the user tells us not to remember anything." Yesterday `propose_note`
was changed to ask before keeping anything. Asking is the wrong default: a
question most people never answer means almost nothing is ever kept, and a
wallet that forgets what you just told it is the thing we are trying to stop
being. The confirmation turn and its state are gone.

**The bigger fault, found while fixing it: nothing we remembered had ever
reached the model.** The string `notes` did not occur once in
`lib/context-pack.js`. Notes were written to the profile and rendered only by
the "what do you know about me" command, so the agent composing a reply had
never seen a single one of them. Remembering was pointless. They are now part
of the CUSTOMER RECORD every turn, newest eight, under "What they have told
you about themselves"; the record cap rose from 1800 to 2600 characters to
make room, which is a deliberate trade of prompt tokens for a chat that knows
who it is talking to. The prompt now tells the model to record what it hears
and to use what is there, instead of telling it the tool remembers nothing.

**What did NOT change, because it is money safety and not preference.** The
model still writes no figure anywhere: `noteRejection` refuses any note with a
digit in it, so a balance, an amount, a PIN or an account number cannot enter
memory. The write happens in one place, `addNote` in `lib/user-profile.js`,
with one validator. The cap rose from 10 notes to 60.

**The customer's three controls are now three different things.** "Stop
remembering" sets `memoryOptOut` and every write is refused from then on,
while leaving what is already there alone; "what do you know about me" shows
them everything; "forget me" erases it. Conflating stopping with erasing would
delete a history when all someone asked for was quiet. The switch sits above
the loose memory matcher, so a request to stop can never be answered with a
disclosure of the data (the BUGLOG #71 shape).

The standing rule in `lib/user-profile.js` said "never by the model" and now
says what is true; the design record carries the change as a section 11 entry,
which is the documented way to move the target.

Unit 896/896, build green, chat QA harness 29/29.

## 2026-09-18 (52) — C19 shows held against the rail's float; a failed consent write is no longer silent; the record and the map redrawn at f91e317

**C19.** The conversations card reported what the parked pay-outs hold; the
design also asks for that figure against the float they are drawn from. The
panel now fetches the float SEPARATELY and renders without it: reading it is a
live call to OTT with its own eight second timeout, and a supplier having a bad
minute must not take the conversation metrics down with it. When held exceeds
the float the card says so.

**A consent write that fails is now loud.** `recordConsent` answers
`{ ok: false }` rather than throwing, and `handleS4PinSet` discarded both
returns, so a database hiccup during onboarding completed the account with no
consent rows and no alarm anywhere: a customer transacting with nothing on file
saying they accepted the terms. Onboarding still continues, because refusing
someone their account over a transient write is worse, but the gap is now
logged as `consent_record_failed` with the missing types.

**C11 is amended, not configured**, with the reasoning in section 11 of the
design record: a consent requirement would be a tautology (every customer who
can reach a capability already holds one, because `S5_COMPLETED` is only
reachable through the two `recordConsent` calls), it would not address the
cross-user risk it appears to (the control for that is the relationship gate,
already shipped), and one descriptor line would tell every customer to accept
terms they cannot accept in chat, because `account.consents` is never loaded on
the inbound path and `evaluatePolicy` fails closed. Recorded with it: the
`Consent` model has no `revokedAt` column, so `isUnrevoked` reads a field that
does not exist and the revocation branch is dead against production data.

**The record and the map.** Section 13 gains the 43 to 46 entries the previous
session never added and the whole of this one; the version table gains 1.7 and
1.8; section 11 gains three corrections. The phase map is republished as
Version 7 with C13, C14 and C19 moved to shipped, each verified against the
tree rather than the changelog: all five execute routes prove ownership before
the PIN and the internal-auth gate fails closed, the conversation store has
both sides and event rows with the ring gone, and both halves of the
conversations card are live.

Unit 895/895, build green, chat QA harness 29/29.

## 2026-09-18 (51) — The rest of C14: every money outcome the customer was not told about now reaches the agent, and a claimed gift can no longer strand (BUGLOG #75)

Entry 45 wrote the first of these producers. The handover asked for the other
two, and a verification pass found two more holes inside the one that shipped.

**The pay-out sweep.** There are three ways for the ledger to move and the
customer to hear nothing, and only one of them wrote the fact. An account the
sweep cannot address (no waId) simply `continue`d, and a throw inside the
notify block was logged and dropped. Both now go through one `recordUntold`
helper with the other, and all three are counted, so Mission Control shows
them rather than reporting a quiet night.

**The PayFast ITN.** A deposit that lands while the confirmation fails to send
left the balance higher and the agent unable to say why. The failure and the
throw now both write the ledger fact as an event turn. The happy path writes
nothing extra: `lib/say.js` already recorded the confirmation, and a second
row would read as two deposits.

**The gift claim, where an event row would have been the wrong answer
(BUGLOG #75).** A claim marks the gift DELIVERED before anything is sent. The
send-failure branch has always put it back, because a bearer PIN must never
strand; a throw anywhere else in the loop did not, so a gift could sit
DELIVERED with the recipient holding nothing and nothing to retry it. Every
claim is now tracked and the catch puts back whatever was never sent. No event
turn here on purpose: writing "a voucher was delivered" when the PIN never
arrived would put a false fact in the agent's memory.

Unit 895/895, build green, chat QA harness 29/29.

## 2026-09-18 (50) — The first batch of source-text locks rewritten as behaviour, and the two format bugs that exposed

Item 5 of the Phase 3 order, the one that blocks the rest: about 36 test files
read the processor as text, so nothing can move out of it. The worst kind is
the source SURGERY: find a function by string offsets, slice it out, and `eval`
it inside a `new Function` with hand-written fakes for whatever it calls. There
were 19 of those. There are now 6.

**Thirteen functions are exported from the processor, in place.** The design
record has said since day one that relocating a function breaks the locks and
exporting one where it stands breaks none, and that is exactly what this does:
the file is unchanged except for an export list at the bottom. The tests import
the real functions and run them. No database and no model key are needed,
which was the open question: the processor imports cleanly and these matchers
are pure.

**Two real bugs fell out of it immediately**, both of the kind this style of
test is built to hide.

- `tests/phase2.test.mjs` injected a fake `formatRands` that printed `R30.00`.
  The real one prints `R30`. The test had been asserting a format the product
  has never produced.
- `tests/founder-feedback-0825.test.mjs` and
  `tests/intent-switch-payment-link.test.mjs` each stubbed `matchFuelPurchase`
  and `matchOttVoucherSelfRequest` with two-line approximations of matchers
  that are now much more particular, and then tested the intent-switch
  detector against those approximations. The second file's own comment claimed
  "the REAL matcher feeds the REAL switch detector, no stubs". It stubbed two.

That is the argument for the whole migration in one place: a test of a COPY of
the code, evaluated in a vacuum against fakes, passes while the real function
is wrong, and its fakes drift from what they stand in for.

Converted: fuel-flow, ott-voucher-self, payment-requests (two sites),
admin-console, business-portal, founder-feedback-0825,
intent-switch-payment-link, phase0-review (two), review-2026-09-18 (two),
chat-qa-findings, orchestrator-routing (two) and phase2. What remains is six
sites over four files that reach for something which is not a top-level
function: a const array inside a function body, two object literals and a
lookup map. Those need their own step and are not in anyone's way.

Unit 892/892, build green, chat QA harness 29/29.

## 2026-09-18 (49) — Phase 3 prep: the three dead things deleted, each of them a second way to do something the product already does once

Item 4 of the Phase 3 order, the one the handover marks safe to do at any time
because it only reduces risk.

**A second WhatsApp client.** `WhatsAppClient` with its own `sendTemplate` and
`sendText`, a parallel `Templates` builder, `formatCurrencyCents`, and an
orphaned `templates.ts` beside them. A second way to send is a way to send
that `lib/say.js` does not record, so a customer could be told something the
agent's memory never sees. One sender now: `send.ts`, and in the app
`lib/say.js` over it.

**The bypassing ledger writer.** `postBluDeposit` set no idemKey, so nothing
stopped it double-posting; it incremented wallet balances directly with an
`updateMany` that would have credited BOTH of an account's wallets; and it
posted to account codes (`Clearing:Blu`) that no reader in this product
knows, so the nightly integrity check could not have seen its money. It
violated four of the ten money rules in `CLAUDE.md` at once. The file held
nothing else, so it is gone and the barrel no longer re-exports it.

**A model for a table that never existed.** `UserSavedAccount` was in the
Prisma schema, mapped to `user_saved_accounts`, which no migration in the
repo ever creates and no code ever reads.

All three had exactly one importer, `apps/api`, which is outside
`build:packages` (it filters `./packages/**`) and cannot compile anyway: it
imports two symbols from a file that is checked in as `yoyo.ts.disabled`.

**What was NOT done, and why it is a founder call.** The verification pass
found that `apps/` as a whole is dead weight, but removing it touches
`pnpm-workspace.yaml` and two root scripts, and four tests reach into package
`dist/` folders by relative path while CI never runs `build:packages`. That is
a bigger change than this row, with a real chance of a red build for reasons
unrelated to the agent. It is written up in the handover instead.

Unit 892/892, build green, chat QA harness 29/29.

## 2026-09-18 (48) — The model stops writing customer facts, and the JSON conversation ring is deleted (BUGLOG #74)

Two amber rows of C14 and C16, and between them the last two places where the
chat wrote memory outside the one store that owns it.

**propose_note proposes.** It used to write the note into the customer's
profile the moment the model called it, which made the model the author of a
customer fact and broke the rule at the top of `lib/user-profile.js` that every
key there is written deterministically at a success point and never by the
model. The tool is now pure: no database, no clock, no context, and `accepted`
is false on every path it can return. It hands back a pending note, the agent
loop ends the turn on it (below the proposal check, so money always wins, and
above the reply check, so the model cannot narrate a memory it has not got),
and the runtime asks the question in its own words: `🧠 Want me to remember
this? "…" Reply yes to keep it, or no.` The note text is model-authored, so it
goes through the same output gate as any other model text, and the question is
parked only once the customer has actually seen it. A yes calls the new
deterministic writer `addNote`; a no keeps nothing; anything else keeps nothing
and is answered as a fresh message, so a question asked at the wrong moment
never swallows the next thing said. The idle expiry and the home trigger both
sit above the hook, so a yes typed the next morning writes nothing. The
composition rules now tell the model the tool remembers nothing by itself.

**The legacy conversation ring is gone.** `Account.conversationData.history`
held the last ten messages of each chat and was written at **63** call sites in
the processor, not the twenty the handover recorded, and read at none. Memory is
`conversation_turns`, recorded by construction on every send through
`lib/say.js`. Every one of those 63 writes was also a read-modify-write of the
whole `conversationData` column, which carries live flow state and the inbound
dedupe list, so each was a chance to clobber them. All 63 are deleted, with
`addToConversationHistory` and the never-called `getConversationHistory`.

**And the erasure gap it hid (BUGLOG #74).** "Forget me" erased the turns table
and the customer's notes, and never touched the ring, so a customer who asked
to be forgotten kept ten of their own messages. Migration
`20260918_drop_conversation_ring` drops the key from every existing row, applied
to production before this code, and the erasure drops it per account from now
on. Only that key: the flow state and the dedupe list in the same column
survive.

Three tests that asserted the ring writes exist now assert the thing they were
really about: that both sides of a turn reach memory, and that what is
persisted is redacted.

Unit 889/889, build green, chat QA harness 29/29, agent eval 100% action in all
eleven languages against the frozen baseline, no regression.

## 2026-09-18 (47) — The pilot week could not have started: the list matched one spelling of a number, and an empty week could not be told from a broken one (BUGLOG #73)

The first read of the shadow week returned zero agent turns over seven days,
with the list live and one number on it. The messages were landing and being
answered; `agent_turns` had simply never received a row since the table was
made.

**The gate now matches the number, not the spelling.** `agentV3For` compared
the list entry to Meta's wa_id as raw text. Meta sends `27787051175`; a human
typing that number into the Vercel dashboard will as readily write
`+27787051175`, `0787051175` or `+27 78 705 1175`, and three of those four
matched nobody while the bot went on answering normally from the old engine.
The list moves to `lib/shadow-list.js` and matches on the canonical digits
through `normaliseMsisdn`, which every other number in the product already
goes through. It never widens to a different number: a prefix, a superstring
and a neighbouring number still do not match.

**An empty week now says why it is empty.** The Mission Control card reported
how many entries the list held and nothing else. It now shows each entry by
its last four digits with whether the product can read it and whether an
account has ever written from it, in red when either is false, beside whole
clean days so far against the seven the gate needs. The clean clock starts at
the first agent turn and is reset by the newest money gate, so the promotion
condition is a number on the card rather than a judgement someone makes from
a row count.

**The first source-text lock is rewritten as behaviour.** The old test sliced
`agentV3For` out of the processor with string offsets and `eval`ed it, so it
asserted the shape of a line of code and would have passed unchanged while the
pilot matched nobody. `tests/shadow-list.test.mjs` imports the module and runs
it. `tests/phase2.test.mjs` keeps only the two assertions that need the source:
the processor uses that gate, and never grows a looser one of its own.

Also: the chat harness's airtime scenario was flaky by construction. "buy R30
airtime" has two legitimate landings, and the one where the agent fills the
number from the customer's own record reaches the preview route over HTTP,
which the harness cannot serve. The flow doing the right thing read as a
failure every other run. Reaching the preview now counts as the airtime flow
answering; the menu and no-execution assertions are unchanged.

Unit 878/878, build green, chat QA harness 29/29.

## 2026-09-18 (46) — The async tier: agent_jobs and its drain (C20), and a decision recorded about what does NOT belong in it

One table for work that must not run while a customer waits, drained by the
nightly cron. lib/jobs.js: enqueue is idempotent on kind and key, so a per-turn
hook can queue freely; claims are atomic, so two drains cannot take the same
row; a claim older than ten minutes is reclaimable, because a serverless worker
can vanish without ever writing DONE or FAILED; a job that exhausts its
attempts is FAILED and left for a human, because a job retried forever is an
outage wearing a queue for clothes; backoff is exponential and capped, so a
supplier having a bad hour is not hammered. Nothing in it throws at the caller.
Migration 20260918_agent_jobs applied to production before this code.

**The fuel reconcile was moved into the queue and then moved back, on purpose.**
It looks like background work, and a test caught what that framing costs: it
only runs for a customer who already has a stuck fuel purchase, and it is the
turn on which their voucher code can be delivered. Queueing it would have
traded that customer a same-turn delivery for a latency saving nobody else was
paying. It stays inline and queues a belt-and-braces job only when it resolved
nothing, so the work still completes if the turn dies. It moves to the queue
when a ten-minute drain exists. The test to apply to anything else: ask who is
waiting for it.

Unit 874/874, build green, chat QA harness 29/29.

## 2026-09-18 (45) — Handover doc for the next session; two partial rows closed: the internal-auth gate fails closed in production, and a money outcome nobody was told about reaches the agent

**docs/HANDOVER_V1.5.md** is new: the five rules that break things, where the
build actually is, every amber row on the phase map with its exact gap and
file, the order Phase 3 must happen in, how to know you have not broken it,
the traps this session hit, and the open items that need the founder rather
than an engineer. Written so a fresh session can continue without this thread.

**C13.** lib/internal-auth.js passed every request when
WAPAY_INTERNAL_API_KEY was unset, which was correct when nothing set it and
dangerous now that everything does: one deleted variable would have silently
reopened five money routes. It now answers 503 in production and keeps the
bypass everywhere else. Verified before shipping that all five execute routes
already answer 401 to an unauthenticated call, so nothing was closed on us.

**C14.** Nothing anywhere wrote a turn with role event, so a pay-out that
settled at 02:00 whose notification failed left the ledger moved and the agent
unaware: its next turn read a movement list that had changed for reasons it
could not explain. recordMoneyEvent in lib/notify.js writes the ledger fact
into the same history the agent reads, and only when nothing reached the
customer, so a delivered notice never appears twice.

Unit 866/866, build green.

## 2026-09-18 (44) — The two gaps the map verification named: the eval has a frozen baseline that fails on regression, and the pay-out half of the Mission Control card reports what is held

A five-agent pass verified every row of the phase map against the code before
redrawing it, and refused to mark two rows shipped. Both gaps are closed here.

**C18.** The runner already exits non-zero on a regression, but nothing froze a
baseline to compare against, so the flag was one a human had to remember.
The 18 September run is now docs/testing/agent-eval-baseline.json and
pnpm eval:agent passes it automatically. pnpm eval:orchestrator runs the
two-tier baseline beside it.

**C19.** The card listed parked pay-outs without the one number a human acts
on: what they are holding. It now reports the total of amount plus fee across
every parked row and how long the oldest has waited, and says plainly that
this money has left the customer balance without reaching them, to be read
against the supplier float on the card below.

Unit 864/864, build green. The phase map is republished as Version 5: the
eval condition of the promotion gate reads MET, the pilot list carries its
first number, C18 moves to shipped and C19 to partial.

## 2026-09-18 (43) — notifyCustomer: the one message WaPay starts on its own now uses a rail that crosses the 24 hour window (BUGLOG #72)

C21 of the design record. The pay-out sweep runs at 02:00 and from a cron, so
the customer it tells is usually outside their window, where Meta accepts a
free-form send and then drops it. `lib/notify.js` reads the window from the
last inbound turn and picks the rail: a plain text inside it, then Direct Send,
an approved UTILITY template and free-form outside it. Every rail records the
assistant turn, so the agent can see what the customer was told while away.
The template name is `WAPAY_TEMPLATE_PAYOUT_OUTCOME` and its three body
parameters are amount, method and reference, produced by `payoutOutcomeParams`
beside the message it mirrors so the two cannot drift.

Also in this entry: the Mission Control cost figure now uses the same two env
names and the same unit as the eval runner (`WAPAY_EVAL_PRICE_INPUT_USD_PER_M`
and `WAPAY_EVAL_PRICE_OUTPUT_USD_PER_M`, dollars per million tokens), with an
optional `WAPAY_USD_ZAR` to show rands instead of dollars. They were two
different names and two different units for the same thing, which is how a
wrong number gets set.

Unit 862/862, build green, chat QA harness 29/29 with credit restored.

## 2026-09-18 (42) — The work order from the streamlining review: the withdraw flow offers at every refusal, cash stays cash, "no" no longer cancels, and an erasure is never answered with a disclosure (BUGLOG #71)

Five read-only readers swept every flow, every product choice, the memory
answer and every outbound sender against the founder's principle; one judge
merged 49 findings into a ranked work order. Its first correction mattered:
the branch his own repro reaches today is NOT the one this morning's fix
touched. With R66 and cash at an Absa ATM chosen, the affordability check
added in `4b3f478` returns at the METHOD step, and that step still listed menu
numbers. Five items are closed here.

**A1, the method step offers.** "With R66 you cannot use cash at an Absa ATM
yet: the R50 minimum plus the R18 fee is R68. Cash at a Nedbank ATM starts at
R20 and you can take up to R48 today. I will need your ID number for that one.
Reply YES to use that, or say add money." One method, named, with what it can
actually pay and any extra step it adds.

**A2, the offer keeps the shape the customer asked for.** Someone collecting
cash is offered cash, not sent to find a bank account, even when a bank rail is
cheaper. It crosses only when nothing in the same family carries the amount,
and says so when it does.

**A3, "no" keeps the withdrawal alive.** Every new offer invites a yes, and
`CANCEL_RE` matched "no", so a person answering the question would have thrown
the whole withdrawal away. A bare no now clears the offer and re-asks;
"cancel" and "stop" still cancel.

**A4, the ceiling is a question, priced at the ceiling.** "With the R18 fee,
R50 is the most you can take by cash at an Absa ATM right now (R50 to you, R68
off your balance). Withdraw R50? Reply YES, or type a smaller amount." The fee
is quoted at the ceiling because the cash fees are banded, and YES re-validates
against the balance as it stands at that moment.

**A17 is BUGLOG #71**, an erasure answered with a disclosure, shipped this
morning and caught before any customer met it.

The judge's three rules are now the composition policy: if you already know the
answer, offer it rather than asking the customer to find it; best matching
product at the lowest rate, in the shape they asked for, with the fee stated in
the same breath; and recommending is not doing, so money still goes preview,
confirm, PIN, execute with the number recomputed on yes.

**The Phase 3 eval gate is met.** The full agent eval, 156 cases across all
eleven languages: 99.4% overall, 100% on action and outcome, no errors, p50
1.7 s, p95 4.8 s. On the 132 golden cases the two-tier engine also scores
100%, so the agent matches the engine it replaces in every language. What
remains before promotion is the week of shadow turns with no money gate firing,
which the new Mission Control card now measures.

**Mission Control gains its conversations card (C19).** Customer messages and
WaPay replies, agent turns and their share, latency p50/p95, cost per turn,
outcomes, every gate that fired (RECEIPT, PARTNER and BETTING in red, because
those three are the promotion gate), and every pay-out still parked with the
rail with its age and when it was last checked. New route
`pages/api/admin/conversations.js`, read-only and admin-gated, reading only
aggregates and the already-masked `agent_turns` payloads.

Unit 857/857, build green. The chat QA harness run that followed hit a hard
stop: the OpenAI account ran out of credit mid-run (429 credit_balance_exhausted,
after the 156-case and 132-case evals above), so every model path fell back.
Degraded mode behaved exactly as designed, no crash, no invented number, the
guards and the record still answered, and the four red scenarios are all
model-dependent. Re-run the harness once the account is topped up.

## 2026-09-18 (41) — The founder's streamlining review: the bot recommends the one next step instead of sending the customer back to a menu; lists, not paragraphs; the memory question is answered (BUGLOG #70)

From his first live session on the new build. His words: "It's too systematic.
It already knows which option to choose ... You should just recommend it ...
rather than recommending going back to the menu. How can we save the
customer's time, with all product recommendations ... to find the best
matching product for our client at the lowest rates, always."

Three changes.

**The withdraw flow offers, it does not bounce.** Below the minimum, above the
maximum, or over what the balance covers with the fee, the flow now names the
one method that carries the amount the customer asked for, cheapest first, and
offers it as a yes or no: "R30 is below the R50 minimum for cash at an Absa
ATM, but cash at a Nedbank ATM takes R30 for a R18 fee, so R48 leaves your
balance. Reply YES to switch to that, or type another amount." YES switches and
keeps the amount; the menu is still there behind "back" for anyone who wants
it. When nothing else can carry the amount the refusal states the minimum and
asks for an amount, with no menu list.

**Lists, and the best option named, for every customer.** The shape rules that
the agent already followed are now a shared block, `REPLY_SHAPE` in
`packages/ai/src/orchestrator.ts`, carried by the two-tier engine that still
serves everyone: three or more items are a list one per line under a header,
"accepted at" and "not accepted at" are separate blocks, and, new in both
prompts, when the model already knows the single best next step it offers that
step as one yes or no question, and when there is more than one way to do
something it names the one that costs least or arrives soonest and says why.
The reply rule that capped every answer at one to three sentences is gone; it
was why "Where can I spend my OTT voucher?" came back as a paragraph.

**The memory question is answered** (BUGLOG #70).

Also recorded from the same session: the 23:00 message he asked about was his
own "Home" at 23:00 SAST, answered in two seconds; nothing sends a customer a
message on a schedule. His R20 Nedbank test pay-out was released by the
reconcile after OTT answered "Failed to retrieve record" for the second time in
three days, so nothing was paid and the money is back.

Unit 852/852, build green, chat QA harness 29/29 (two new scenarios: the
full-history sentence, and the OTT answer as a list).

## 2026-09-17 (40) — Three gaps from the architecture verification closed: execute-route ownership order for fuel and voucher gifts (BUGLOG #69), the output gate for every customer, the on-inbound reconcile covers INIT

Four read-only verifiers established the status of every component of
`docs/AGENT_ARCHITECTURE_V2.md` at HEAD with file and line evidence (the
table feeds the phase map). Three of their gaps are closed in this entry:
the fuel and voucher-gift execute routes prove ownership before a PIN
attempt is spent and the voucher route no longer refunds a crash after OTT
has issued the voucher (BUGLOG #69); the betting, partner-name, URL and
length gate now runs on every customer's model reply in the dispatcher, not
only behind the shadow list (a blocked reply becomes the fact line from the
record, never a menu); and the on-inbound pay-out reconcile also picks up a
pay-out stuck at INIT for more than five minutes, through the INIT
reconciler, as section 13 already claimed. The rest of the verifiers' gaps
are recorded in the design record's section 13 as the Phase 3 and 4
backlog.

## 2026-09-17 (39) — Withdraw: a method the balance cannot cover is named and refused with the reason (BUGLOG #68)

From the founder's first live test after the hotfix. With R66, cash at an
Absa ATM (R50 minimum plus R18 fee) was pickable, then "50" was refused as
too much and "48" as too little. The flow now knows what each method needs
with the fee: the menu marks the ones the balance cannot cover, the pick (or
the agent's proposal) is refused with the reason and the methods that work,
the amount question states the real ceiling, and the entry gate counts the
fee. A bare option number typed at the amount step ("3" after "choose *3*")
now switches the method instead of being read as R3. Locks in
`tests/payout-affordability.test.mjs`; three older locks that
expected the unreachable "R3000" ceiling now expect the affordable one.

## 2026-09-17 (38) — Hotfix: the mute bot (BUGLOG #67); the webhook route is now loaded and run by a test

One line: `runWithSendScope` added to the webhook's import from `@wapay/whatsapp`.
Since the Phase 0 deploy the wrapper had been used without being imported,
so every text turn threw a `ReferenceError` before its first send, released
its claim, answered 500 and was redelivered into the same error; customers
saw "typing" and nothing else. A new test (`tests/webhook-route-runtime.test.mjs`)
signs a real payload and runs the route with its collaborators mocked, and
fails on the broken file. A `checkJs` sweep of every JS file changed since
`6f449eb` found no other undeclared identifier. Unit 840/840, build green.
The Phase 0, 1 and 2 changes themselves are unaffected: the harness had
exercised them end to end against the live database; only the route wrapper
around them was never executed before production.

## 2026-09-16 (37) — Phase 2: the Pay agent is wired behind a shadow list; one model call over the record and typed tools; the first live eval

Phase 2 of `docs/AGENT_ARCHITECTURE_V2.md`. For a number on
`WAPAY_AGENT_V3_MSISDNS` (comma separated, exact match, unset means nobody)
the processor skips the question hooks, the intent regexes and the two-tier
engine and runs `handleAgentTurn`: the pre-model guards first (a 16-digit
voucher PIN, a pay-request code, "voucher pin 1234" go straight to the
existing flows and never reach the model), then the per-customer budget
(`WAPAY_AGENT_TURNS_PER_HOUR`, default 60; the cap answers with one line and
no model call), then the context in one `Promise.all` (the last 12 turns of
both sides, the profile, the customer record), then `runAgentTurn` from
`@wapay/ai` with the registry lines, the fee facts, the record and the
typed tools from `lib/agent/tools`. Four outcomes: a proposal goes through
`dispatchOrchestratorAction` with an empty reply, so the same preview,
confirm, PIN and receipt steps run as for the regex router (a new
`case 'WITHDRAW'` hands to `handleWithdrawStart`, re-checks the per-customer
pay-out gate and re-validates its slots; the two-tier engine cannot produce
it); a reply or a clarifying question passes `sanitizeUserText`, the output
gate (betting, partner name, URLs, dashes, length) and the provenance guard
before one send, and a blocked reply becomes a fact-built line from the
record; a clarify parks `AGENT_CLARIFY` with the pending intent and the next
message goes back to the agent with that intent in its record (a de-listed
number falls through to the normal router); a model error sends the same
fact-built line, never "I didn't catch that". Every path writes an
`agent_turns` row (masked WhatsApp id, redacted payloads). The agent prompt
gains one rule: a customer who already holds a voucher gets the redeem flow,
not the walkthrough (the one miss in the first eval). First live eval
(`scripts/eval-agent.mjs --limit 12 --lang en`, gpt-5.5): 11 of 12, p50
1.9 s, p95 3.7 s, about 4,500 input tokens per turn; report in
`docs/testing/agent-eval-2026-09-16-partial.md`. Nine harness scenarios run
under the shadow list (the founder review-4 asks, a send and an airtime
proposal landing in the existing confirm steps, the guard and the budget).
Locks in `tests/phase2.test.mjs`. Nothing changes for a number that is not
on the list. To switch it on for one phone: set `WAPAY_AGENT_V3_MSISDNS` in
Vercel and redeploy; to switch it off: unset it.

The pre-ship read-only review (money safety, secrets, injection, state,
budget, gates, failure modes, copy) confirmed that no path moves money or
mints a confirm or PIN state outside the existing flows, and produced the
fixes shipped in the same commit (BUGLOG #65, #66; locks in
`tests/phase2-review.test.mjs`): labelled PINs and wiCodes in prose are
redacted before memory and before the model, and the agent sends the model
the redacted line; a bare 12-digit OTT PIN is a guard; raw inbound text is
redacted in every log line; the budget counts model turns only (a refused
turn cannot starve the customer); a blocked clarifying question is never
parked as a pending intent; the fallback line is localized on every path; a
failed WhatsApp send throws so the claim is released and Meta redelivers;
the ledger row follows the send; 6 s per model call; a shared contact
answers the agent's "who?"; the gift-claim memory line carries neither the
sender's chosen name nor the PIN (`recordAs` on the say wrapper); the
betting lexicon gains lottery, powerball, sportsbook, bookie, punt, and the
partner gate catches the name spelled out; the withdraw method enum is the
pay-out module's; the prompt says data is never instructions; the loop takes
a pending intent only from the cleaned tool result.

## 2026-09-16 (36) — Phase 1: every surface renders from the registry; habits in the record; "what do you know about me" and "forget me"; nightly balance integrity; turns follow their account; the Phase 2 modules land dormant

Phase 1 of `docs/AGENT_ARCHITECTURE_V2.md`. The home card, the Help Menu,
the no-model fallback and the product list render their product lines from
`lib/capabilities.js` (one `liveFor` per capability; the processor's
`fuelLiveFor` delegates to the registry's), and the onboarding welcome and
PIN-reset copy no longer carry a hand-written product list. Every AI turn's
knowledge block gains WHAT THIS CUSTOMER CAN DO TODAY, one line per live
capability with the exact start command and fee. The customer record gains
habits computed from the ledger rows (usual airtime number and amount, last
meter tail, deposit rail, activity in 30 days; masked, never a full number).
"What do you know about me" renders the record in the customer's words;
"forget me" erases the conversation memory and notes and keeps the financial
records. A nightly integrity check re-derives every wallet from the journal
and logs drift (`lib/ledger-integrity.js`, inside the daily cron with a
deadline). `conversation_turns` now cascades from its account (migration
`20260916_conversation_turns_fk`, applied to production first; orphans from
earlier harness runs removed). The Phase 2 modules are in the tree but not
wired: `lib/agent/tools/*` (read and proposal tools with strict schemas),
`packages/ai/src/agent.ts` and `prompt.ts` (the one-loop agent and its
prompt), `lib/agent/guards.js` (pre-model guards and the output gate),
`lib/agent/turn-ledger.js` with the `agent_turns` table (migration applied),
and `scripts/eval-agent.mjs` with 24 new eval cases. Unit 824/824 (73 → 76
test files), build green, chat QA harness 19/19. Test locks that asserted the
hand-written home and help copy now assert the registry wiring.

## 2026-09-16 (35) — The moat, Phase 0: the customer record and both sides of every turn reach the model; the open execute routes closed; pay-outs stuck at INIT reconciled; typing indicator; the registry and the policy engine

The architecture review of 2026-09-16 (`docs/AGENT_ARCHITECTURE_V2.md`: 6
readers, 4 designers, 3 judges, 1 synthesis, 24 refuters, 1 critic, page
"Pay Agent Architecture") found the agent on paper right and unbuilt, and
found live exposure the plan had not listed. This commit is Phase 0 of that
document. Safety: the airtime, data and electricity execute routes require
the internal key, check the preview's owner before the PIN, and release the
hold on a crash unless the provider delivered (BUGLOG #56); every wallet-PIN
state accepts only PIN-shaped input (#58); balance readers select the SPEND
wallet (#59); the AI's cash-out position follows the per-customer pilot list
like every other surface, with `orchestrate()` taking `withdrawLive` (#57);
a turn that throws before sending releases its message claim and answers 500
so Meta redelivers, and a typing indicator goes out right after the claim
(#60); pay-outs stuck at INIT are reconciled with GetPaymentStatus only,
swept by `GET /api/cron/payout-reconcile`, by a daily floor in the VAS sync,
and on the customer's next message (#61). The spine: `lib/context-pack.js`
reads the customer's balances, held amounts, last movements with references
and states, the pending pay-out, open links and saved people in one batch
and renders a KNOWN CUSTOMER FACTS block into every AI turn; `lib/turns.js`
and `lib/say.js` record both sides of every turn (and the out-of-band
senders) into the new `conversation_turns` table (migration applied to
production before this deploy), and the model now sees the last 12 turns of
both sides with the current message excluded (#62); the receipt guard accepts
a receipt-shaped sentence only when every rand figure in it came from the
record; "Transactions" (the home-card line with no handler), "my
transactions", "what did I buy", "my withdrawals" and "who paid my link" are
answered with ten rows from the ledger; "did my payment go through" names the
newest movement and offers the other when two happened in the last day.
Foundations for Phase 1 and 2: `lib/capabilities.js` (the registry, tested
against the current home and help copy, not yet wired into them) and
`lib/policy.js` (allow, deny, require; wired before a proposed flow starts and
before a withdrawal). Before push a five-lens read-only adversarial review (money, privacy,
runtime, behaviour, tests; 42 findings, each put to a refuter) confirmed 31,
all fixed in the same commit: request-level OTT status codes never release a
hold (#63); a PIN typed inside a sentence never escapes to the model (#64);
login codes are never stored; bank account and ID numbers typed in the
withdraw flow and grouped voucher PINs are redacted; the released message
claim also clears the processor's own dedupe ring and a swallowed throw is
rethrown when nothing was sent, so Meta's redelivery actually happens; the
typing indicator runs alongside the turn; the send counter is scoped per
turn; the on-inbound reconcile is throttled to ten minutes, uses a 3 s
timeout and leaves status questions to the status handler; the pending
pay-out is looked up directly; received gifts use the index; the customer
record shows the spend balance and the cash balance separately and names
saved people by first name only; the receipt guard admits only settled
amounts and requires a success claim to name one; the withdraw and proposal
gates leave KYC to the flow's own VERIFY step; a delivered-but-unsettled
vend is marked RECONCILE. Unit 737/737 (63 → 73 test files), build green,
chat QA harness 19/19.

## 2026-09-16 (34) — Pay-outs can be reconciled with OTT; "did my payment go through" knows about withdrawals; the processor must load

The founder's first live PayShap (R50, 2026-09-15 21:52, reference
WPC15800A7BD6637) came back from OTT's sandbox with a status code outside
our table and parked as PENDING with nothing recorded, no webhook and
nothing that could ever ask OTT again; the next morning "did my payment to
my FNB account go through" was answered with a weeks-old R20 deposit
(BUGLOG #53, #54). The PENDING record now keeps OTT's status code and a
masked excerpt of the body and flags UNKNOWN for reconcile;
`reconcilePayout` asks GetPaymentStatus and applies only a known terminal
answer (100 settles, a failure code releases and returns the money; 98/99
and unknown codes leave the hold and are stamped; transport failures change
nothing; never a second PerformPayout); `reconcilePendingPayouts` sweeps
rows older than a grace period; `GET /api/internal/payout-reconcile`
(internal key, `?reference=` for one) runs either and tells the customer
with the webhook's own wording, now a single shared function. The chat's
status handler reads the newest deposit AND the newest pay-out, answers
about the one the words point at, and reconciles a PENDING pay-out live
before composing the reply; "did my withdrawal go through" reaches it
deterministically. A parameter name collision in that handler passed 633
unit tests and was caught only by the build (BUGLOG #55): the suite now
imports the processor. Suite 634/634; build green; chat QA harness run
before push.

## 2026-09-15 evening (33) — Idle states expire, greetings go home, short specific answers with a YES offer, minimum guidance; FNB eWallet + Nedbank cardless; harness drives a real pay-out

Founder review 3 (BUGLOG #50, #51, #52): a flow parked for twelve hours
answered "Just the amount" to "Hello"; capability questions got the same
four-step wall; "20" against Absa's R50 minimum got the same line three
times. Conversation states now carry a timestamp and expire after thirty
idle minutes; hi / hello / home / menu always go home; every knowledge-base
topic has a short question-aware answer plus an offer, YES starts the flow
(`HOWTO_OFFER`), "how do I" gets the walkthrough with per-bank collection
steps; the below-minimum message names the methods that allow the amount and
"back" changes method. FNB eWallet (OTT 1) and Nedbank Cardless (OTT 4) are
payout methods (Nedbank priced per Annexure A, FNB assumed equal to CashSend
until priced). The chat QA harness now funds the QA wallet through the
ledger, seeds a PIN and mocks the OTT rail, and drives a complete FNB eWallet
pay-out end to end, tearing its ledger rows down afterwards.

## 2026-09-15 (32) — Payouts testable on OTT's sandbox; the bot explains instead of launching; OTT acceptance by name

OTT activated PayShap Account, ABSA CashSend, Nedbank Cardless and FNB
e-wallet on the test merchant and loaded a float. Our mapping read the
wrong key and saw nothing (BUGLOG #46); fixed, and the live provider now
decides the required fields (ID number for every provider, account number
+ branch code for PayShap) and the limits (R50 minimum) before any ledger
call (#47). The chat offers only methods with a live provider and asks for
the ID number. Founder review of the conversation: capability questions
are now answered from a per-transaction knowledge base (`lib/how-it-works.js`)
instead of starting flows, in-flow questions are answered and the step
repeated (#48), and "is it accepted at Checkers?" gets a no by name from
researched acceptance data (`lib/ott-acceptance.js`, #49). Reference document
generated from the data: `docs/CONVERSATION_KNOWLEDGE_BASE.md`. Suite 616;
chat QA harness extended with the founder's exact questions.

## 2026-09-13 (31) — Truth is data: fees the bot can quote, flag-aware cash-out truth, catalogue-built "what can I buy"; W-mark in every QR

Founder review of live chat screenshots (BUGLOG #43, #44, #45): with payouts
switched on the AI still said cash-out was coming soon, a price question got
the Add Money menu and then a refusal to quote, and "what can I buy" was a
three-item VAS list. Fixes: `lib/fee-facts.js` computes every customer-facing
fee from the charging functions and answers price questions deterministically
before the keyword router (`handleFeeAsk`), with the same FEES block injected
into the AI's knowledge; the cash-out position in the knowledge block, the
spend lines, the MONEY/SEND specialist prompts and PRODUCT_TRUTH (now a
function) all follow `WAPAY_PAYOUT_ENABLED` at call time; the withdraw matcher
accepts "cash-out" and "take my money out"; the product list opens with the
catalogue. The business portal composes the WaPay W-mark onto every
payment-link QR (level-H error correction, decoder-verified 150 to 512 px;
new `public/brand/wapay-mark-256.png`). Chat QA harness gains fee, discovery
and withdraw scenarios and a flag-aware cash-out scenario. Pay-out fees +R2
(entry 30) land in the portal copy and docs. Recon of the conversational
architecture: `docs/AGENT_ARCHITECTURE_RECON.md`.

## 2026-09-11 (30) — Pay-outs switched on in production; +R2 margin on every pay-out fee; OTT sandbox probe

`WAPAY_PAYOUT_ENABLED=true` and the OTT_PAYOUT_* credentials are set in
Vercel (founder). A read-only operator probe, `/api/internal/payout-status`
(internal key), reports the switches, masked credential presence, and what
OTT's read endpoints return. First run against production: credentials
authenticate; the TEST account shows balance R0.00, **no active providers**
and no limits, so every pay-out request is refused with `NO_PROVIDER`
before any ledger movement until OTT enables PayShap / RTC / CashSend on the
sandbox and loads a float. KYC is still required but Didit is not
configured, so withdrawals stop at the identity gate until either the three
Didit envs land or `WAPAY_PAYOUT_KYC=off` is set for the sandbox window.
Founder decision: **+R2 margin on every pay-out method** — PayShap R8, bank
transfer R10, CashSend R18 / R23 / R30, Pay@ R14 (`lib/ledger-core.js`;
margin tests re-pinned; portal copy + `docs/PAYOUTS.md` updated). Internal
fee benchmark calculator published as an artifact (see tracker Delta 22).

## 2026-09-11 (29) — Withdrawals in chat; pay-out outcomes on WhatsApp; OTT test credentials received

OTT issued the payout test credentials (API key + password; username to
follow) and the portal webhook is set to `/api/webhooks/ott-payout`. The
consumer side of payouts is built: "withdraw R200" starts a PIN-gated,
KYC-gated flow (PayShap by cellphone number, bank transfer by account +
universal branch code, cash at an Absa/Nedbank ATM), confirm, PIN, one
idempotent money call through `lib/payouts.js`; the webhook tells the
customer when a pending pay-out is paid or fails. Home menu, the cash-out
script and the AI's product truth flip with `WAPAY_PAYOUT_ENABLED`. Portal
copy names the three methods and fees. `docs/PAYOUTS.md`. Go-to-market card
fee confirmed: 2.5% + R1 ex VAT on Adumo rails, free under R50.

## 2026-09-10 (28) — Adumo Online (Nedbank via SHB) as a second card rail, sandbox-proven; rail-aware fees

The SHB offer (credit 2.35%, debit 1.35%, gateway R0.80 + 0.10%, ex VAT) makes
card economics viable, so the hosted "Virtual" page is wired in next to
PayFast: rail choice on the pay page, one intent per request booking THAT
rail's fee, a signed JWT request, a return route and webhook that trust only
Adumo's signed response token, and a shared card settlement mirroring the
PayFast ITN (`lib/adumo.js`, `lib/card-settlement.js`). Proven on Adumo's
staging with the published test merchant: a R38 request paid with a test
card, settled into the scratch ledger; a declined 3DS attempt handled with
nothing credited. `paymentRequestFeeCents(amount, rail)`: PayFast unchanged,
Adumo R1 + 2.5% by default (the floor for a single blended fee; env-tunable), `RAIL.ADUMO` in the ledger. Off
until `WAPAY_ADUMO_ENABLED` + credentials; blocked on SHB's written answer to
the form's third-party-processing declaration. `docs/ADUMO.md`.

## 2026-09-10 (27) — Founder review round: speed, customers on the spot, CSV drop, QR, logo, WaPay sends with receipts, Payouts

Dashboards were slow because Vercel ran the functions in Virginia against the
Stockholm database (`regions: ["arn1"]` now; Overview 3.7 s → 0.3 s). From the
founder's screenshots: a typed name becomes a customer on the spot and a
walk-in link can be attached to a customer afterwards; CSV / vCard files drop
onto the import panel; every link has a QR code (copy, share, download); a
business logo (browser-resized data URL, validated server-side) shows in the
header and on the pay page. "Also send from WaPay" opens to vetted owners
(KYC-verified or invited) for any customer who has not sent STOP, with
delivery receipts mapped from Meta's status webhook onto the link and shown
as ticks. New Payouts tab and `lib/payouts.js`: PayShap / RTC / CashSend on
OTT's rail through the ledger hold pattern (SPEND → CASH upgrade, hold,
performPayout, settle or release, webhook finalisation), KYC-gated, a fresh
factor on every request, unit-tested against every OTT outcome; live only
behind `WAPAY_PAYOUT_ENABLED` once the sandbox and counsel clear it.
Migration `20260910_link_delivery` (additive) applied to prod first.

## 2026-09-06 (26) — Inbound-silence diagnostics; admin console on the portal's design; the band

Three days without an inbound WhatsApp message (BUGLOG #41) turned out not to
be the webhook: a read-only `/api/internal/meta-status` probe (app, callback
URL, WABA subscription, phone state, templates) and per-minute pulse rows in
`processed_messages` (`webhook-ok`, `webhook-401`, `status-*`) proved Meta
reaches the endpoint and its signatures verify. Runbook:
`docs/runbooks/whatsapp-inbound-silent.md`. The admin verifier accepts any
live code (BUGLOG #40, admin side). The admin console now shares the business
portal's visual system (glass cards, Inter, official lockup + "Admin" tag,
the same login shape; the page still never names the in-chat command). The
hard horizontal band on both consoles was the body's opaque background over
the fixed gradient layer; the root paints the base colour now and the body
is transparent, and the blurred orbs became one seamless green gradient.
Internal probe also reports the effective onboarding OTP switch. And the reason
the portal's "Send me a code" only ever worked inside the 24-hour window (BUGLOG
#42): the template sender fell back to `en_US` whenever the catalog was empty
(every API route), and no caller sent the copy-code button parameter the
authentication template requires; fixed in `@wapay/whatsapp` and used by the
onboarding, portal and admin code paths, so a code now reaches an owner who has
not chatted for days. "Send my code" is therefore the primary sign-in action
again on both consoles (2026-09-07), with "I already have a code" as the link.

## 2026-09-06 (25) — Business sign-up from inside WhatsApp; the onboarding OTP behind a flag

The portal is no longer the only door. A wallet that finishes onboarding is
asked once, "is this account for you, or for a business? 1 / 2"; business
leads to "what is your trading name?" and the business row exists (same
invite gate, name validation and one-per-account rule as the portal;
category and password stay in the portal's Settings; a wallet that may not
register yet is put on a list and told so). Existing wallets get the same
two questions from `business account`; the help menu lists it; the
intent-switch escape names the parked flow. New `lib/business-chat.js` is
pure (returns steps; the processor sends), `tests/business-chat.test.mjs`
drives it, and `pnpm qa:chat` gained a live scenario. The in-chat OTP of the
sign-up can now be switched off (`WAPAY_ONBOARDING_OTP=off`, default on):
`docs/ONBOARDING.md` records the flow, what a business account is, and the
recommendation to remove the step (same-channel code proves nothing Meta
has not verified; the PIN and consent stay).

## 2026-09-06 (24) — Business sign-in: the chat command is the primary path; a code in hand always works

Founder test round, day one: three "no code arrives" causes closed in order.
The invite variable was spelled in the singular in Vercel (both spellings now
honoured, `972c9e1`). The portal's push is free-form text that Meta accepts and
drops outside the 24-hour window, so the sign-in page now leads with
`business login` from the phone, which works mid-flow and answers a throttled or
capped owner instead of falling through to the AI (`a0be61e`). And the verifier
compared the newest code only, so a code already in the chat failed the moment
the portal minted a newer one (BUGLOG #40): the "I have my code from WhatsApp"
button now only opens the code box, and one verify attempt consumes every live
code and matches any of them. Official lockup + favicons on the portal
(`86a9c84`). In between, the peer session shipped OTT vouchers loading into a
wallet as a second cash-in rail (`8c726e8`, with `tests/ott-redemption.test.mjs`).

## 2026-09-05 (23) — WaPay for Business hardened by adversarial review; registration closed by default; deployed

Read-only adversarial review of the whole business change (7 lens finders, 3
refuters per finding, 3 completeness critics; trail in
`docs/testing/adversarial-review-2026-09-05.md`). Every confirmed finding fixed
before this deploy, each with a regression guard. Headliners: the WaPay-originated
nudge's "prior PAID relationship" could be manufactured with a number typed at a
card checkout, or by a business paying its own ticket from its own wallet (BUGLOG
#39: eligibility now needs a WaPay-account payer whose number IS the customer's;
a later copy click can no longer reset the once-per-link mark; out-of-window rails
go first). The public OTP request no longer messages wallets that own no business
and are not invited (a paid-template spam cannon otherwise). Sign-in lockouts are
now per SOURCE, so a stranger looping wrong codes or passwords at a shop's public
number locks their own connection out, never the owner, and a locked-out source
cannot consume the owner's fresh code. Dashboard fees and card/balance method are
read from the BOOKED PayFast intent instead of today's env; buckets are SAST;
lifetime, outstanding and conversion figures come from aggregates over every row
(no 500-row slice); the CSV export can never be silently short. The in-chat pay
flow, the payer's receipt and the balance-rail owner notification now name the
BUSINESS (and the customer + reference) like the pay page does; a suspended
business's links stop rendering and stop being payable. Composer: unfinished item
rows block creation instead of silently billing less; "1,500" and "1500,00" parse;
a stale quote is never shown under a new total; a blocked WhatsApp popup is not
recorded as sent; expired sessions return to sign-in; keyboard access for the
customer picker and rows; error messages are red. Completeness critics then found
the load-bearing gap: a suspended business's tickets were still payable from a
WaPay balance in chat — a shared `businessRequestPayable` now guards the pay page,
checkout, the in-chat confirm and the PIN settle; the nudge claims its link
atomically before sending; password set/clear needs the current password or a
fresh code (a borrowed cookie can no longer become permanent access); a browser
cannot forge a "sent by WaPay" mark; the CSV window is created-or-paid; owners
must be onboarded wallets. Registration is CLOSED by
default: `WAPAY_BUSINESS_MSISDNS` invites numbers, `WAPAY_BUSINESS_SIGNUPS=open`
opens it later. Host decided: `business.wapay.co.za`. BUGLOG #38: the real-DB E2E
caught a missing `status` in an explicit `select` that the in-memory stub had
hidden — the stub now projects `select` like Prisma. 547/547 unit tests (38 in the
business file), 8/8 real-DB E2E on an isolated schema, build green. Founder test
plan: `docs/BUSINESS_PORTAL_TEST_GUIDE.md`.

## 2026-09-04 (22) — WaPay for Business: portal, customer CRM, POS payment links; Fable prompting kit

Founder brief (design partner: a local laundry that reconciles payment links by
hand). A business is a WaPay account wearing a hat: `/business` (host-gated by
`WAPAY_BUSINESS_HOST` like `/admin`) signs the owner in with the wallet's
WhatsApp number (OTP via template candidates, or `business login` typed to WaPay
from the phone, or an optional argon2id password), registers the business name
(sanitised, may not impersonate WaPay/rails/banks), and opens four tabs:
Overview (paid, net after card costs, outstanding, customers, average ticket,
links-paid %, 12-month revenue bars with 3/6/12-month totals, card-vs-balance
split, outstanding and recent lists, top customers), Customers (derived
lifetime spend, add, paste-import CSV/vCard, profile with 12-month spend, what
they buy, every link), Payment links (POS composer: customer picker, line items
with a recent-items memory, reference, note, expiry to 30d, live fee/net quote;
result card with the link, the ready message and "Send on WhatsApp" which opens
the OWNER's own WhatsApp prefilled; link ledger with copy/cancel; CSV export),
Settings. Money rides the existing payment-request rail unchanged: the pay page
now names the business and itemises the ticket; the owner's PAID chat message
names the customer and reference. Business links carry their own caps
(250 open / 300 per day) and personal chat links exclude them. Walk-in payers
become customers automatically (card via the signed number, balance via the
WaPay account). A WaPay-originated push exists but is OFF by default
(`WAPAY_BUSINESS_NOTIFY`) and only ever reaches customers who already paid the
business — the cross-user rule. Schema: `businesses`, `business_customers`, six
nullable columns on `payment_requests` (migration `20260904_business`,
idempotent). Design: mirror-finish glass cards, 20px radii, light + dark,
Inter. Also: `docs/prompting/` (Fable 5.1 prompting guide mapped to this repo,
the feature-brief template, this feature's brief), skills `/feature-prompt`,
`/handover`, `/fable-review`, a "Working with Claude" section in `CLAUDE.md`,
and a pointer `CLAUDE.md` in the iCloud parent folder. 540/540 unit tests
(31 new), 8/8 real-DB E2E on an isolated schema (`tests/e2e/business-e2e.mjs`),
build green. Not yet activated in production (see `docs/BUSINESS_PORTAL.md` §5).

## 2026-08-31 (21) — Live-test feedback round: question≠purchase, UniFuel branding, quieter receipts

From the founder's first live fuel purchase + Tasha's review (screenshots):
BUGLOG #37 — "Where is OTT vouchers accepted?" no longer starts the buy flow;
information questions reach the AI, which now carries a dedicated policy-safe
accepted-at answer (categories + ottvoucher.com, betting never named).
Customer copy rebrand: the voucher is a "UniFuel fuel voucher", its code a
"UniFuel voucher code" (the word wiCode survives only in the tell-the-attendant
step); the redemption guide's station line is simply "a participating Shell or
Engen station". The where-can-I-spend answer restructured per founder: in-app
breakdown first, then "You can also spend at these participating retailers"
built from the catalogue; the OTT line says accepted without listing places.
The post-transaction "What would you like to do next?" menu is gone — one warm
line instead. Yoyo correspondence: EMAIL_TO_SIPHO_YOYO.txt drafted (QA
close-out, Dean, prod handover, callback auth, small-amount production test,
updated campaign list: Checkers/Shoprite/PnP/Engen/Shell/Total-when-onboarded)
and docs/WICODE_NETWORK.md records the list + the exact-amount till-payment UX
design. 488/488 tests; qa:chat 11/11 with the new accepted-at scenario.

## 2026-08-30 (20) — Admin password hash must not be peppered (caught in prod verification)

Production verification of (19) refused the correct password: the hash was
computed over `password + PIN_PEPPER`, and PIN_PEPPER exists in Vercel but not
on a dev machine — so a hash generated anywhere except production could never
verify. An argon2id hash already carries its own random salt; the pepper added
no strength here and made the credential environment-coupled. Both the verifier
and `scripts/hash-admin-password.mjs` now use the self-contained hash, so a
hash generated on any machine verifies wherever it is pasted. Guard: the test
asserts the verify call is unpeppered (comments excluded, code only).

## 2026-08-30 (19) — Admin password sign-in; the login page stops advertising the chat command

The WhatsApp code round-trip failed the founder again (codes WERE generated at
16:41 and 16:42 — the Meta send is the fragile link, BUGLOG #33's shape), so the
console now takes a **password**: `WAPAY_ADMIN_PASSWORD_HASH` holds ONE argon2id
hash (generated by `scripts/hash-admin-password.mjs`, peppered with PIN_PEPPER);
the password is never stored anywhere. The number stays the identity (allowlist +
exact account match), five failures lock the number out for 15 minutes, the
lockout check runs before verification, wrong-number and wrong-password return an
identical answer, and a malformed hash env refuses rather than crashing open. The
number is remembered in browser storage so only the password is typed. The
WhatsApp-code path remains as a fallback, so a forgotten password never locks the
founder out.

Also removed: the public login page no longer tells visitors to send "admin login"
to the WaPay number (founder security call — a stranger landing on the page should
not learn the in-chat command). The command still works from the founder's phone.
482/482 tests, build green.

## 2026-08-30 (18) — Fuel pilot gate, home-screen fuel line, wiCode network doc

Founder can now live-test fuel in the real chat without exposing customers:
fuel liveness is decided PER USER (`fuelLiveFor` = `WAPAY_WICODE_LIVE` +
optional `VAS_ALLOWLIST_FUEL`, the electricity pilot idiom) and drives the
flow gate, the AI's claim-gated knowledge, the HELP spend answer, and the new
home-screen line ("⛽ Fuel vouchers: coming soon" for everyone; "⛽ Fuel: buy
fuel" for pilots/live). `docs/WICODE_NETWORK.md` is the transparent reference
for where wiCode works (fuel + the retail footprint, rebate reality, claim
discipline, the open Yoyo questions). Chat E2E grew home-line + allowlist
legs (17/17); money E2E 29/29; 478/478 unit tests; build green.

## 2026-08-29 (17) — v1.3: conversational fix, supplier floats, UniFuel fuel vouchers end-to-end

**Task 2 — questions get answers, not menus (BUGLOG #34a).** The founder's screenshot
("Where can I spend my WaPay money!" → bare Help Menu, twice) traced to the tier-1 fast
path classifying capability questions as HELP and the dispatch rendering every HELP as
the static menu. Fixed in three layers: prompts (HELP reserved for bare menu asks; the
"Pay" persona — warm banker voice, emoji in every reply; the honest cash-out
coming-soon script, never a date, partner unnamed), dispatch (question-shaped HELP gets
the warm data-driven spend answer), and the adjacent traps (voucher-history how-to
exclusion; a product ask about something we don't sell now reaches the AI instead of the
VAS dump). New `lib/spend-catalogue.js` is the single data-driven source of spend
knowledge, claim-gated on `WAPAY_WICODE_LIVE` and injected into every tier-2 AI call.
`pnpm qa:chat` grew four question-never-gets-menu scenarios (10/10 PASS).

**Task 1 — Supplier floats in Mission Control.** `/api/admin/floats` + card: both OTT
balances server-side (issuance verified live: R99,960 on the sandbox float), ledger
CLEARING:* positions per rail incl. YOYO, drift, low-float alarms; Blu ledger-only (no
balance API; spec asked of Phuti), PayFast history-only (verified). 60s cache; errors
reduce to short codes; credentials never leave the server.

**Adversarial review round (77 agents, 34 confirmed findings, all fixed pre-ship).**
Load-bearing catches: a reconcile racing a slow Yoyo mint could declare failure and
release the hold while the card still landed (CRITICAL — closed with a 120s age gate on
UniFuel's order endpoint); indeterminate purchases had no reachable retry path (closed
with `lib/fuel-settlement.js` + an every-message reconciler that settles or releases);
a settle failure after issuance could refund a customer whose wiCode existed (crash
guard now disarms the moment the voucher exists); concurrent PIN taps deduped by an
atomic EXECUTING flip + a deterministic UniFuel order id (raced live: one Yoyo card);
`getUserGiftCards` really returns `data.giftcardList` (probed) — the reconcile parser
was reading keys that don't exist; UniFuel's own cron/admin retries now refuse
wapay-driven orders; the redemption webhook gained replay guards and a targeted
single-gift claim; the fuel matcher no longer swallows complaints; list asks stay on
deterministic voucher history; drift pills tell the truth. Full trail in
`docs/testing/adversarial-review-2026-08-29.md`.

**Task 3 — UniFuel/wiCode integration, built NOW on the Yoyo TEST env**
(docs/UNIFUEL_INTEGRATION.md). Two repos stay separate: UniFuel gained a fail-closed
Bearer partner surface (`/api/partner/wapay/issue|order|catalog|stats` — idempotent by
reference, userRef `wapay:<ref>` makes lost responses reconcilable against Yoyo) plus a
redemption forwarder; WaPay gained `lib/unifuel-client.js` (ISSUED/FAILED/UNKNOWN
discipline — never release a hold on unknown), the full chat flow ("buy fuel" → amount →
confirm → PIN → wiCode + redemption guide in-session, coming-soon while gated),
`SPEND_FUEL` ledger postings into CLEARING:YOYO (commission 0 bps until signed),
`/api/webhooks/unifuel` (partial redemption re-arms the fresh code through the atomic
claim flow), the Mission Control UniFuel panel, and `lib/email.js` (Resend on WaPay
identity, ops alerts first). Yoyo's undocumented ~45-char userRef limit found and fixed
pre-ship (BUGLOG #35). Proven: 29/29 full-money E2E on an isolated scratch schema with
REAL Yoyo TEST issuance (`pnpm qa:fuel`) + 13/13 chat-level E2E. 478/478 unit tests,
build green. Go-live is a credentials/flag flip, not a build.

## 2026-08-28 (16) — Admin login code: request it from your phone (BUGLOG #33, round 2)

The template path turned out to be a dead end: production diagnosis showed `(#132001)` for
every OTP template (approvals are per-WABA and our catalogue mixes two accounts), while the
free-form fallback reported `ok:true` with a message id and was still silently dropped
outside the 24h window. So the flow is inverted — message **"admin login"** to the WaPay
number and the code comes straight back in-session, where delivery is guaranteed and no
template is involved. Same allowlist, throttle, daily cap and hashed storage; silent for
non-admins. The console button still works when the window is open, and the login screen now
says so. Also added: an internal-key-only delivery diagnosis on the request endpoint (never
the code) so this class of failure is diagnosable, not guesswork. 429/429 tests.

## 2026-08-28 (15) — Admin login code now delivers (BUGLOG #33)

The founder's first login produced no code: the OTP was generated fine but sent as a
free-form WhatsApp message, which Meta only delivers inside the 24-hour customer service
window — and an admin logging in from a computer is exactly when that window is closed
(28.6h had passed). Admin OTP now goes out on the approved AUTHENTICATION template
(`otp_register_step_2`, overridable via `WAPAY_TEMPLATE_ADMIN_OTP`) with free-form as the
fallback, and an undeliverable code row is deleted so the retry is not throttled. 4 new
tests (423 total).

## 2026-08-28 (14) — Admin console moves to a wapay.co.za host + Didit API spec saved

- **Host routing** (`middleware.js` + `lib/admin-host.js`, founder ask): set
  `WAPAY_ADMIN_HOST` (e.g. `admin.wapay.co.za`) and the console serves ONLY there — every
  other host **404s** `/admin` (a 404, not a redirect: the console is not advertised on
  customer domains), and that host's root rewrites into the console. Unset = no restriction,
  so nothing breaks before the DNS exists. The matcher is page-only: `/api/*` is never
  intercepted, so the Didit webhook and every other API stay reachable on the app domain.
- **`docs/DIDIT_KYC_API.md`** — the verified v3 API spec saved permanently: create-session,
  hosted-link semantics, decision endpoint, webhook signature recipe + delivery/retry
  contract, the exact status enum and our mapping, founder console setup, the documented
  unknowns with the defaults already coded, what we store under POPIA, the safety properties
  the tests lock, and **what still needs building** (the cashout KYC gate).
- 4 new tests (419 total) incl. lookalike-host rejection (`admin.wapay.co.za.evil.com`).

## 2026-08-28 (13) — Didit KYC end-to-end + funnel/cohorts on real data

The KYC rail, built against the verified Didit v3 API (researched from live docs same day):
- **`lib/didit-kyc.js`**: create hosted session (`vendor_data` = account id, Didit-side
  idempotent), HMAC-SHA256-over-raw-bytes webhook verification with a 5-minute replay
  window, decision fetch as source of truth, exact Title Case status map (unknown statuses
  never move our state), `profile.kyc` always MERGED. **POPIA: masked document number only —
  the full number is never stored and person data is never logged.**
- **`/api/webhooks/didit`**: signature before parse, process-then-ACK (BUGLOG #7 rule),
  5xx on transient failure so Didit retries, customer notified in their language on
  VERIFIED/DECLINED with a notifiedStatus dedupe gate.
- **`/api/admin/kyc`** + console buttons: "Send verification link" delivers the hosted link
  ONLY to the account's registered WhatsApp (never a caller-typed number); "Refresh status"
  re-syncs from the decision endpoint. Probe endpoint tells the console when Didit envs are
  missing (fails closed).
- **Acquisition stamping**: new accounts get `profile.acquisitionSource` (money-backed:
  captured pay-link payer = paylink, else organic); `scripts/backfill-acquisition.mjs` ran
  on prod (3/3 — the founder's account correctly reads paylink).
- **Metrics**: real funnel (contacts incl. captured payers, accounts, funded, transacting,
  repeat), signups by source, retention cohorts — all live on the dashboard with new
  Funnel/StackBars/Cohorts renderers.
- **27-agent adversarial review run before ship** — caught 1 CRITICAL (admin tail-9-digit
  impersonation), 6 HIGH (shared-OTP-table, profile race, KYC notification loss + VERIFIED
  regression, backfill clobber, re-send downgrade), and a MEDIUM batch (metrics truncation,
  timing-safe internal key, POPIA decline-text, split-brain account fallback). All fixed in
  this push with regression guards (BUGLOG #32).
- 23 new tests (415 total). Metrics + KYC endpoints smoke-tested against prod (funnel now
  counts by account id, correctly collapsing a legacy dual-coded account).

**To activate KYC**: business.didit.me → create a KYC workflow → set `DIDIT_API_KEY`,
`DIDIT_WORKFLOW_ID`, `DIDIT_WEBHOOK_SECRET` in Vercel; webhook destination URL =
`https://pleasepayme.co.za/api/webhooks/didit`, subscribe `status.updated`. Sandbox app first.

## 2026-08-28 (12) — Mission Control admin console v1 (OTP login, live dashboard, customer CRM)

Founder green-light on the mockup, so the real thing: `/admin` behind a WhatsApp-OTP login.
- **Auth**: `WAPAY_ADMIN_MSISDNS` allowlist + `WAPAY_ADMIN_SESSION_SECRET` HMAC sessions
  (12h, HttpOnly/Secure/SameSite=Strict). OTP reuses `otp_codes`: hashed at rest, one send
  per minute, ONE verify attempt per code (a wrong guess burns it). Allowlist is re-checked
  on every request, so removing a number kills its sessions. Fails closed until both envs
  exist — the login screen says exactly which to set.
- **`/api/admin/metrics`**: the dashboard payload from the double-entry journal (vitals,
  flows in/spend/transfer, revenue by REVENUE:* line, weekly series). Smoke-tested against
  prod: 3 accounts, 2 funded, R197 GMV/30d, R19 revenue, R85 float — the honest truth.
- **`/api/admin/customer?q=`**: CRM lookup by any number form — identity, KYC status
  (**Didit chosen as v1 provider**, founder decision), balances + holds, last 40 wallet
  postings, vouchers sent/received, requests, deposits. `voucherPin` is NEVER selected
  (bearer secret) — statically locked.
- **Mockup v2** republished with the customer-profile + sign-in screens (same URL). Also
  this morning (uncommitted-then, now in): docs/KYC.md (tiered model + Didit decision),
  docs/ADMIN_DASHBOARD_DESIGN.md updated to v1-BUILT.
- 13 new tests (396 total): fail-closed everywhere, one-guess OTP, token tamper/expiry/
  revocation, cookie flags, gate-before-query statics, PIN-leak lock, betting-word ban.

**To activate in prod**: set `WAPAY_ADMIN_MSISDNS` (comma-separated, e.g. 2778…) and
`WAPAY_ADMIN_SESSION_SECRET` (32+ random chars) in Vercel, redeploy, open pleasepayme.co.za/admin.

## 2026-08-27 (11) — Conversational QA harness + the three bugs its first run caught

New end-to-end "bug reporter" (founder ask 2026-08-27): `pnpm qa:chat` drives
the REAL `processMessage` — live DB, live OpenAI orchestrator + localizer —
with the outbound WhatsApp transport mock-captured (`mock.module`, covers
every importer incl. `@wapay/auth`), against a run-scoped QA account
(`27600000901`, seeded at S5 with a ZERO-cent wallet, torn down in a
`finally`, links cancelled; no PIN is ever sent, no purchase completes, no
real message can leak). Report per run: `docs/testing/chat-qa-report-<date>.md`.

- `tests/e2e/chat-harness.mjs` (capture + session + seed/teardown),
  `tests/e2e/chat-qa.mjs` (6 scenarios: the founder's meter-state repro,
  electricity→airtime→home→get-paid fluidity, messageId dedupe, AI recall,
  recall ACROSS flows, isiZulu switch + live-localized balance + Afrikaans
  inbound), `package.json` script `qa:chat`.
- **BUGLOG #30 fixed**: `mergeConversationData` dropped `history` on every
  state change — the AI amnesia'd whenever a flow started or ended. History
  now rides across transitions like the idempotency keys.
- **BUGLOG #31 fixed**: the bare `what|which|show|list` product-query
  indicator hijacked every question into the products menu; it now requires
  a commerce noun.
- **Em-dash leaks closed**: all 11 `LANGUAGE_CONFIRMATIONS` de-dashed, and
  `sanitizeUserText` now normalizes em/en dashes out of MODEL-authored
  replies (the copy rule applies to the AI too).
- First harness run: 2 pass / 4 fail → fixes → second run **6/6 pass**
  (recall works across flows; Zulu localization live-verified with money
  figures frozen). Unit suite 383/383, build green.

## 2026-08-27 (10) — Pay page round 4: big hero restored, card button state-aware (founder screenshots)

`pages/pay/[code].js`; guards in the new `tests/pay-page-round4.test.mjs`
(378/378 green, build green, both interactions verified live in a browser
against the founder's real PENDING R20 request).

- **Hero back to the pre-round-2 design** — the quiet one-liner was a misread
  of round 2. "🙏 Please Pay Me" is 28px/800 green again with the small
  "with WaPay" line under it (exactly 325587b's hero); the ONLY change kept
  from round 2's intent is the ™, now its own 13px/400 superscript span.
- **Card/EFT button is state-aware**: pale until a plausible number
  (`[0-9+ ]{10,15}`) is typed, then solid brand green with a soft shadow —
  the "cool, you can pay now via card" signal. Tapping it WITHOUT a number
  pops an amber nudge ("📱 Enter your WhatsApp number first."), blocks the
  submit, and focuses the field; the nudge hides itself the moment the
  number is in.
- The form is `noValidate` (our popup replaces the browser's), and the
  submit gate reads the DOM value rather than React state, so iOS autofill
  that skips onChange can never block a visibly-filled field. A no-JS post
  still goes through untouched — checkout stays lenient on the number by
  design (payment always outranks the growth hook).
- `tests/payer-registration.test.mjs`: the form-tag assertion now matches
  the multi-line form while still pinning POST-not-GET.

## 2026-08-27 (9) — Mid-flow intent switch: detect, acknowledge, re-route (founder live test, BUGLOG #29)

All in `pages/api/webhooks/message-processor-v2.js`; guards in the new
`tests/intent-switch-payment-link.test.mjs` (374/374 green, build green).

- **"Payment link" is now a recognised get-paid ask**: `matchRequestMoneyAsk`
  matches create-verb + "pay(ment) link" and "pay(ment) link" + amount, so
  "Please create a payment link for R20" routes to the request flow from
  ANYWHERE — including mid-electricity, where it previously got the meter
  validation error. Complaints/questions about a link still fall through to
  the router, never a create flow.
- **The universal escape speaks**: on a strong intent switch the customer now
  hears the old flow being parked ("👍 No problem, switching over. We can come
  back to the electricity purchase any time.") before the new intent's own
  reply. Family-labelled (airtime/data/electricity/payment request/deposit/
  voucher); silent for unlabelled states; state is cleared BEFORE the ack so
  the re-route never depends on the send.
- **Sentence backstop in all eight slot-collector states** (electricity
  amount + meter, airtime amount + msisdn, data msisdn + network + period,
  voucher-gift amount): an unparseable SENTENCE escapes to the normal router
  (`isConversationalEscape` → clear state → `handlePostOnboarding`) instead
  of a validation insult — the REQUEST_MONEY_AMOUNT idiom, now everywhere.
  VOUCHER_GIFT_RECIPIENT is deliberately excluded: two-word beneficiary
  names ("John Smith") look conversational, and the strong-intent escape
  already covers named intents there.

## 2026-08-27 (8) — Voucher display honesty (founder screenshots round 3)

- **Home line renamed**: "Balance" then "🎟️ Voucher Balance: R10 (1 OTT voucher)" — the
  founder's naming, and the product is named.
- **"my vouchers" split into Yours vs Sent to others (no longer yours)**: a gifted voucher
  visibly leaves the account (the balance maths already excluded it — voucherBalanceSummary
  counts only self-directed, non-cancelled vouchers; now the display says so). Sent rows show
  the masked recipient and never the serial. The list closes with the same Voucher Balance
  line as home.
- **Footer swapped**: the "voucher pin <last 6…>" resend hint is gone from this surface
  (the keyword still works, wallet-PIN-gated); replaced with "Want another? Reply 'buy a
  voucher R50'."
- Honesty boundary kept: no "unspent/used" claim anywhere — redemption visibility needs
  OTT's voucher-status API (asked; the portal's Lookup-a-Voucher proves the data exists).

Guards pin the split, the no-SN rule on sent rows, the missing resend hint, and the
Balance→Voucher Balance ordering. 368/368, build green. Commit via the iCloud-holding session.

## 2026-08-27 (7) — Pay-page quiet hero + adjacent pay options + rich link previews

Founder screenshot feedback, round two:

- **Hero calmed down**: "Please Pay Me™ with WaPay" is now one small normal-weight line
  (15px/500, was 28px/800) — the amount is the loudest thing on the page again.
- **Both payment options sit adjacent**: balance button (renamed "Pay from my WaPay account
  (free)") directly above the card button; the required WhatsApp-number field moved below the
  card button inside the form — the browser walks the payer to it on submit, so capture is
  unchanged.
- **Forwardable message reads "🙏 Pay Niev now · R100 on WaPay"** instead of leading with the
  raw URL. The URL itself must stay (WhatsApp strips CTA buttons from forwarded messages and
  has no text-anchored hyperlinks — a forwarded message's only tappable path IS the URL), but
  the page now ships **OG meta tags**, so a shared link renders a rich preview card
  ("Please pay Niev · R100") that acts as the visual button above the URL.
- Localization marker for the forwardable surface updated in tests/localize-coverage.test.mjs
  (coordination note from the parallel session applied as instructed).

366/366, build green. Commit via the session holding iCloud access (TCC still blocks this one).

## 2026-08-27 (6) — Em dashes out of chat copy (founder style rule, chat sweep)

Completes the sweep the pay-page batch started: all ~55 em dashes in customer-facing chat
copy rewritten (menu rows `*Label* — desc` → `*Label*: desc`; independent clauses split into
sentences; short qualifiers become commas/parentheses; the voucher-history row separator is
now `·`). Two deliberate survivors, whitelisted by content: the `'—'` null-serial placeholder
in the voucher list and the internal orchestrator context label (never user-facing). Code
comments untouched by design. Recipient gift notification in `lib/gifting.js` reworded too.

Guard: `tests/founder-feedback-0825.test.mjs` now fails on ANY non-whitelisted em dash in a
non-comment processor line, so new copy can't reintroduce them. Two pinned copy tests synced
in the same commit (deposit prompt, home voucher line). 366/366, build green.

## 2026-08-27 (5) — Full deterministic-surface localization (build-queue #3)

The 2026-08-25 batch localized home/help/get-paid/airtime; this completes the sweep. Every
deterministic prompt, confirmation, receipt, product list and flow error now renders in the
user's profile language via `localizeOutbound` (money/codes frozen, fail-open English) —
~184 call sites across the state machine, orchestrator dispatch, smart product query, all ten
category list functions, deposit status, voucher history, contact-share, pay-request flows.
Variable-built messages localize at assignment so conversation history stores what was
actually sent.

Deliberately NOT localized: bearer voucher claim messages (`buildVoucherClaimMessage` output
is delivered verbatim — a translation model never sits between a bearer PIN artifact and the
customer) and messages to OTHER parties (recipients/requesters — their language is their own
profile's business, not the sender's).

Mechanics: applied AST-driven (acorn) over a whitelist of account-scoped handlers —
literal-only wraps, variables by hand — so every English source literal survives
byte-identical and all pre-existing static copy tests pass untouched. New
`tests/localize-coverage.test.mjs` locks: a ≥150-call-site floor, one representative surface
per flow family, the bearer-verbatim rule, and userLang pairing. 365/365, build green.

## 2026-08-27 (4) — Confirm-before-create + Please Pay Me™

- **One link, ever** (founder): a fee-bearing "please pay me R380" now explains the two
  outcomes FIRST and asks the requester to pick — 1️⃣ link for R380 (nets R371.40 by card)
  or 2️⃣ link for R390 (nets at least R380 however they pay) — and only then mints exactly
  one link. The old flow created immediately and offered "make it R390", which cancelled +
  recreated (two links, two codes). Free-band requests (< R50, no fee) still create in one
  step: there is nothing to choose. New `REQUEST_MONEY_CONFIRM` state (cancel/escape-safe,
  amount echoes accepted as picks); post-create copy simplified and em-dash-free.
- **Please Pay Me™** on the pay-page hero (founder: registration in progress; ™ per the
  pending-application convention, flips to ® at grant — one character).
- Static guards: the confirm gate provably precedes createPaymentRequest; the swap offer is
  gone from post-create copy; ™-not-® and the no-em-dash rule are pinned.

365/365, build green. ⚠️ Ships via the NEXT thread's commit — iCloud still TCC-blocked here.

## 2026-08-27 (3) — Pay-page polish + PayFast contact prefill (founder screenshots)

- **"Please Pay Me"** title-cased everywhere on the pay page. Deliberately NO (R) symbol:
  claiming a registered mark we do not own is false marking, and "Please Pay Me" is Capitec's
  live product name with our CIPC search still on the counsel brief. Revisit after counsel.
- **Em dashes stripped from all client-facing pay-page copy** (founder style rule for client
  interfaces); code comments untouched. Chat-message copy sweep handed to the next thread.
- **PayFast never asks for the number twice**: the pay page's captured number now rides the
  signed checkout as `cell_number`, pre-filling PayFast's "how can we get hold of you" step.
  New `cellNumber` param in @wapay/providers-payfast (canonical field order, omitted when
  absent, dist rebuilt). PayFast's own email/cell field cannot be REMOVED (their page, their
  KYC rule) but arrives pre-filled so the payer just taps Continue.
- Sender-pays re-raised (domestic-worker use case) and re-confirmed NOT available as a card
  differential (PayFast T&C 5.3 / SARB / PASA). The compliant equivalent already shipped:
  compose-time gross-up ("make it R390") = one displayed price every payer pays. Making that
  flow more prominent = next-thread item.

359/359, build green. ⚠️ Committed by the NEXT thread — iCloud repo unreachable (TCC) when
this shipped; all changes complete + tested in the fast copy.

## 2026-08-27 — Payment-request creation caps (abuse guard on the free-band subsidy)

The build-queue hardening item, made more urgent by free-under-R50: request creation now has two
env-tunable caps, enforced in `createPaymentRequest` (the single creation path):

- **Open-links cap** — max **10** live PENDING links per requester (`WAPAY_PAYREQ_MAX_OPEN`,
  0 disables). Counts only *unexpired* PENDING rows: expiry is lazy (a stale link keeps status
  PENDING until someone reads it), so counting raw PENDING would have permanently locked out any
  account with 10 expired unpaid links.
- **Daily cap** — max **20** creations per rolling 24h, any status (`WAPAY_PAYREQ_MAX_PER_DAY`,
  0 disables). Cancelled requests still count a creation, so cancel-and-recreate is not a bypass;
  the amount-change swap (one cancel + one create) stays far inside it.

Both are abuse guards, not money invariants — enforcement is approximate by design (two
concurrent creates can briefly exceed a cap by one; `postEntry` idempotency still guards every
rand). Cap errors are typed (`code REQUEST_LIMIT`, `limit OPEN|DAILY`) and the processor answers
them honestly instead of the generic "try again in a moment" (retrying a cap is futile and reads
as broken): the open-cap reply names the newest pending code with a concrete
*"cancel request PRXXXXXX"* to free a slot, mentions the 7-day self-expiry, and is localized.
Logged as `payrequest_create_capped`.

Tests: 3 new (359 total) — cap fires + typed error + per-account isolation + the
expired-PENDING-never-counts lockout guard; daily cap counts every status and frees after 24h;
static processor wiring (distinct branch, distinct log, localized, concrete cancel hint).

---

## 2026-08-27 — Small requests are FREE + compose-time quoting (fee incidence resolved)

The founder asked whether the pay-link fee should move to the PAYER ("if I ask for R20 I should
get R20"). Researched: **it cannot** — charging the payer more for card is a surcharge, prohibited
by **PayFast's own merchant T&Cs cl. 5.3** ("same price regardless of whether the payment is by
Card or cash"), SARB/PASA, and Visa/Mastercard scheme rules (SA is not on the permitted list; no
"convenience fee" carve-out). Breach lets PayFast terminate our only card rail. Receiver-pays is
the only compliant model — and the SA category norm. Recorded in the `no-card-surcharging-sa`
memory; flagged for the NPS counsel brief.

The instinct was right about the *problem* though (the requester's own typed amount is their
anchor; landing under it reads as a loss), so both halves are fixed without touching the payer:

- **Requests under R50 are FREE** — a deliberate, bounded subsidy. PayFast's fixed R2.30 floor
  makes ANY margin-positive fee on R20 exceed 15%, and a flat fee is *worse* at the bottom than
  the percentage — so the only real fix is to absorb it. Costs ~R2.50–R4.10 per absorbed payment
  and buys a card payer whose number we capture: a lead at roughly a tenth of the R35–R60 CAC of
  a Meta ad. Tunable via `WAPAY_PAYREQ_FREE_BELOW_CENTS` (0 disables).
- **Taper across the threshold** — without it the schedule was non-monotonic (ask R49 → net R49;
  ask R50 → net R45.60, i.e. *asking for more paid you less*). The fee is now capped so NET is
  strictly non-decreasing across R1–R3000, asserted exhaustively.
- **Compose-time quote** — the creation message now states what you'll NET before the link goes
  out, and offers the whole-rand ask that nets exactly what you wanted ("make it R55"), which
  routes through the existing, tested amount-change swap. The requester picks the displayed
  price; the payer always pays exactly what is displayed.

356/356, build green.

## 2026-08-26 (2) — Softer payment-request card fee (founder feedback)

The card fee deducted from the person GETTING PAID was rounded up to a whole rand,
landing R50 requests on an ugly flat 10% (R5.00) — most of which was PayFast, not us.
New `paymentRequestFeeCents` rounds up to the nearest **10 cents** instead (deposits keep
whole-rand — the depositor chooses the amount and a clean number reads better). Confirmed
against a real PayFast ITN (R3.18 on R24.00 = 3.2%+R2 excl VAT): every amount R5–R3000
stays margin-positive and never costs the requester MORE than before. R50 fee: R5.00 →
R4.40. WaPay-to-WaPay balance pay remains **free** (buildSend spend→spend, already in
code). Fee still quoted transparently at request creation. `tests/founder-feedback-0825`
pins the ≤-whole-rand and ≥-PayFast-cost invariants across the range. 354/354, build green.

## 2026-08-26 — OTT Payout API: client + documentation (money-out rail groundwork)

OTT sent the Payout API spec — the last thing blocking the payout BUILD. Shipped the client and
project docs (customer-facing withdrawals stay counsel-gated; live calls await generated test creds
+ IP allowlisting):

- **`lib/ott-payout.js`** — full client for all 9 endpoints (PerformPayout, GetBalance,
  GetActiveProviders(+Limits), GetBranchCodes, GetCountryCodes, GetPaymentStatus, ResendSMS,
  VerifyWH) + inbound webhook verification. HTTP Basic auth + SHA-256 request hash, both proven
  **byte-identical to OTT's two published golden vectors** (`Aladdin:OpenSesame`→base64,
  `11`+`123456789012`+apiKey→sha256). Integer-cents money-safety throughout; the OTT-VOUCHER payout
  PIN and recipient PII are never logged.
- **`classifyPayoutStatus`** — the money-safe status→settlement map: SETTLE only on 100; 98/99 and
  any UNKNOWN status stay PENDING (never release a hold we may have paid); explicit failures release.
- **`docs/OTT_PAYOUT_API.md`** — integration guide with the exact per-endpoint hash orders, the
  ledger mapping (reserveHold→payout→settle/hold/release, deterministic epoch-free reference), the
  two sandbox questions the spec leaves open (body encoding JSON-vs-form; amount/empty-optional hash
  formatting), and the launch gates.
- **Adversarial review caught three defects before any live call** (BUGLOG #28): the wire amount was serialised as a JS number while the hash used the 2dp string (every round-rand payout would have failed Invalid Hash — and my test had locked the bug in); transport failures threw instead of returning an indeterminate PENDING; status 3 released a hold that may already have been paid. All fixed, with the caller contract documented.
- `tests/ott-payout.test.mjs` (16 tests) pin the golden vectors, the PerformPayout hash field order,
  webhook verification, the settlement map, and secret hygiene. Suite 354/354, build green.

Next: generate test credentials in the payout portal → sandbox-verify the two open questions →
build the withdraw flow (ledger holds + KYC capture) behind the counsel gate → webhook route.

## 2026-08-25 (4) — Founder live-test batch: localization, flow-escape, safe directed requests

Acting on the founder's real-account test feedback, with a 15-agent adversarial review that
caught (and forced the rewrite of) a critical abuse vector before ship:

- **Deterministic surfaces now speak the user's language** (`lib/localize.js`): home/help/get-paid/
  airtime prompts translated via gpt-4o-mini into the profile language. Money, PR-codes, links and
  phone numbers are FROZEN as placeholders and the model output is rejected unless every placeholder
  returns in EXACT order and count (a reorder could invert "R5–R3000" → "R3000–R5"); fail-open to
  English; cached; 2.5s abort. "Speak Xhosa" now sets the language permanently (locked — rolling
  evidence only yields to a clear, sustained switch) and confirms natively in all 11 languages. The
  matcher was hardened so object phrasings ("reply to my sister in Xhosa", "change my Zulu voucher")
  never swallow the real message.
- **Universal intent-switch escape**: a clearly-stated NEW intent breaks out of ANY waiting state
  (family-aware — an in-flow answer never escapes, PIN digits never look like an intent), fixing the
  founder's stuck data/voucher loops.
- **WaPay-to-WaPay directed requests — SHIPPED SAFE.** "please pay me R50 from <name/number>" now
  delivers ONLY to someone the requester has already saved as a beneficiary, as a PURELY
  INFORMATIONAL nudge the payer opts into by typing "pay request <code>" — it never writes another
  user's conversation state, never renders their spoofable profile name as authority, and returns a
  neutral response so arbitrary numbers can't be probed for WaPay membership. (The first cut planted
  a "reply YES to pay" confirm in any stranger's chat with a spoofable sender — a phishing vector the
  review flagged critical; rebuilt before it ever deployed.)
- **"Buy 100 minutes"** clarifies rand-vs-minutes instead of silently equating.
- **Pay links are now `pleasepayme.co.za/<code>`** and the pay page greets "🙏 Please pay me / with
  WaPay" (founder decision; product stays WaPay-branded; old wa-pay.me links keep working).

337 tests, build green.

## 2026-08-25 (3) — Durable paid-request notifications (BUGLOG #26)

Founder's live R20 test paid perfectly but notified nobody: sends were gated on the
one-shot PENDING→PAID transition, and a mid-send invocation death (ITN had no
maxDuration) lost them permanently. Notifications now live in `lib/request-notify.js`
— idempotent flags in intent metadata, set only on a successful send; the ITN runs it
on EVERY delivery so redeliveries repair; `POST /api/admin/notify-request` repairs on
demand; ITN gets 30s, the WhatsApp webhook 60s. 317/317, build green.

## 2026-08-25 — Voucher balance on home, pay-link CTA button, request-paid template fallback, BSUID banked

- **Voucher balance (founder ask)**: the home screen and the deterministic balance answer now show `🎟️ Vouchers bought: R120 (3) — reply "my vouchers"` — SELF-bought vouchers only (gifts to others were given away), CANCELLED excluded, best-effort (a balance surface can never fail on the voucher query). Copy says **bought**, never "unspent": OTT gives us no redemption visibility yet — that ask is now item 3 in `EMAIL_TO_KEAMO_3.txt`; when OTT exposes voucher status we upgrade the line to true "active".
- **Pay-link presentation (founder ask)**: the requester's own copy is now a tappable CTA button ("View my payment page", plain-text fallback). The FORWARDABLE message keeps the visible short link deliberately — WhatsApp strips interactive buttons on forward, and the forwarded message is the payer's only road in.
- **Requester-notify template fallback**: a request paid on day 6 lands outside the requester's 24h service window, where free-form is rejected — the ITN now falls back to the env-gated `wapay_request_paid` template (spec in `docs/whatsapp-new-templates.md`; set `WAPAY_TEMPLATE_REQUEST_PAID` after Meta approval).
- **Meta template rule documented** (bit the founder live): body text may not start or end with a variable — paste-ready bodies for `wapay_payment_receipt` + `wapay_request_paid` in the templates doc.
- **WhatsApp usernames/BSUID banked** (`docs/whatsapp-bsuid-usernames.md`): BSUIDs already in webhooks; username adopters lose visible phone numbers — adoption plan queued (capture `user_id` now, resolution by msisdn-or-bsuid, REQUEST_CONTACT_INFO onboarding leg July 2026+); reserve the `wapay` business username (claimable since June 29). Merchant "pay me" card concept noted — printable TODAY with wa-pay.me/PR-links.
- Suite 304/304, build green.

## 2026-08-25 (2) — Payout agreement SIGNED; Collect analysed and deferred

- **Founder signed the OTT Payout Agreement.** `EMAIL_TO_KEAMO_4.txt` returns it and
  asks for the blockers: API credentials + base URL (sandbox/prod), documentation in a
  usable form, webhook spec, IP-allowlist process, and the activation checklist (KYC
  list, Annexure A settlement details, minimum pre-funding).
- **Collect: DEFER, do not sign** (`docs/WAPAY_OTT_COLLECT_ANALYSIS_2026-08-25.md`,
  40-agent adversarial review of the contract text). The wallet-credit inversion —
  redeeming Standard Bank Instant Money / Nedbank / VodaPay vouchers straight into a
  WaPay balance — is **expressly forbidden** by clause 16.3 ("the Consumer may only be
  paid out in cash"), reinforced by definition 1.9 read with 2.1.12. Collect as drafted
  needs premises, vendors and cash floats WaPay does not have (11.1 is literally
  unperformable). ⚠️ Signing it as a dormant contract is dangerous: warranty 17.4 plus
  24.2.4/25.2.4 turn it into a live misrepresentation claim.
- **But the prize is real**, which is why one email is worth sending: Reading B replaces
  a ~R20.70 PayFast cost per R500 loaded with ~R1.19 EARNED, and inverts the float
  direction. `EMAIL_TO_KEAMO_5_COLLECT.txt` asks the two decisive questions: does a
  digital-settlement variant exist, and is "cash only" OTT's rule or a bank scheme rule
  (if the latter, an OTT side letter protects us against nobody).

## 2026-08-25 — Payout commercials: VAT-true rail costs + banded CashSend fees

Read the signed-ready **OTT Payout Agreement** (Annexure A) and corrected two margin
errors baked into the fee model:

- **VAT was being ignored.** Supplier rates are quoted EXCL VAT and WaPay is not
  VAT-registered, so that VAT is an unrecoverable real cost. `cashoutRailCostCents`
  now grosses every rail cost up (`VAT_BPS`, `inclVatCents`): Pay@ R8.65→R9.95,
  PayShap R2.50→R2.88, RTC R4.50→R5.18, CashSend R9.96→R11.46. Margin was
  previously overstated by ~15% on every withdrawal.
- **A flat R14 CashSend fee went underwater above ~R738 face** (the 0.3% switching
  fee rises with the amount). Customer fees stay FLAT but are now **banded** —
  the shape already approved for deposits: R50–R700 = R16, R701–R1500 = R21,
  R1501–R3000 = R28. Every rail is now margin-positive at every cent from R50 to
  R3000, asserted exhaustively in `tests/payout-fees.test.mjs`.
- **The 0.3% is CashSend/VAS only** (Annexure A 3.2), NOT PayShap/RTC (3.3, "Bank
  EFT Products") — locked by test, because a stray percentage on PayShap would
  erode the one rail the withdrawal margin rests on. PayShap earns a constant
  **R3.12** at any ticket size and is the rail to steer customers to.

Suite 313/313, build green. Payout code itself is still unbuilt — blocked on OTT
Payout API credentials + base URL (Keamo). Collect agreement reviewed: it makes
WaPay a PHYSICAL cash-out agent with a vendor terminal base holding float —
wrong shape for a WhatsApp wallet, formally declined.

## 2026-08-22 (3) — Card payers auto-register + 41-agent adversarial-review hardening

**Every card payer becomes a WaPay lead (founder ask)**: the pay page card leg is a POST form capturing the payer's WhatsApp number (required client-side; the API never blocks a payment on a bad/missing number — the requester getting paid outranks the growth hook). The number rides the SIGNED PayFast session (`custom_str1`), so the ITN sends the receipt to whoever actually paid — a later checkout click can never redirect it. Back from PayFast, `?r=1` renders a confirming state with NO pay buttons (double-charge guard) plus a "Get my receipt + my own WaPay" wa.me button (prefilled `Receipt PRXXXXXX`). The processor answers that ask for ANY sender BEFORE the onboarding gate — a brand-new payer gets their receipt, then falls straight into onboarding. The ITN pushes a purely-transactional receipt (free-form when the payer's service window is open; env-gated template fallback `wapay_payment_receipt` — spec in `docs/whatsapp-new-templates.md`, awaiting Meta creation + `WAPAY_TEMPLATE_PAYMENT_RECEIPT`).

**Adversarial review before ship (5 lenses × per-finding refuters, 41 agents): 28 confirmed findings, all fixed** — though a parallel-session push (`619a285`) briefly carried the PRE-fix versions to prod; this commit replaces them (BUGLOG #25). Highlights: `@wapay/whatsapp` send functions never throw — they resolve `{ok:false}` — so the catch-based template fallback was dead code (now branches on the result); last-click-wins receipt hijack → `custom_str1` binding with ITN persisting the true payer; payer number moved out of the GET query string (platform logs) into the POST body; `/api/health?config=1` now FAILS CLOSED behind `WAPAY_INTERNAL_API_KEY`; the receipt intercept is anchored + code-alphabet-restricted (`/i` matching had hijacked "receipt problems"/"is my receipt prepared"); a payer charged after the requester cancelled is never told "no payment was taken"; POPIA copy honesty (both uses of the number disclosed, no upsell inside push receipts, template spec stripped to pure Utility). BUGLOG #24. Suite 297/297, build green.

## 2026-08-22 (2) — Amount-change swap for payment requests

"Change my amount to R1000" now swaps in one step: the newest PENDING request is cancelled (old link announced dead), a fresh request is created at the new amount, and the forwardable message follows — links are single-use, so edit = cancel + recreate, standing behavior (deterministic matcher + orchestrator knowledge). PayFast real rate confirmed from stored ITN: 3.2% + R2.00 excl VAT — depositFeeCents defaults are correct, margin-positive on every card transaction. Suite 290/290.

## 2026-08-22 — Fee flip, question-answering, short domain prep, project constitution

- **Payment-request fee direction flipped (founder decision)**: the PAYER pays exactly the request amount (no fees, and the page says so); the card fee is deducted from what the REQUESTER receives. Creation copy quotes both outcomes upfront. Balance payments remain fully free.
- **Questions no longer trigger flows**: "Where does the money go when they pay me?" was hijacked into the create-request flow (live sighting) — interrogatives without create-verbs now escape to the AI, whose request-money knowledge is dialed in (mechanics, fee direction, instant balance landing).
- **Short pay-link domains prepped**: host rewrite for pleasepayme.co.za / pleasepayme.io → /pay/:code; PAYLINK_BASE_URL env switches generated links to the short domain the moment DNS is attached.
- **CLAUDE.md project constitution added**: money-safety + policy invariants, engineering discipline, parallel-session rules, and the context-handover policy — every Claude thread reads it automatically at session start.
- Verified: the emailed OTT issuer credentials are STALE (401) — the live key is the rotated one in local .env (GetBalance R100k confirmed). 269/269 tests.

## 2026-08-21 (2) — Full QA audit: 45-agent sweep, 38 confirmed findings, all money/critical/major fixed

Six-dimension adversarial audit over everything shipped this week (payment requests, deposit fee + ITN, voucher flows, routing/states, orchestrator contract, ledger invariants) + live SSR smoke of the public pay page against prod. Money-severity: timestamp-poisoned VAS settle idemKeys (every vend would deliver-but-not-charge — BUGLOG #17), payment-request card leg not exactly-once (#18), fee-free self voucher booking the R3 anyway (#20), Blu redemption 1-in-481 cash-strand (#17). Critical/major: PIN-attempt burning (#19), unreachable broke-checkout resume (#21), bearer-PIN strand on failed claim send (#22), and an 11-item routing/state batch (#23) incl. multilingual YES words, phone-as-amount, deposit-status vs deposit-link, contact-share hijack. Suite 269/269, build green. Known-open minors logged in BUGLOG #23.

## 2026-08-21 — 🙏 Payment requests ("please pay me") — shareable links, two payment legs

"Please pay me R150" / "payme link" (any language — REQUEST_MONEY orchestrator action, live-verified incl. isiZulu) creates a shareable request (`payment_requests`, prod-applied: PR-prefixed letters-only codes, R5–R3000, 7-day lazy expiry, PENDING→PAID exactly once). The user gets a forwardable message + `wapay.co.za/pay/<code>`. The public page (`pages/pay/[code].js`) offers both legs:

- **Pay from a WaPay balance — free**: deep-links back into WhatsApp ("Pay request <code>") → confirm → wallet PIN → `buildSend` (free spend→spend) posted with the request code as idemKey, so exactly ONE payer can ever pay it (a racing payer replays harmlessly and is told). Both sides get instant receipts; the requester is notified with their new balance.
- **Pay by card/EFT — no WaPay account needed**: `/api/pay/checkout` mints a PayFast intent (route `payrequest`, payer covers the banded payment fee, requester credited FACE) and the ITN marks the request PAID atomically. Every non-WaPay payer sees the get-your-own-WaPay hook.

Insufficient balance on the in-chat leg becomes the standard top-up checkout moment. `tests/payment-requests.test.mjs` (+11, suite 269/269). Also: OTT negotiation email drafted (`EMAIL_TO_OTT_NEGOTIATION.txt` — Payout asymmetries, Merchant 6% fee, ops annexure, Collect parked).

## 2026-08-20 (2) — User memory, GPT-5.5 brain, fee-free self vouchers, voucher history

- **Root cause of every live voucher failure found: `OTT_BASE_URL` (and the OTT credentials) were never set in Vercel** — the OTT client crashes at construction in production. USER ACTION: copy the four `OTT_*` vars from local `.env` into Vercel and redeploy. (The crash-release guard worked: the stranded hold auto-released with `execute_crashed:Missing env OTT_BASE_URL` — that log line was the diagnosis.)
- **User memory system** (`Account.profile` JSONB, prod-applied; `lib/user-profile.js`): language (evidence-counted — one foreign test line can't flip it), preferred deposit method (written by ITN success=CARD, redemption success=VOUCHER), last electricity meter, product interests. Injected into the orchestrator every turn as `KNOWN USER PROFILE`; deposit-with-amount offers BOTH load methods until the preference is known (then straight to their rail).
- **Language bug fixed** (bot answered "Okay" in isiZulu after one zu test line): reply language = the CURRENT message's language, history is context only, neutral messages fall back to the profile language. Live-verified.
- **Model upgrade: gpt-5.5 orchestrator + gpt-5.4-mini agents** (probed live; GPT-5-family params adapted — `max_completion_tokens`, `reasoning_effort: none`, no temperature). **Golden eval: 132/132 = 100%** across all 11 languages (up from 99.2% on gpt-4o), ~1s per call. Env-tunable as before.
- **Self OTT vouchers are fee-free** (fees belong on money-IN and on sending to others; WaPay still earns the OTT issuing commission). Copy: "⏳ Generating your OTT voucher..." for self ("sending" is reserved for sending to people).
- **Broke checkout**: insufficient balance for a voucher now quotes the shortfall, sends a PayFast button for exactly that top-up, and **resumes the purchase automatically** on the next message after the money lands (`RESUME_VOUCHER_PURCHASE`).
- **Voucher history + retrieval**: "my vouchers" lists date/value/serial/status from `pending_gifts`; "voucher pin <serial tail>" re-sends a PIN **behind the wallet PIN** (verifyPIN with lockout).
- Suite 258/258.

## 2026-08-20 — Deposit fee, OTT self-purchase, state escapes, policy sweep, ledger repair

Founder live-testing batch (first fully auto-credited deposit confirmed: R30 → "✅ Deposit received", closing the deposit E2E objective):

- **Deposit payment fee**: card/EFT deposits now charge gross = credit + fee (`depositFeeCents`: 4.2% + R2.30 rounded up to a rand — env-tunable `WAPAY_DEPOSIT_FEE_BPS`/`_FIXED_CENTS` until PayFast's real rate card is read). Quoted before the tap ("R30 deposit + R4 payment fee = *R34*", button pays gross); ITN verifies gross, credits face, books the fee to `REVENUE:FEE:DEPOSIT` (`buildLoad` gained `customerFeeCents`). Deposits are no longer loss-making.
- **OTT voucher self-purchase**: "buy an OTT voucher" (any phrasing/language — deterministic short-circuit + orchestrator `self=true`) → confirm (amount+fee) → wallet PIN → OTT issue → **PIN delivered in-session immediately** via the atomic claim flow. Insufficient balance becomes a checkout moment (shortfall + both load options). The stale "🎮 Lifestyle & OTT Vouchers" (Netflix/Uber) menu can no longer swallow OTT-voucher asks.
- **Trap-state escapes**: real sentences/questions inside `AWAITING_VOUCHER_PIN` and `DEPOSIT_CARD_AMOUNT` now escape to the full router (orchestrator included) instead of looping "Invalid Voucher PIN" (live sighting: "I want to use my bank account").
- **Policy/stale-content sweep (3-agent workflow, all fix-now findings applied)**: `showCategoryProducts` + context-aware follow-ups now coming-soon gated; "what can I buy" advertises live categories only; **every betting word scrubbed from WhatsApp-facing copy** (menus, gates, errors, keyword maps — Meta policy); 'ott'/'voucher'/'send money' keywords reserved for the money rail; no-API-key fallback menu cleaned; orchestrator HELP no longer teases cash-out. Dead code deleted: legacy `message-processor.js` (V1), `chat.ts`/`chatWithAI`, orphan AI states, `renderHome` dead vars.
- **Ledger repair + crash-proof holds** (BUGLOG #15/#16): R36 of stuck ACTIVE holds released, R20 unbacked double-credit removed — founder balance now R50.00 = exactly the journal. Voucher execute releases its hold in the outer catch on any crash.
- Suite 247/247.

## 2026-08-19 — 🎉 OTT float landed (R100k) + comma-amount parser fix — send-money UNBLOCKED

OTT IT Support loaded the R100,000 test float — and the very first balance check found a real bug: OTT formats large amounts with comma thousands separators (`"100,000.00"`) and `randToCents` rejected them, failing GetBalance. Fixed: well-formed comma grouping (and only that) is stripped before exact string-math parsing; malformed comma patterns still throw. This also protects voucher issuing at the R1000 cap (`"1,000.00"`). Live-verified: balance R100,000.00. New `tests/ott-rand-parsing.test.mjs`; suite 238/238. **The voucher-gift ("send money") live test is now unblocked.** Test vouchers for merchant redemption received from OTT (stored locally, gitignored — redemption client still needs OTT's Merchant API docs + credentials). Deposit cash-in copy expanded to the founder's step-by-step wording.

## 2026-08-19 — Contact-card sends, remembered beneficiaries, cash-vs-bank copy

Founder asks from live testing, all shipped:

- **Share a contact to send money**: the webhook now handles `contacts`-type messages (previously silently dropped). Mid-flow, a shared card fills the number the flow was asking for; fresh, it starts a send-money ask with the recipient prefilled ("💸 Send money to Philly (0798743910) — how much?"). Invalid/foreign numbers get a polite fallback.
- **Remembered beneficiaries** (`beneficiaries` table, applied to prod; `lib/beneficiaries.js`): every successful gift recipient and every shared contact is upserted per (account, msisdn) — names come from contact cards and are never overwritten with null. "send R50 to Philly" now resolves by name: new `recipientName` slot in the orchestrator (verified live: "send R50 to Philly" → SEND_VOUCHER + name), dispatch looks it up (unique hit proceeds, ambiguity lists options, miss asks for the number), and the `VOUCHER_GIFT_RECIPIENT` state accepts names too. The full number at confirm remains the human gate on every resolved name.
- **Deposit prompt rewritten — cash vs card/bank**: option 1 CASH (pay the cashier at any major retailer, get a Blu Voucher code, send it in); option 2 CARD/BANK (PayFast: cards, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan, Zapper). The orchestrator's product truth carries the same framing.
- **Withdrawals explained**: the balance is spend-only; cash-out runs through WaPay vouchers two ways — cash at participating retail partners, or paid into a bank account via PayShap (voucher-partner rails, rolling out). Withdrawal questions no longer fast-path to the generic help menu (verified live in en + af).
- **Deposit-status PENDING carries a retry line** — prompted by a live FNB decline (2026-08-19): the bank declined the charge on PayFast's page, so no ITN ever fires and the intent stays PENDING forever; the status answer now says nothing left the account and how to retry. (Server side was verified clean — the decline happened between FNB and PayFast.)
- Suite 233/233.

## 2026-08-18 — AI orchestration engine: two tiers, 11 languages, structured outputs

The single temperature-0.7 gpt-4o call (bare `JSON.parse` of free text) is replaced by a two-tier engine in `packages/ai/src/orchestrator.ts`:

- **Tier 1 — orchestrator (gpt-4o)**: detects language (all 11 official SA languages) + domain (MONEY/AIRTIME/DATA/ELECTRICITY/SEND/DISCOVER/CHAT), and completes trivially-clear intents in one call (fast path: balance, deposit status, help, home).
- **Tier 2 — category agents (gpt-4o-mini)**: per-domain slot extraction + a reply in the user's language.
- Every call uses OpenAI **strict structured outputs** at temperature 0 with 15s fail-fast timeouts. Models env-tunable (`WAPAY_ORCHESTRATOR_MODEL`, `WAPAY_CATEGORY_AGENT_MODEL`) for the later Claude migration.
- The processor's free-text path (`handleAIChat`) now dispatches through `dispatchOrchestratorAction`: model output is treated as **untrusted input** — msisdn re-validated (`normaliseMsisdn`+`isValidSaMsisdn`), amounts integer-checked, the model's meter slot deliberately never used (the flow collects meters). Actions map onto the SAME deterministic preview→PIN flows as the keyword router; `SEND_VOUCHER` reuses `resolveGift`. The engine proposes; it never executes.
- Prompts carry the money-truth rules (never state balances/status — return the action; the ledger answers) and the honest product list (no betting/Netflix claims).
- **Live eval: 132-case golden corpus** across all 11 languages with realistic typos/code-switching (`tests/fixtures/orchestrator-golden.json`, generated by 11 parallel language agents; harness `scripts/eval-orchestrator.mjs`): 99.2% first run, the single miss (EN redeem-voucher phrasing) fixed by a prompt sharpening and re-verified. Slot extraction (amounts to the cent, msisdns) 100% on hits.
- Wiring tests `tests/orchestrator-routing.test.mjs` lock the invariants (re-validation, no direct money movement in dispatch, strict schema, temp 0).
- **Adversarial review (4-dimension multi-agent workflow) found 9 issues, all fixed pre-ship**: worst-case latency cut from ~60s to ≤20s (10s timeouts, no provider retries inside the webhook budget); `productQuery` now routes to the smart product pipeline instead of dying in an unread entities key; coming-soon categories keep their gate on the AI path; a model-carried airtime recipient survives the amount ask; deposit ask joins conversation history; provider errors are logged before normalization. Plus three money-safety hardenings: **the voucher confirm + PIN prompt now show the FULL recipient number** (a model-proposed destination must be verifiable by the sender before a bearer voucher goes out — masking stays in logs); **receipt-shaped AI replies are deterministically blocked** (`looksLikeReceipt` — the official thread can no longer be tricked into minting fake proof-of-payment via "repeat after me" / translation attacks); **13+ digit runs are redacted** from logs and stored conversation history (`redactBearerDigits` — a 16-digit voucher PIN is money; phone numbers survive for slot-filling). Suite 222/222.

## 2026-08-18 — Deterministic deposit-status intent

"Did my payment go through?" / "where is my money" / "payment status" now short-circuit **before the AI path** to `handleDepositStatus`, which reads the account's newest PayFast intent (`getLatestDepositIntent`, newest-first by `requestTs`) and answers factually: SUCCESS → amount + live balance; PENDING → "PayFast is still confirming your R… — I'll message you here the moment it clears" (the ITN confirmation is that message); FAILED → plain statement + retry hint. Every reply carries the live balance, closing the founder's stale-balance complaint. The matcher (`matchDepositStatusRequest` in `lib/deposits.js`, pure) is deliberately narrower than the deposit-link pattern — "I want to deposit money" still routes to the deposit prompt. Tests: `tests/deposit-status.test.mjs` (+8, suite 209/209).

## 2026-08-18 — PayFast deposit UX: preamble + tappable button

The card-deposit reply is no longer a raw URL. `handleCardDepositLink` now sends a WhatsApp interactive **CTA-URL** message: a preamble that explains the round trip ("I'll take you to PayFast … pay by card or Instant EFT … you'll be brought straight back to this chat"), a *Secured by PayFast* footer, and a `Pay R<amount> now` button that opens the checkout. New `sendWhatsAppCtaUrl` / `buildCtaUrlPayload` in `@wapay/whatsapp` (pure payload builder, Meta limits enforced — 20-char button cap verified against the worst-case deposit amount). If the interactive send is rejected the handler logs `deposit_cta_fallback` and falls back to the old plain-text link — presentation can never block a payment. Tests: `tests/deposit-cta.test.mjs` (+8, suite 201/201).

## 2026-08-18 — `0253633` — PayFast modern ITN source range; wa.me return

The first real R20 deposit's ITN was rejected `SOURCE_IP_REJECTED`: PayFast's modern network (observed 102.216.36.1) postdates the documented 2019-era CIDR list. The range was added and the source-IP check demoted to warn-only unless `PAYFAST_ENFORCE_SOURCE_IP=true` (signature + server POST-back remain the strong checks). The R20 was credited manually with the intent's idemKey (replay-safe). Return/cancel URLs now deep-link to `wa.me/27760497624` so "Back to WaPay" reopens the chat instead of stranding the payer on the API landing page.

## 2026-08-18 — `8b19401` — Deposit option 2 collects an amount; single-screen bank home

Choosing card/EFT from the deposit menu now asks for the amount (new `DEPOSIT_CARD_AMOUNT` conversation state, accepts "20" / "R20" / "deposit R20", cancellable) instead of dead-ending. "hello"/"home" renders the single-screen bank-style home the founder approved.

## 2026-08-18 — `75370ba` — AI knows the real deposit options; typo-tolerant deposit routing

The AI prompt was answering deposit questions from stale knowledge (inventing options). Prompt now reflects the two real options (Blu voucher, card/EFT). Deposit intent matching made typo-tolerant; "home" escapes the voucher-PIN state.

## 2026-08-18 — `667b3a7` — PayFast money on-ramp

"deposit R100" in chat mints a signed PayFast checkout link (card/Instant EFT). `@wapay/providers-payfast` builds the checkout URL and verifies ITNs 5-step (signature over raw fields **including empty ones** and the merchant passphrase — review caught the passphrase omission that would have silently failed every live payment — plus source IP, amount, status, server confirmation). `lib/deposits.js` stores deposit intents whose row id is `m_payment_id` and whose derived idemKey makes ITN redeliveries credit exactly once. Verified ITN → ledger credit at FACE → WhatsApp confirmation with new balance. Caps R10–R3000. Root `pnpm test` fixed for Node 24 glob form. 193/193 tests.

## 2026-08-18 — `9c27da7` — Voucher gift: send money as an OTT-issued voucher

"Send R50 to 084…" became a real feature: preview (R3 flat fee) → YES → PIN → `reserveHold` → OTT `GetVoucher` (deterministic reference from the idemKey) → `ConfirmVoucher` → `settleHold` (category VOUCHER, rail OTT) → row in `pending_gifts`. The recipient gets the `wapay_voucher_received` template (no PIN in it); the voucher PIN is delivered when they reply — the claim **is** the onboarding loop. Timeout recovery per the OTT spec (`CheckVoucher` then confirm/reject); `RejectVoucher` + `releaseHold` when delivery is impossible. Voucher PINs never logged (static-test enforced). `pending_gifts` migration applied to prod. Docs (`CAPABILITIES.md`, `CHANGELOG.md`, `BUGLOG.md`) brought in-repo. 168/168 tests. Live E2E blocked on OTT float + Reseller agreement.

## 2026-08-18 — `6096585` — Mute-bot fix: await processing before ACK

The deployed webhook ACKed 200 to Meta and then processed the message in a fire-and-forget async block. Vercel serverless kills work after the response, so processing never ran and the bot went silent after the `44b51c9` deploy. This commit restores the correct ordering — verify signature → process the message (awaited) → ACK — and hardens it: the static wiring test now enforces the ordering and bans void-async in the webhook. Also gives the user-manager prisma import a `.js` extension so local simulation matches production module resolution. Bot confirmed working by the founder the same evening.

## ~2026-08-17 — `44b51c9` — Semantic search layer + OTT issuing client

Two additions (deployed to Vercel 2026-08-18):

- **Semantic search**: pgvector migration, `lib/vas-embeddings.js`, and `hybridProductSearch` in `lib/vas-search.js` — semantic-first product search with lexical fallback. 854/854 products were subsequently embedded (text-embedding-3-small) and live-verified. Not yet wired into the chat free-text path.
- **OTT client** (`@wapay/providers-ott`): voucher issuing client with `getVoucher / checkVoucher / confirmVoucher / rejectVoucher`, deterministic references, enforced timeout recovery (`TIMEOUT_CHECK_REQUIRED`), AUTH/USER_INPUT/RETRYABLE error taxonomy, and `GetAPIKey` protected (it rotates the live key). Sandbox GetBalance verified live.

## ~2026-08-16 — `83a68fe` — Voucher template rename

Recipient-notification template aligned to `wapay_voucher_received` (created in Meta, category Utility, pending approval). This is the template that lets gift/voucher notifications reach numbers that have never messaged the bot.

## ~2026-08-16 — `f9b52eb` — Catalog endpoint fix

The VAS catalog sync was calling a dead Blu endpoint and silently importing only 20 products. Fixed the endpoint; catalog went from 20 to 831 products. Account reset tooling added alongside.

## 2026-08-15 — `2360f18` — Money-safe ledger, webhook security, gifting

The foundation commit:

- **Ledger**: `lib/ledger-core.js` (chart of accounts, fee model, balanced-entry builders) + `lib/ledger-post.js` (atomic idempotent `postEntry`, `reserveHold/settleHold/releaseHold`, `claimMessage` dedupe, reconciliation) + Prisma migration `20260810_ledger_core` (two-tier wallets, unique idemKey, holds, processed_messages, CHECK constraints). Later verified 21/21 against the live DB.
- **Webhook security**: HMAC signature verification over the raw body wired into `pages/api/webhooks/whatsapp.js` (401 before ACK), leaked fallback verify-token removed, per-message dedupe.
- **Money-safe refactor**: airtime (reference pattern), then data and electricity execute routes moved onto ensureWallet → reserveHold → provider → settleHold/releaseHold; balance endpoint fixed (SPEND wallet, 503 on DB failure); preview routes gated behind internal auth.
- **Gifting** (`lib/gifting.js`): the V1 wedge — send airtime/data to another number as a SPEND (goods), never a transfer; bare cash-send refused and redirected; recipient notification template-aware.

## Before 2026-08-15 — pre-history (January baseline)

The original V1.01 build: WhatsApp onboarding (OTP, PIN, consent templates), Blu voucher redemption for wallet load, Blu VAS vending (airtime/data/electricity), single gpt-4o chat, Vercel deployment. Stable but money-unsafe (non-atomic flows, unsigned webhook) — the problems the 2026-08-15 commit exists to fix. See `docs/BUGLOG.md` for the specific defects found and closed.
