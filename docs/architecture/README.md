# The Pay agent architecture map

The visual companion to `docs/AGENT_ARCHITECTURE_V2.md`, the architecture of
record. The published copy is https://claude.ai/artifact/LzMx7uSJLfbyJeRftpPuMB
(private; republished from these sources on every ship).

Sources (edit these, never the assembled page):

- `pay-agent-architecture.template.html`: the page with `<!--…-->` slots.
- `today-diagram.svg`, `target-diagram.svg`, `compare-diagram.svg`,
  `memory-diagram.svg`, `phase-map.svg`: the drawings (inline SVG, no scripts).
- `rows.json`: the sequence table, the phase plan, the handover mapping, the
  fix-now list and the disagreements.
- `claims.json`: the verified claims table (claim, verdict, evidence).

Build: `node docs/architecture/assemble.js` writes `pay-agent-architecture.html`
next to the sources. Open it in a browser to check, then publish it to the
artifact URL above (keeps the link).

Rule (founder decision 2026-09-17): every ship that changes what is true
about the architecture updates, in the same commit, section 13 of the design
record, the status badges in `target-diagram.svg` and `phase-map.svg`, and
the rows in `rows.json`; then republishes the page. The page is the map, the
design record is the territory.
