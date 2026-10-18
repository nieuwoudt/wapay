# Send money through the ledger (2026-10-18)

*BUGLOG #117, CHANGELOG 92. Founder decision of 18 Oct: "send money" stays on, through the ledger, never an OTT voucher. Defaults agreed with the payouts thread:*

- *free to anyone;*
- *member = onboarding complete;*
- *unclaimed after 30 days goes back to the sender.*

## A. What a customer sees

| Step | The sender (the same for a member and a non-member) | The recipient |
|---|---|---|
| "send R50 to 0821234567" | 💸 *Send R50* to 0821234567? It lands in their WaPay balance: straight away if they use WaPay, or when they join. No fee. Reply *YES* to continue to your PIN, or *NO* to cancel. | |
| YES | 🔐 *Enter your WaPay PIN* to send R50 to 0821234567. | |
| the PIN | ✅ *Sent R50* to 0821234567. It is in their WaPay balance, or it waits there for them until they join WaPay. No fee. 💳 Your balance: R… | **Member:** the template "<sender> sent you R50 with WaPay…", or in a session window: "💸 <sender> sent you R50 with WaPay. It is in your WaPay balance: spend it here or say *withdraw* to move it to your bank." **Not yet a member:** the template, or "… Reply here to open your WaPay and it lands in your balance." |
| the recipient joins and sends any message | | 🎁 <sender> sent you R50. It is in your WaPay balance: spend it here or say *withdraw* to move it to your bank. |
| 30 days with no join | ↩️ The R50 you sent to 0821234567 was not collected in 30 days, so it is back in your WaPay balance. Nothing else changed. | |

No voucher and no PIN anywhere for the recipient. The sender's words never reveal whether a number is on WaPay.

## B. The money

| Case | Entry | Rail |
|---|---|---|
| Member | P2P_SEND `send-<previewId>`: sender SPEND D, recipient SPEND C, free | none |
| Not a member | GIFT_HELD `gift-held-gift-<previewId>`: sender SPEND D, LIABILITY:GIFT_PENDING C, free; a `pending_gifts` row with rail WAPAY and no PIN | none |
| They join | GIFT_CLAIM_BALANCE `gift-claim-balance-<giftId>`: GIFT_PENDING D, recipient SPEND C (once) | none |
| 30 days | GIFT_REFUND `gift-refund-<giftId>`: GIFT_PENDING D, sender SPEND C (once) | none |

## C. Founder's run sheet (production; your own number plus a second pilot number)

| # | Do | Expect |
|---|---|---|
| 1 | From your number: "send R10 to <pilot number that HAS WaPay>", YES, PIN | the receipt above; the pilot number's balance is up R10 at once and it gets the notice; your balance is down R10, no fee |
| 2 | "send R10 to <a number with NO WaPay account>", YES, PIN | the same confirm and receipt as #1 (the words never tell you whether they are on WaPay); your balance is down R10 |
| 3 | From that second number: message WaPay, finish sign-up, then send "hi" | "🎁 <your name> sent you R10. It is in your WaPay balance…"; its balance is R10 |
| 4 | From that number again: "hi" | no second R10 line; the balance is still R10 |
| 5 | "send R10 to <your own number>" | the own-number refusal ("That is your own number…") |
| 6 | "how do I send money?" | "It is free and lands in their WaPay balance: straight away if they use WaPay, or when they join…" |

## D. Evidence

- **Unit:** the suite at 1116/1116, including `tests/send-money.test.mjs` (9 tests) and the `buildGiftRefund` pin. Build green; `/api/wallet/send/preview` and `/execute` compiled.
- **Migration:** `20261018_pending_gift_held` applied to production at 08:5x UTC before any deploy (`pending_gifts.voucherPin` is_nullable = YES).

## E. Harness (2026-10-18, real processor; the send routes served in-process against the harness database, mocked WhatsApp and OTT)

41 pass, 0 warn, 1 fail (`docs/testing/chat-qa-report-2026-10-18.md`).

**Scenario 6g, "Send 1": PASS** on all ten checks:

- the confirm is the same for a member and a non-member, free, no voucher;
- YES asks for the PIN for the send;
- the receipt is the same for both;
- the member's balance rose R50 at once;
- the non-member's R30 is held (rail WAPAY, no PIN);
- the sender paid R80, no fee;
- no rail call;
- joining lands the R30 with one line;
- a second message claims nothing (one claim entry, row DELIVERED);
- no voucher PIN anywhere.

All Lisa scenarios 1 to 9 passed.

**The one fail** is the sub-check "Can I send money to someone?" in "How it works: capability questions". It still asserted the OLD voucher wording ("lands in their balance and it is free"). The assertion was moved to the new copy, and running it against the reply recorded in this run gives `true`. The reply: "It is free and lands in their WaPay balance: straight away if they use WaPay, or when they join (if they never do, it comes back to you after 30 days)…". A second full run was not done for this text-only change.

**Residue after the run:** no account on 27600000902 or 903, no gift rows to those numbers, no send or held or claim entries, and LIABILITY:GIFT_PENDING carries no lines.

## F. Production

Filled in after the deploy check.

