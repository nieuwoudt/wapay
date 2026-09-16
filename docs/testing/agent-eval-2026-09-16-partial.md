# Agent eval 2026-09-16

Model: `gpt-5.5`. Cases: 12 (golden 12, agent 0).
Synthetic customer: withdraw live; PENDING PayShap R50 ref WPC15800A7BD6637; SUCCESS R20 deposit; one open pay link; two saved people.
Flags: limit 12, lang en, concurrency 4.
Prices: $0/M in, $0/M out (env WAPAY_EVAL_PRICE_*).
Raw results: `agent-eval-2026-09-16-partial.json`.

## Overall

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 12 | 91.7% | 91.7% | 91.7% | 100% | 0 | 1911 | 3681 | 53600 | 699 | $0 |

## By language

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| en | 12 | 91.7% | 91.7% | 91.7% | 100% | 0 | 1911 | 3681 | 53600 | 699 | $0 |

## By source

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| golden | 12 | 91.7% | 91.7% | 91.7% | 100% | 0 | 1911 | 3681 | 53600 | 699 | $0 |

## Misses (1)

- **golden/en/redeem-voucher** "i bought a blu voucher at the shop, how do i load it"
  want proposal|clarify REDEEM_VOUCHER
  got  reply NONE tools=[how_it_works,reply] failed=[action,outcome]
  text: To load your Blu voucher, send me the voucher code here. I’ll start the secure redeem flow and it will ask for the PIN. 💡 The voucher network keeps 6%, so a R1
