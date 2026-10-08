# Pay-out commercials: what each withdrawal costs us, what we charge, and where the margin is

*Written 2026-10-04 by the payouts thread, the morning the first customer withdrawal completed on the OTT sandbox (Nedbank cardless R20, reference WPB4D27FAF672A7E, OTT 126382). Every rand in the tables below is computed by the same functions that book the ledger (`lib/ledger-core.js`: `cashoutFeeCents`, `cashoutRailCostCents`, `cashoutMarginCents`); the Money Map thread's `tests/commercials-consistency.test.mjs` fails if this document's numbers and the code drift. Change the code, then regenerate; never edit a number here by hand.*

## 1. The one thing to hold in mind

OTT quotes every rail cost **excluding VAT** and WaPay is **not VAT-registered**, so the VAT is a real cost we cannot reclaim. Every cost below is therefore the addendum rate multiplied by 1.15, rounded up to the cent. Comparing an ex-VAT cost to an inc-VAT customer fee overstates margin by 15%; `inclVatCents` in the ledger grosses every cost up before any margin is computed, and `tests/payout-fees.test.mjs` refuses a rail cost that is not grossed up.

## 2. What OTT charges us (Annexure A of the Payout Agreement, signed by WaPay 2026-08-25 and co-signed by OTT 2026-09-10; the 2026 Addendum template in `OTT Onboarding /` restates the same rates)

| Provider on the merchant | OTT code | Addendum clause | Fixed, ex VAT | Switching | Fixed, inc VAT (ours) | Status |
|---|---|---|---|---|---|---|
| PayShap Account | 127 | 1.3 | R2.50 | none (Bank EFT product) | R2.88 | **SIGNED** (Annexure A); applied rate unverified until OTT's statement; OTT may reprice on 30 days' notice |
| RTC (bank transfer) | not on the test merchant | 1.4 | R4.50 | none | R5.18 | **SIGNED** (Annexure A); RTC not enabled for us (asked in email 9) |
| Nedbank Cardless Withdrawal | 4 | 1.1 | R9.96 | 0.3% of monthly completed value, ex VAT | R11.46 + 0.345% | **SIGNED** (Annexure A); applied rate unverified until OTT's statement |
| ABSA CashSend | 112 | 1.2 | R9.96 | 0.3% of monthly completed value, ex VAT | R11.46 + 0.345% | **SIGNED** (Annexure A); applied rate unverified until OTT's statement |
| FNB e-wallet | 1 | **not in the addendum** | **unknown** | unknown | assumed = CashSend | **ASSUMED** since 2026-09-15; asked in email 9, no answer |
| Reversals (Nedbank, ABSA) | | 1.6 | R10.00 each | | R11.50 | not modelled in the ledger (see §7) |
| VAS products | | 1.5 | 1% commission + 0.3% switching | | | not a pay-out |

**Production observation, 2026-10-08:** the first three live pay-outs (PayShap R50, Nedbank cardless R20, ABSA CashSend R50) moved the production float from R500.00 to R356.98: R143.02 for R120.00 of pay-outs, so OTT deducted **R23.02** in fees, against this document's R26.05 inc VAT and R22.63 ex VAT. The float is debited close to the ex-VAT rates; VAT is presumably invoiced separately, which is why the ledger must keep booking the inc-VAT cost. The per-transaction split (and the R0.39 difference to the ex-VAT sum) is a question for OTT's statement.

Two facts from the sandbox run of 2026-10-04 that the addendum does not explain:

- The sandbox float moved from R99,939.96 (2026-10-03) to R99,857.27 (2026-10-04 07:37 UTC) across three attempts worth R70 of pay-outs (Nedbank R20 paid, PayShap R50 still pending at OTT, CashSend R50 failed at the provider). That is R82.69 out for R70 of value: R12.69 of deductions that match no combination of the addendum rates exactly (the nearest is R9.96 + R2.50 + 0.3% of R70 = R12.67). Whether a failed CashSend is charged, whether a pending PayShap is debited at creation, and whether VAT is deducted from the float are questions for OTT's statement (email 11).
- The "0.3% switching on the total value of payments completed per month" is a monthly aggregate, not a per-transaction line. The ledger accrues it per transaction at the same rate so every pay-out's margin is honest; the monthly invoice will match only on completed payments, so a reversed or failed pay-out that OTT still charges switching on would show up as a small difference.

## 3. What we charge the customer today (`FEES.cashout`, founder decision 2026-09-11: the 2026-08-10 numbers plus R2 on every method)

| Method in chat | Customer fee (flat, banded, inc. everything) | Minimum / maximum on the sandbox merchant |
|---|---|---|
| PayShap to own bank account | **R8** | R50 to R3,000 (product cap; OTT allows R150,000) |
| Bank transfer (RTC) | **R10** | not offered: no RTC provider on the merchant |
| Cash at a Nedbank ATM | **R18** up to R700, **R23** to R1,500, **R30** above | R20 (portal system minimum R10, ours R20) to R3,000 |
| Cash at an Absa ATM / Pick n Pay / Boxer (CashSend) | **R18 / R23 / R30** by the same bands | R50 to R3,000 |
| FNB eWallet | **R18 / R23 / R30** (mirrors CashSend because the cost is assumed equal) | R20 to R3,000 |

The customer sees exactly one fee line per method, the same in the menu (`lib/payout-chat.js methodLine`), the fee answer (`lib/fee-facts.js withdrawLines`), the how-it-works brief (`lib/how-it-works.js`), the generated knowledge base (`docs/CONVERSATION_KNOWLEDGE_BASE.md`) and the confirmation step, because all five read `cashoutFeeCents`.

## 4. Margin per pay-out at R50, R200, R500, R1,000 and R3,000 (computed 2026-10-04 from the live fee functions)

Cost = fixed inc VAT + switching inc VAT on the amount. Margin = fee minus cost.

| Method | R50 | R200 | R500 | R1,000 | R3,000 |
|---|---|---|---|---|---|
| **PayShap** fee R8, cost R2.88 | **+R5.12** | +R5.12 | +R5.12 | +R5.12 | +R5.12 |
| **RTC** fee R10, cost R5.18 | +R4.82 | +R4.82 | +R4.82 | +R4.82 | +R4.82 |
| **Nedbank cash** fee R18/R23/R30, cost R11.64 / R12.15 / R13.19 / R14.91 / R21.81 | **+R6.36** | +R5.85 | +R4.81 | +R8.09 | +R8.19 |
| **ABSA CashSend** (same table) | +R6.36 | +R5.85 | +R4.81 | +R8.09 | +R8.19 |
| **FNB eWallet** (assumed cost) | +R6.36 | +R5.85 | +R4.81 | +R8.09 | +R8.19 |

Margin as a share of the fee: PayShap 64%, RTC 48%, cash 27% to 35%. Margin as a share of the amount withdrawn at R50: 10% (PayShap) and 13% (cash); at R3,000: 0.17% and 0.27%. The cash bands are deliberately tight at their tops: at R700 the cost is R13.88 against an R18 fee (+R4.12), at R1,500 it is R16.64 against R23 (+R6.36), at R3,000 it is R21.81 against R30 (+R8.19). Every method is margin-positive at every rand from R50 to R3,000 (`tests/payout-fees.test.mjs` sweeps the whole range), and the old flat R14 CashSend fee is kept in that test as the witness of the trap: it went underwater at about R738.

## 5. The competitor benchmark (prices the customer sees elsewhere; dated 2026-09-11 unless noted, memory `wapay-artifacts-index` and `ewallet-real-pricing-2026`)

| What a South African pays today | Price | Who pays |
|---|---|---|
| PayShap from their own bank app | R0 to R2 (Capitec R1 in-network, R2 to any bank, 2026-06) | the sender |
| Absa CashSend from an Absa account | R16 (R32 above the first band) | the sender |
| FNB eWallet send | R10 (Easy accounts), R11 up to R500 and R30 above on other tiers; **the recipient's first ATM withdrawal and all retail cash-outs are free** (FNB 2026/27 guides, verified 2026-08-27) | the sender |
| Capitec Send Cash | R10 per R1,000 | the sender |
| Standard Bank Instant Money | R10 / R20 / R30 by band | the sender |
| Shoprite / Checkers money transfer | about R9.99 (unverified: the pages 404) | the sender |
| Pay@ cash pay-out at Pick n Pay | R8.65 ex VAT to the merchant (R9.95 inc) | the business |
| Hyphen / Ozow bank pay-outs (B2B) | R3 to R7 per pay-out | the business |

Read honestly: **nobody in this table sells what we sell** (a wallet balance that came in by card, voucher or request, leaving as PayShap or cash), but every one of them is the mental price anchor the customer carries. Against those anchors our PayShap at R8 is four to eight times a bank's PayShap, and our R18 cash is the dearest cash send on the list, R2 above Absa's own R16 and R7 above FNB's R11. The 2026-09-11 memory already records the founder's rule that follows from this: **never market withdrawals as cheaper than the banks**; the story that holds is free WaPay-to-WaPay sending, free pay links under R50, and the request capability that eWallet does not have.

## 6. Where we lose, and where we only look like we lose

1. **Reversals.** A Nedbank or ABSA cash send that is never collected is reversed and OTT charges R10 ex VAT (R11.50). The ledger books the rail cost at settlement and nothing on reversal, so an uncollected R50 cash send that earned R6.36 ends R5.14 down once the reversal lands. The first month of real cash sends will tell us the uncollected rate; until then, assume 5% uncollected and the cash margin at R50 drops from R6.36 to about R5.78 on average.
2. **The FNB eWallet assumption.** If OTT prices e-wallet above CashSend (FNB's own wholesale is unknown to us), the R18 band is the first to go underwater. Keep the method mapped, keep the fee mirrored, and do not advertise it until the price is in writing.
3. **Switching on monthly value.** At R3,000 the 0.345% inc VAT is R10.35 of the R21.81 cost. A customer who withdraws R3,000 as cash pays R30, we keep R8.19; the same R3,000 by PayShap pays R8, we keep R5.12. Both positive; neither is money.
4. **Failed pay-outs we may still be charged for.** Today's CashSend 97 cost the customer nothing (the hold came back) but the float moved; if OTT charges a failed attempt, every sandbox and production failure is a small negative line. Email 11 asks.
5. **The credit-card case does not apply here.** Money that came in by card already paid its PayFast fee on the way in (`lib/deposits.js`); the withdrawal fee stands on its own and is never asked to recover the deposit cost. No pay-out method is cross-subsidising a deposit.
6. **What is not a loss:** PayShap at R8 with a R2.88 cost is the best margin rail we run and the one to steer to; the agent's and the flow's "cheapest alternative" logic already prefers it when the customer's balance cannot carry cash.

## 7. Recommendation, and the founder's open decision

**Keep the model (flat, banded, one number per method) and the cash bands as they are.** They are honest, every band is margin-positive, and a customer who wants cash in hand without a bank account has no cheaper way to get R50 out of a wallet.

**The +R2 of 2026-09-11 is the open decision**, and it is a positioning decision, not a margin one:

| Option | PayShap | Cash R50 / R700 / R1,500 / R3,000 margin | Reads as |
|---|---|---|---|
| A. Keep (today) | R8, +R5.12 | R18 / R23 / R30: +R6.36 / +R4.12 / +R6.36 / +R8.19 | the dearest cash send in the market, R2 above Absa |
| B. Drop the +R2 | R6, +R3.12 | R16 / R21 / R28: +R4.36 / +R2.12 / +R4.36 / +R6.19 | level with Absa CashSend, still above FNB and Capitec; PayShap margin falls 39% |
| C. Drop it on cash only | R8, +R5.12 | R16 / R21 / R28 as in B | the bank-account rail keeps its margin, the cash rail matches the nearest anchor |

The thread's recommendation is **C**: PayShap customers are comparing us to a free bank transfer and will never choose us on price, so the R2 there buys nothing and costs nothing either, while R16 for cash removes the one line a customer can point to as "more than Absa". The R2.12 margin at the R700 band top under C is thin but positive, and the reversal exposure in §6.1 is the reason not to go below R16. Whatever the founder decides, the change is one line per method in `FEES.cashout` (`lib/ledger-core.js`), then `node docs/commercials/sync-from-code.mjs` for the Money Map, `node scripts/gen-knowledge-base-doc.mjs` for the knowledge base, and the fee tests re-run; nothing else carries a hard-coded fee.

Not recommended: any percentage fee (the flat rule of 2026-08-10 stands), any fee below cost at the band top, or advertising FNB eWallet before its price is written down.

## 8. Open questions to OTT that change these numbers (asked in emails 9 and 11)

1. Production price per provider and confirmation that all are ex VAT (email 9, unanswered since 2026-09-23).
2. FNB e-wallet price and whether it carries the 0.3% switching (email 9).
3. Whether a failed pay-out (status 97) and a reversal are charged, and when the float is debited for a pending PayShap (email 11, from today's float movement).
4. The per-transaction fee lines for 2026-10-04 so the R82.69 can be reconciled (email 11).
5. SMS and platform fees for the cash collection codes (email 9).

The four rail costs in §2 are **SIGNED** (Annexure A of the executed Payout Agreement); what is unverified until OTT's statement answers 3 and 4 is the rate OTT actually applies to the float (today's R12.69). FNB e-wallet stays ASSUMED until 2 is answered. The Money Map (`docs/COMMERCIALS.md` §6) uses the same vocabulary.
