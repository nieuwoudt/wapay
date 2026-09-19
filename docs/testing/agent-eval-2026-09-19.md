# Agent eval 2026-09-19

Model: `gpt-5.5`. Cases: 166 (golden 132, agent 34).
Synthetic customer: withdraw live; PENDING PayShap R50 ref WPC15800A7BD6637; SUCCESS R20 deposit; one open pay link; two saved people.
Flags: limit none, lang all, concurrency 4.
Prices: $0/M in, $0/M out (env WAPAY_EVAL_PRICE_*).
Raw results: `agent-eval-2026-09-19.json`.

## Overall

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 166 | 98.2% | 98.8% | 99.4% | 99.4% | 0 | 1672 | 4560 | 837982 | 9960 | $0 |

## By language

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| af | 23 | 100% | 100% | 100% | 100% | 0 | 1859 | 4247 | 129864 | 1599 | $0 |
| en | 26 | 92.3% | 96.2% | 100% | 96.2% | 0 | 1753 | 2810 | 138315 | 1513 | $0 |
| nr | 12 | 100% | 100% | 100% | 100% | 0 | 1320 | 6138 | 57849 | 686 | $0 |
| nso | 12 | 100% | 100% | 100% | 100% | 0 | 1235 | 4952 | 62373 | 735 | $0 |
| ss | 12 | 100% | 100% | 100% | 100% | 0 | 1672 | 5671 | 57843 | 680 | $0 |
| st | 12 | 100% | 100% | 100% | 100% | 0 | 1139 | 5144 | 62339 | 704 | $0 |
| tn | 12 | 100% | 100% | 100% | 100% | 0 | 1073 | 4917 | 57851 | 672 | $0 |
| ts | 12 | 91.7% | 91.7% | 91.7% | 100% | 0 | 1572 | 3604 | 57795 | 567 | $0 |
| ve | 12 | 100% | 100% | 100% | 100% | 0 | 1480 | 3761 | 57797 | 694 | $0 |
| xh | 12 | 100% | 100% | 100% | 100% | 0 | 1242 | 4769 | 53324 | 703 | $0 |
| zu | 21 | 100% | 100% | 100% | 100% | 0 | 1893 | 4560 | 102632 | 1407 | $0 |

## By source

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| agent | 34 | 94.1% | 97.1% | 100% | 97.1% | 0 | 1992 | 4247 | 197386 | 2448 | $0 |
| golden | 132 | 99.2% | 99.2% | 99.2% | 100% | 0 | 1480 | 4917 | 640596 | 7512 | $0 |

## By group (agent cases)

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ack | 4 | 100% | 100% | 100% | 100% | 0 | 1531 | 1992 | 17733 | 147 | $0 |
| aside | 4 | 100% | 100% | 100% | 100% | 0 | 2477 | 3633 | 27418 | 291 | $0 |
| complaint | 3 | 100% | 100% | 100% | 100% | 0 | 2709 | 4024 | 17819 | 306 | $0 |
| disambiguation | 2 | 100% | 100% | 100% | 100% | 0 | 2954 | 3040 | 17896 | 189 | $0 |
| discovery | 7 | 71.4% | 85.7% | 100% | 85.7% | 0 | 2337 | 4247 | 35712 | 652 | $0 |
| fees | 3 | 100% | 100% | 100% | 100% | 0 | 3465 | 3983 | 22943 | 305 | $0 |
| not-live | 2 | 100% | 100% | 100% | 100% | 0 | 1815 | 1859 | 8871 | 139 | $0 |
| paylink | 3 | 100% | 100% | 100% | 100% | 0 | 1027 | 1251 | 13320 | 63 | $0 |
| status | 3 | 100% | 100% | 100% | 100% | 0 | 2810 | 4560 | 22351 | 227 | $0 |
| withdraw | 3 | 100% | 100% | 100% | 100% | 0 | 1548 | 1946 | 13323 | 129 | $0 |

## Baseline: `docs/testing/agent-eval-baseline.json`

- action accuracy: 100% -> 98.8% (-1.2 points)
- p95 latency: 4792 ms -> 4560 ms (-4.8%)
-   af: action 100% -> 100%, p95 4342 -> 4247 ms
-   en: action 100% -> 96.2%, p95 3138 -> 2810 ms
-   nr: action 100% -> 100%, p95 7209 -> 6138 ms
-   nso: action 100% -> 100%, p95 3884 -> 4952 ms
-   ss: action 100% -> 100%, p95 6749 -> 5671 ms
-   st: action 100% -> 100%, p95 5788 -> 5144 ms
-   tn: action 100% -> 100%, p95 4792 -> 4917 ms
-   ts: action 100% -> 91.7%, p95 6359 -> 3604 ms
-   ve: action 100% -> 100%, p95 4840 -> 3761 ms
-   xh: action 100% -> 100%, p95 4184 -> 4769 ms
-   zu: action 100% -> 100%, p95 5756 -> 4560 ms

No regression.

## Misses (3)

- **golden/ts/balance-typo** "ndzi kombela ku vona balence ya mina"
  want reply NONE
  got  proposal HOME tools=[show_home] failed=[action,outcome]
- **agent/en/discovery-what-can-i-do** "what can i actually do with wapay?"
  want reply|proposal NONE
  got  reply NONE tools=[reply] failed=[list]
  text: Thabo, you can use WaPay for everyday money jobs from WhatsApp 💡 What you can do: See your balance and recent transactions Buy airtime, data or prepaid electri
- **agent/en/howto-steps** "how do I load a voucher into my wallet"
  want reply|proposal NONE
  got  proposal REDEEM_VOUCHER tools=[start_voucher_load] failed=[action]
