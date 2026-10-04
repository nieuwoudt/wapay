# The WaPay Money Map

The commercials dashboard: every component of money in, money out, vending, getting
paid, sending and business, with the counterparty, our cost excluding and including the
VAT WaPay cannot recover, what the customer pays and who pays it, the margin at R50,
R200, R500, R1,000 and R3,000, and a status per number (SIGNED, LIVE, ASSUMED, PROPOSED,
UNKNOWN) with its source. The text master is `docs/COMMERCIALS.md`; the published copy
is the private artifact whose URL is in `docs/HANDOVER_COMMERCIALS_V1.md` section 1.

Sources (edit these, never the assembled page):

- `rows.json`: every row, its numbers, statuses, sources, limits, the open question and
  its owner; the status vocabulary; the cross-cutting questions. The single source of truth.
- `model.js`: the fee arithmetic the page runs in the browser, a mirror of
  `lib/ledger-core.js` and `lib/deposits.js` written without imports so it can be inlined.
- `money-map.template.html`: the page with `<!--…-->` slots.
- `sync-from-code.mjs`: snapshots what the code charges into `code-facts.json`
  (`node docs/commercials/sync-from-code.mjs --build <hash>`).
- `assemble.mjs`: writes `money-map.html` and rewrites the generated block between the
  `MONEY_MAP_TABLES` markers in `docs/COMMERCIALS.md`.

Build: `node docs/commercials/sync-from-code.mjs --build <hash> && node docs/commercials/assemble.mjs`,
then `pnpm test`. `tests/commercials-consistency.test.mjs` proves `model.js`, `rows.json`
and `code-facts.json` equal the charging functions at the reference amounts and across
every amount the product accepts, that every number has a status and a source, that every
ASSUMED, PROPOSED or UNKNOWN number has a sign-off question, and that the page and the
markdown block are current. A fee change in code without a re-sync fails the suite on purpose.

Rules: no fee is changed here (every fee change is a founder decision surfaced as a
question); where code and a document disagree, the code is what is charged today and the
document is the proposal; no em dashes anywhere the founder will send; republish the page
by passing the artifact URL so the link stays.
