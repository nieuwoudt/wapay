# Founder review of the live chat, 6 October 2026 (v1.1 screenshots): every item, owner, status, lock

Source: thirteen annotated screenshots from the founder's phone (12:46 to 16:06 SAST), run against
production on Blu's QA credentials. This file is the running record so nothing is done twice. Owners:
**Blu thread** (VAS flows, Blu and OTT cash-in rails) and **main thread** (the agent: composition,
formatting, deposit answers, transaction history). Status words: DONE (shipped, test named), BUILT
(in the fast copy, not yet pushed), OPEN (not started), BLU (waits on Blue Label), OTT (waits on live
OTT credentials), MAIN (handed to the main thread).

| # | Screenshot | What the founder asked | Owner | Status | Lock / evidence |
|---|---|---|---|---|---|
| 1 | Cash deposit via Blu: "How can I deposit money?" | List every way including cash (Blu voucher at a till, OTT voucher), no second question unless "electronically" is said; numbered steps 1 to 5; end with "just come back here if you get stuck" | main | MAIN | main thread's review test |
| 2 | Provided test vouchers: Blu test voucher → "Status Check Failed" | Make Blu voucher redemption work | Blu | BUILT | Probe (6 Oct 16:42): supplier-41 vouchers (12-digit PINs) are ACTIVE R50 on QA; supplier-13 (16-digit) UNKNOWN. The chat accepted 16 digits only; now 12 or 16 (BUGLOG #91, `tests/blu-voucher-pin.test.mjs`). Next: founder redeems the six supplier-41 vouchers |
| 3 | Purchased Blu voucher online (real R30) → "Status Check Failed"; "I remember this working in production" | Find out why it stopped | Blu | BLU | Every credential ever issued is QA (31 Oct 2025); the 8 historical redemptions used Blu's test vouchers; a real retail voucher is unknown to the QA host. Production host and credentials asked of Phuti |
| 4 | Cash deposit, OTT: "Can I deposit via an OTT voucher?" → Add Money card | Direct answer; enable OTT voucher redemption in production | main (answer), Blu + OTT (rail) | MAIN / OTT | Rail is built on `test-api.ott-mobile.com`; the flip is the live `OTT_BASE_URL` + `OTT_MERCHANT_API_USERNAME/PASSWORD` in Vercel (founder holds them); chat accepts 16-digit PINs only |
| 5 | Airtime enquiry: "What type of airtime can I buy?" | Add how to buy ("just say buy R10 airtime"); confirm no specials exist on the API | main (copy) / Blu (fact) | MAIN / DONE | Catalogue: AIRTIME rows are fixed denominations and any-amount; Blu's airtime API has no specials or bundles |
| 6 | Low balance: "Insufficient balance. Available: R40.00. Please try again later." | Name the gap, top up the difference (fee considered), proceed to checkout; resume | Blu (VAS flows) | BUILT | `tests/vas-purchase-intent.test.mjs`; `tests/e2e/chat-qa-vas.mjs` scenarios 3 and 4; routes answer `code: 'INSUFFICIENT_BALANCE', availableCents, requiredCents` |
| 7 | MTN airtime R10 to 0830012300 | Works | Blu | DONE | Blu ref 847179337, pack v2 |
| 8 | Vodacom airtime R10 to 0720012345 | Works | Blu | DONE | Blu ref 847190046, pack v2 |
| 9 | Cell C airtime R10 to 0840012300 → "error code: 502" | Investigate | Blu | BLU | Blu's gateway answered a 502 page; hold released, nothing booked (pack v2 failure paths); retry on a later day, asked of Phuti |
| 10 | Telkom airtime R10 to 0850012345 | Works | Blu | DONE | Blu ref 847203369, pack v2 |
| 11 | Data deals lists (MTN, Vodacom, Cell C) as plain lines | Bullets, one per item; latest catalogue; best value not cheapest | main (format, recommendation) / Blu (catalogue) | MAIN / OPEN | Catalogue last synced 18 Aug; the daily cron's last run is unverified (founder to check Vercel Cron Jobs, or run `/api/cron/daily-vas-sync?key=CRON_SECRET`) |
| 12 | Telkom data deals list with balance-aware recommendation | "Perfect", apply everywhere | main | MAIN | |
| 13 | "buy 5MB MTN data for 083001230" (and Vodacom, Cell C, Telkom) → bundle list | Pick up the intent and close the sale | Blu | BUILT | `completePurchase` guard; `tests/vas-purchase-intent.test.mjs`; harness scenario 1 |
| 14 | Electricity enquiry "list all providers" | Fine | | DONE | |
| 15 | "buy R20 electricity. for the meter, 000001020001" → asked for the meter again → "Electricity service unavailable" | Pick up both slots; (the failure is Blu QA, BUGLOG #88 and Delta 38) | Blu | BUILT / BLU | `startElectricityPreviewAndConfirm`; harness scenario 2; Blu QA electricity answers HTTP 500/520 (asked of Phuti) |
| 16 | "Can I buy a blue voucher?" | Sell Blu vouchers too | Blu | BLU | Issuing endpoint spec and enablement asked of Phuti; `BluClient.issueVoucher` is a stub |
| 17 | Memory + transactions formatting | One bullet per transaction, consistent icons, references on a second line, pending note after the list | main | MAIN | main thread's review test |

Standing rules applied: no supplier named to the customer, no date promised, money execution
unchanged (preview, confirm, PIN), every behaviour change carries a test, the chat harness runs
before the founder is asked to review (`node --env-file=.env --experimental-test-module-mocks
tests/e2e/chat-qa-vas.mjs` writes `docs/testing/chat-qa-vas-report-<date>.md`).
