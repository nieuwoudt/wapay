# The incident responder

*Written 2026-11-18 (CHANGELOG 148). Founder: "When we pick these up, agents should instantaneously solve it. It
shouldn't be mailed to me and then me giving it to you."*

## What it is

An agent that reads the list of open findings, fixes what code can fix, proves the fix with a test, and closes the
finding with the commit that fixed it. The founder hears the outcome, or the one decision only he can make. He is
not the courier between an alert and the fix.

## Where its work comes from

One list, `GET /api/internal/incidents`, P1 first. It holds two kinds of row from the same table
(`audit_findings`, also shown on Mission Control → Health):

| Kind | Written by | When |
|---|---|---|
| Live alert (`live: true`) | `lib/incidents.js` `recordIncident`, called beside the alert | the moment it fires |
| Daily audit finding | `lib/audit/run.js` | 02:00 UTC every day |

Live alerts recorded today (`lib/incident-kinds.js`):

| Alert | Row says | Usual fix |
|---|---|---|
| The loop guard replaced a reply (`lib/loop-guard.js`) | the words the model asked for twice, the masked reply | handle the words by code before the model, or take them out of what the model reads |
| WaPay's own code sent a business-initiated message to a number that never wrote | the billing category, the guard's reason | find the sender that skipped `lib/outbound-guard.js` |
| Another sender on the number passed the daily alarm level | the count | not a code fix: UniFuel's deliveries, or the WhatsApp token (founder) |

Each row carries `title`, `why` (what happened), `fix` (where to look), `sampleBotQuote` and `sampleUserQuote`
(masked: no number of six digits or more, no known name), `occurrences`, `accounts` (a count) and `status`.
No customer number, name or account id leaves the route.

To record a new kind of alert: add a builder to `lib/incident-kinds.js`, call `recordIncident` beside the alert
(never ahead of it, never awaited alone on a customer's reply), and add it to the table above.

## The key

`x-responder-key: $WAPAY_RESPONDER_KEY` opens `/api/internal/incidents` and nothing else in the product
(`lib/responder-auth.js`; `tests/incidents.test.mjs` fails the build if a second file reads it). It cannot read a
customer, a balance or a conversation and cannot move money. Use it for a responder that runs outside the founder's
machine. A session that already holds the internal key may use that instead. 32 characters or more; set it in
Vercel and redeploy, and give the same value to the responder's environment as a secret, never in a prompt, a
commit or a document.

## The loop, per finding

1. **Read** the list. Empty: stop, report nothing.
2. **Take the first P1** that is not a founder decision (see "Not the responder's to fix"). One finding per run.
3. **Reproduce in a test first.** Write the failing test from the row's words: the phrase through the real
   matchers, the reply through `lib/loop-guard.js`, the fact against `lib/capabilities.js` and the fee tables.
   A finding that cannot be reproduced from the row and the code is reported as such, not guessed at.
4. **Fix** the cause in the code the row points at. The smallest change that makes the test pass.
5. **Prove**: `pnpm test` is green and `pnpm build` passes. Never commit or push a red test.
6. **Record**: a BUGLOG entry (symptom, root cause, fix, guard) and a CHANGELOG section, numbered from the files
   as they are at commit time.
7. **Hand over**: one commit, one pull request, titled with the finding's `ref`. The pull request says what was
   wrong, what changed, which test proves it, and what the founder should check after it is live.
8. **Close** only after the change is merged and live:
   `POST /api/internal/incidents { fingerprint, note }` with the commit and the BUGLOG number in the note. A finding
   that returns after it was closed reopens as recurring and keeps the note.

## Not the responder's to fix

The responder reports these to the founder in one line each and leaves the row open:

- anything that needs a setting changed in Vercel, Meta, a supplier's console or the database;
- a pay-out, a freeze, a refund, a chargeback, a limit or a fee: money decisions are the founder's;
- a customer who was promised a person: the founder (or an operator in Mission Control) writes the reply;
- a finding whose "truth" may itself be wrong (the audit says a method is not live and the code says it is):
  say which source disagrees with which, and stop;
- a fix that would change what a customer is charged, what they are told about fees or limits, or a legal text.

## Rules that do not bend

- The repository is public. Nothing from a finding that identifies a customer goes into a commit, a pull request
  or a document; describe the guarantee, not the incident.
- No message is sent to any customer, by any route.
- No production data is changed except closing a finding with a note.
- No credential is printed, stored in a file or put in a prompt.
- The golden thread (`docs/GOLDEN_THREAD.md`) and the WhatsApp rules (`docs/WHATSAPP_POLICY_COMPLIANCE.md`) hold
  for every fix: nothing business-initiated without the guard, one message per turn, no reminders.

## What the founder reads

One short message per run that did something: the finding, what was wrong in one sentence, the pull request, and
what he has to do (merge, or the decision that is his). A run that found nothing says nothing.
