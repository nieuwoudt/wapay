# Pay-out rules

Decided by the founder on 2026-10-20 after a morning in which R3,000 card payments were made
to the payer's own pay links and withdrawn within minutes. He chose not to hold card-funded
money and not to cap by funding source. The rules that apply instead:

| Rule | Default | Switch |
|---|---|---|
| New-account daily cap | R10,000 in any 24 hours while the account is under 7 days old, KYC or not | `WAPAY_PAYOUT_NEW_ACCOUNT_DAILY_CAP_CENTS`, `WAPAY_PAYOUT_NEW_ACCOUNT_DAYS` |
| KYC for one pay-out | R3,000 or more needs the identity check (threshold mode) | `WAPAY_PAYOUT_KYC_SINGLE_CENTS` |
| KYC for a day | more than R10,000 in 24 hours needs the identity check (threshold mode) | `WAPAY_PAYOUT_KYC_DAILY_CENTS` |
| KYC mode | `off` = none, `threshold` = the two rows above, anything else = everyone | `WAPAY_PAYOUT_KYC` |

"In 24 hours" is a rolling window from now over pay-outs that succeeded or are pending on the
rail. The rules are checked at the amount step of the withdraw flow and again in
`requestPayout` before any ledger move. The customer hears one line with the remaining amount
or the threshold; when the identity check is not configured (the three Didit variables) the
line says it is being switched on and names the amount that works now, so nobody is stuck.
A per-account freeze (`POST /api/internal/payout-freeze`) sits above all of this for a case
under review; `WAPAY_PAYOUT_ENABLED=false` stops every pay-out.
