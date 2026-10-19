# Review brief for a conversation shard (2026-10-19)

Read the whole shard. Judge the bot against what is true today, never against what you
assume. Since 2026-10-19 the "what is true today" block is GENERATED at run time by
`truthBlock()` in `lib/audit/brief.js` from the registries (`lib/capabilities.js`,
`lib/vas-config.js`, `feeSchedule()`, the pay-out methods on production), and the daily audit
(docs/audits/DAILY_AUDIT.md) hands the reviewer that block, this rubric, and
docs/audits/PROCESS_CHECKS.md. For a review by hand, print it with
`node -e "import('./lib/audit/brief.js').then((m) => console.log(m.truthBlock()))"`.
Flag one finding per distinct problem and group repeats across accounts.

- **P1:** a wrong fact (fees, limits, what is live, methods that do not exist), a money intent
  executed wrongly or not at all, a security or privacy problem, a customer told something
  impossible or harmful, a coming-soon product sold or started.
- **P2:** a customer stuck or looping, an unanswered message, a menu dump to a specific
  question, a contradiction between two bot turns, language mishandling, a promise of a date
  or a person that never came, the business flow misfiring.
- **P3:** tone and clarity, small copy errors, missed opportunities.

Correct behaviour that is not a bug: the three-tier gate at a R0 balance (the third tier asks
a person); coming-soon answers for airtime, data, electricity, fuel, vouchers, virtual cards,
cash deposits at a till, in-store payments and bills; the invite-only business list.

Every finding quotes the exact bot line (at most 200 characters) and the customer line before
it, names the accounts and timestamps, says why it is wrong, and suggests a fix in one or two
sentences. Also report patterns (what customers try that WaPay cannot do yet, where sign-ups
drop, questions the bot could not answer) and what worked well.
