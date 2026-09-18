# Agent eval 2026-09-18

Model: `gpt-5.5`. Cases: 156 (golden 132, agent 24).
Synthetic customer: withdraw live; PENDING PayShap R50 ref WPC15800A7BD6637; SUCCESS R20 deposit; one open pay link; two saved people.
Flags: limit none, lang all, concurrency 6.
Prices: $0/M in, $0/M out (env WAPAY_EVAL_PRICE_*).
Raw results: `agent-eval-2026-09-18.json`.

## Overall

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 156 | 99.4% | 100% | 100% | 99.4% | 0 | 1671 | 4792 | 746678 | 9452 | $0 |

## By language

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| af | 20 | 100% | 100% | 100% | 100% | 0 | 2133 | 4342 | 103487 | 1418 | $0 |
| en | 21 | 95.2% | 100% | 100% | 95.2% | 0 | 1816 | 3138 | 107708 | 1308 | $0 |
| nr | 12 | 100% | 100% | 100% | 100% | 0 | 1305 | 7209 | 55679 | 700 | $0 |
| nso | 12 | 100% | 100% | 100% | 100% | 0 | 1383 | 3884 | 55658 | 695 | $0 |
| ss | 12 | 100% | 100% | 100% | 100% | 0 | 1360 | 6749 | 51300 | 729 | $0 |
| st | 12 | 100% | 100% | 100% | 100% | 0 | 1455 | 5788 | 55625 | 752 | $0 |
| tn | 12 | 100% | 100% | 100% | 100% | 0 | 1340 | 4792 | 60035 | 674 | $0 |
| ts | 12 | 100% | 100% | 100% | 100% | 0 | 1569 | 6359 | 59998 | 696 | $0 |
| ve | 12 | 100% | 100% | 100% | 100% | 0 | 1545 | 4840 | 55626 | 677 | $0 |
| xh | 12 | 100% | 100% | 100% | 100% | 0 | 1398 | 4184 | 51320 | 645 | $0 |
| zu | 19 | 100% | 100% | 100% | 100% | 0 | 2267 | 5756 | 90242 | 1158 | $0 |

## By source

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| agent | 24 | 95.8% | 100% | 100% | 95.8% | 0 | 2777 | 4342 | 143214 | 1962 | $0 |
| golden | 132 | 100% | 100% | 100% | 100% | 0 | 1499 | 4792 | 603464 | 7490 | $0 |

## By group (agent cases)

| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ack | 4 | 100% | 100% | 100% | 100% | 0 | 1682 | 2492 | 17065 | 167 | $0 |
| aside | 3 | 100% | 100% | 100% | 100% | 0 | 2644 | 2917 | 17632 | 231 | $0 |
| complaint | 3 | 100% | 100% | 100% | 100% | 0 | 2981 | 3593 | 12814 | 320 | $0 |
| disambiguation | 2 | 100% | 100% | 100% | 100% | 0 | 2948 | 3085 | 17228 | 184 | $0 |
| discovery | 3 | 66.7% | 100% | 100% | 66.7% | 0 | 2777 | 2792 | 12811 | 276 | $0 |
| fees | 3 | 100% | 100% | 100% | 100% | 0 | 4342 | 5756 | 26705 | 394 | $0 |
| status | 3 | 100% | 100% | 100% | 100% | 0 | 3292 | 4102 | 21516 | 241 | $0 |
| withdraw | 3 | 100% | 100% | 100% | 100% | 0 | 1403 | 3511 | 17443 | 149 | $0 |

## Misses (1)

- **agent/en/discovery-what-can-i-do** "what can i actually do with wapay?"
  want reply|proposal NONE
  got  reply NONE tools=[reply] failed=[list]
  text: Thabo, with WaPay you can spend, send, add money and get paid from this chat 📱✨ You can: Buy airtime, data and prepaid electricity. Send money to any SA number
