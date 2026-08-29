# Adversarial review — v1.3 (2026-08-29)

77 read-only agents (5 lens finders: money, security, conversation,
cross-repo contract, admin UI/ops; every finding independently attacked by
2 refuting verifiers). **34 findings confirmed, 2 refuted — all 34 fixed
and re-verified before ship** (full suite 478/478, money E2E 29/29, chat
E2E 13/13, qa:chat 10/10 after fixes).

## The load-bearing catches

| Sev | Finding | Fix |
|---|---|---|
| CRITICAL | A reconcile racing a slow Yoyo mint could mark the order failed → WaPay releases the hold while the card still lands | UniFuel order endpoint age-gates the not-found→failed verdict (120s); younger orders answer `ISSUANCE_IN_FLIGHT` |
| HIGH | RECONCILE previews had no reachable retry path — a customer hold could sit frozen forever | `lib/fuel-settlement.js` + an every-message reconciler that settles-and-delivers or releases-with-apology |
| HIGH | A settle failure after issuance refunded a customer whose wiCode existed | The crash guard disarms the moment the voucher exists; settle failures queue the idempotent retry |
| HIGH | Two concurrent PIN taps → two UniFuel issue POSTs | Atomic PENDING→EXECUTING flip on the preview + a deterministic UniFuel order id (PK dedupe, raced live: exactly one Yoyo card) |
| HIGH | The reconcile parser read `giftcards`/`giftCards` — Yoyo really returns `data.giftcardList` (probed live) | Parser fixed to the real shape (+ nested-card fallbacks); adoption verified against a live stuck order |
| HIGH | An adopted card without a wiCode looped `NO_WICODE_YET` forever | The order endpoint retries `generateWiCode` on every status read |
| HIGH | UniFuel's admin retry / cron could re-mint a wapay order under a userRef WaPay cannot see | Both paths refuse `wapay_issue` orders |
| HIGH | Fuel asks with amounts were eaten by waiting flows (no FUEL switch candidate) | `detectStrongIntentSwitch` gained the FUEL family + candidate |
| HIGH | Non-English/phrasal menu asks got a spend pitch missing deposit/balance | The spend answer now covers add-money and balance — a complete warm capability answer |

Also fixed: webhook replay/ordering guard + targeted single-gift claim +
optional dedicated secrets; issue-metadata size cap; fuel matcher no longer
swallows complaints/statements; out-of-bounds fuel asks re-prompt instead of
dead-ending; voucher-history exclusion narrowed to how-to-SPEND asks only;
fuel confirm copy built from the catalogue; localized dispatch fallbacks;
sender attribution preserved in claim sweeps; quoted flat fee actually
posted (`buildSpend flatFeeCents`); WaPay fuel max bounds aligned to the
UniFuel product cap; callback balance fallback no longer misreports partials
as full; ledger-query failure renders as unknown (never R0); TEST banner on
either data source; drift pill informational with direction; stats
truncation surfaced; `.dot`/`.ops` CSS defined; floats/UniFuel panels
survive a metrics failure; catalogue formatting guards.

Accepted risk (documented): Yoyo's callback to UniFuel is unauthenticated
per their spec — callback-auth is on the next Yoyo ask list.

Refuted (for the record): "double Yoyo mint" via the check-then-insert race
(closed mid-review by the deterministic order id, verified impossible), and
one duplicate of the same.
