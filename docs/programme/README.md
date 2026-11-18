# The programme board

One consolidated picture of every workstream, working session and open item
(founder 2026-11-13). Two readers:

- **Management view**: what needs the founder, what waits on a supplier, what
  to watch, one line per workstream, what shipped lately.
- **Build view**: every item per workstream with its owner, its evidence and
  the session that holds it; plus the sessions, the security sweep and the
  architecture components.

It is shown in two places from one master file:

| Where | Address | Needs |
|---|---|---|
| Mission Control | `/admin?tab=programme` | an admin session |
| A private page | published with the Artifact tool by the session that updates the board | the founder's Claude account |

## Where the content lives, and why

**The repository is public. The board's content is not.** It carries security
findings, fraud specifics and what is waiting on whom. So:

- The **master** is `WAPAY_PROGRAMME_BOARD.json` in the private workspace
  folder that holds this repository (one level above it). It is never
  committed, never copied into `docs/`, never pasted into a commit message.
- The **published snapshot** is one finished row in `agent_jobs` (kind
  `programme-board`, key `current`, status `DONE`, the board in `result`). The
  job drain claims only `PENDING` and stale `RUNNING` rows, so it never touches
  this one. No migration, no money path.
- This folder holds only the **machinery**: the page template, this file.
  `lib/programme-board.js` holds the shape and the checks.

## What the board may never carry

`validateBoard` refuses the board, in the script and again at the route, when
it holds any of these:

- a run of nine or more digits (a phone, account, ID or voucher number): write
  the masked tail, `•••1332`;
- a database address, a payment-provider key, a GitHub or Meta token, a bearer
  token, a private key.

Beyond what a pattern can catch: no customer names, no voucher PINs, no
passwords, no one-time codes. A supplier contact is named by first name and
company only.

## Updating it

1. Edit the master. Every item keeps its `id` for life; a finished item
   becomes `DONE` with the commit in `evidence` rather than being deleted, and
   moves out of the master only when it is more than a month old.
2. Check it: `node scripts/programme-board.mjs check`
3. Publish the snapshot: `node --env-file=<your .env> scripts/programme-board.mjs publish`
   (needs `WAPAY_INTERNAL_API_KEY`; Mission Control shows the new board at once, no deploy).
4. Build the page: `node scripts/programme-board.mjs page`, then republish the
   private page to the same address with the Artifact tool.

A session that changes what is true (ships something, learns a supplier
answered, finds a bug) updates the items it owns before it ends. The main
session reconciles the whole board; a scheduled daily run refreshes the
production reading and the dates.

## The shape

```
{ schema: 1, asOf, build, updatedBy, boardUrl,
  pulse:       [{ label, value, state: good|warn|crit|info, note }],
  workstreams: [{ id, name, state: green|amber|red|parked, summary, live[], next, threads[] }],
  items:       [{ id, ws, title, status, owner, kind, priority, due, blockedOn, detail, evidence, asOf, thread }],
  threads:     [{ id, title, state: active|idle|closed, lastActive, role, leftOff, link }],
  security:    { sweptAt, summary, findings: [{ id, title, severity, verdict, status, where, scenario, fix, fixRisk, commit }] },
  architecture:{ mapUrl, mapVersion, phase, components: [{ id, name, state, note }], subsystems: [{ name, state, doc, note }] },
  docs:        [{ doc, state: current|stale|new, note }],
  shipped:     [{ date, what, ref }] }
```

- `status`: `OPEN`, `IN_PROGRESS`, `BLOCKED`, `DECISION` (the founder must
  choose), `WATCH` (a risk, no action today), `PARKED`, `DONE`.
- `owner`: `founder`, `main`, `thread:<thread id>`, `supplier:<name>`.
- `priority`: `P0` money or customers are exposed now, or a date is days away;
  `P1` this week; `P2` this month; `P3` someday.
- `kind`: `decision`, `action`, `build`, `verify`, `supplier`, `security`,
  `ops`, `legal`.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/admin/programme` | admin session | the snapshot, for the tab |
| `GET /api/internal/programme` | internal key | counts and dates only, never the content |
| `POST /api/internal/programme` | internal key | validate and store `{ board, by }` |

Tests: `tests/programme-board.test.mjs`.
