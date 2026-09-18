# Agent eval 2026-09-18

Model: `gpt-5.5`. Cases: 156 (golden 132, agent 24).
Synthetic customer: withdraw live; PENDING PayShap R50 ref WPC15800A7BD6637; SUCCESS R20 deposit; one open pay link; two saved people.
Flags: limit none, lang all, concurrency 4.
Prices: $0/M in, $0/M out (env WAPAY_EVAL_PRICE_*).
Raw results: `agent-eval-2026-09-18.json`.

## Overall

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 156 | 99.4% | 100% | 100% | 99.4% | 0 | 1892 | 5336 | 768892 | 9413 | $0 |

## By language

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| af | 20 | 100% | 100% | 100% | 100% | 0 | 2141 | 4304 | 105094 | 1374 | $0 |
| en | 21 | 95.2% | 100% | 100% | 95.2% | 0 | 1892 | 2906 | 109658 | 1148 | $0 |
| nr | 12 | 100% | 100% | 100% | 100% | 0 | 1449 | 5558 | 52241 | 701 | $0 |
| nso | 12 | 100% | 100% | 100% | 100% | 0 | 1640 | 5793 | 61127 | 753 | $0 |
| ss | 12 | 100% | 100% | 100% | 100% | 0 | 1371 | 6541 | 56687 | 676 | $0 |
| st | 12 | 100% | 100% | 100% | 100% | 0 | 1444 | 5119 | 61093 | 677 | $0 |
| tn | 12 | 100% | 100% | 100% | 100% | 0 | 1420 | 7296 | 61127 | 726 | $0 |
| ts | 12 | 100% | 100% | 100% | 100% | 0 | 1315 | 6864 | 61089 | 706 | $0 |
| ve | 12 | 100% | 100% | 100% | 100% | 0 | 1489 | 4485 | 56640 | 678 | $0 |
| xh | 12 | 100% | 100% | 100% | 100% | 0 | 2400 | 5076 | 52256 | 636 | $0 |
| zu | 19 | 100% | 100% | 100% | 100% | 0 | 2187 | 6189 | 91880 | 1338 | $0 |

## By source

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| agent | 24 | 95.8% | 100% | 100% | 95.8% | 0 | 2773 | 4304 | 145522 | 1874 | $0 |
| golden | 132 | 100% | 100% | 100% | 100% | 0 | 1551 | 5558 | 623370 | 7539 | $0 |

## By group (agent cases)

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ack | 4 | 100% | 100% | 100% | 100% | 0 | 1911 | 2773 | 17377 | 188 | $0 |
| aside | 3 | 100% | 100% | 100% | 100% | 0 | 2802 | 2985 | 17944 | 224 | $0 |
| complaint | 3 | 100% | 100% | 100% | 100% | 0 | 3867 | 4304 | 17481 | 311 | $0 |
| disambiguation | 2 | 100% | 100% | 100% | 100% | 0 | 2906 | 3126 | 17540 | 160 | $0 |
| discovery | 3 | 66.7% | 100% | 100% | 66.7% | 0 | 2469 | 2856 | 13045 | 281 | $0 |
| fees | 3 | 100% | 100% | 100% | 100% | 0 | 3834 | 5336 | 27173 | 345 | $0 |
| status | 3 | 100% | 100% | 100% | 100% | 0 | 2811 | 3867 | 21906 | 224 | $0 |
| withdraw | 3 | 100% | 100% | 100% | 100% | 0 | 1638 | 3052 | 13056 | 141 | $0 |

## Baseline: `docs/testing/agent-eval-baseline.json`

- action accuracy: 100% -> 100% (+0 points)
- p95 latency: 4792 ms -> 5336 ms (+11.4%)
-   af: action 100% -> 100%, p95 4342 -> 4304 ms
-   en: action 100% -> 100%, p95 3138 -> 2906 ms
-   nr: action 100% -> 100%, p95 7209 -> 5558 ms
-   nso: action 100% -> 100%, p95 3884 -> 5793 ms
-   ss: action 100% -> 100%, p95 6749 -> 6541 ms
-   st: action 100% -> 100%, p95 5788 -> 5119 ms
-   tn: action 100% -> 100%, p95 4792 -> 7296 ms
-   ts: action 100% -> 100%, p95 6359 -> 6864 ms
-   ve: action 100% -> 100%, p95 4840 -> 4485 ms
-   xh: action 100% -> 100%, p95 4184 -> 5076 ms
-   zu: action 100% -> 100%, p95 5756 -> 6189 ms

No regression.

## Misses (1)

- **agent/en/discovery-what-can-i-do** "what can i actually do with wapay?"
  want reply|proposal NONE
  got  reply NONE tools=[reply] failed=[list]
  text: You can use WaPay for everyday money jobs, Thabo 😊 What you can do: Check your balance and recent activity Buy airtime, data and prepaid electricity Send money
