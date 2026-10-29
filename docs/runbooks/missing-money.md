# Runbook: "my money didn't arrive" (a missing withdrawal)

*Written 2026-10-28 after Lisa's failed PayShap withdrawal (BUGLOG #145 to #150, `docs/incidents/2026-10-28-payshap-withdrawal.md`). Steps 1 to 3 are read-only and need only the local `.env` (`DATABASE_URL`, `WAPAY_INTERNAL_API_KEY`). The customer gets the factual answer from the chat by themselves now ("Nothing is coming in to my bank account" lists their withdrawals). This runbook is for the person who follows up. **Reply within 15 minutes of the alert.***

## 1. Every withdrawal in the last 24 hours, with its state and the rail's reason

```sql
SELECT "requestTs", status, metadata->>'reference' AS ref, (metadata->>'amountCents')::int AS amount, (metadata->>'feeCents')::int AS fee,
       metadata->>'method' AS method, metadata->>'outcome' AS outcome, metadata->>'providerStatus' AS code, metadata->>'lastMessage' AS rail_said,
       metadata->'approval'->>'requestedAt' AS asked, metadata->'approval'->>'approvedAt' AS approved, metadata->>'finalisedAt' AS finalised
  FROM "ProviderRequest" WHERE route = 'ott-payout' AND "accountId" = '<account id>' AND "requestTs" > now() - interval '24 hours'
 ORDER BY "requestTs" DESC;
```

`outcome` `PROVIDER_<n>` is OTT's status code. `lib/payout-reasons.js` says what the customer was told for it. A code with no row there reached the founder as "UNMAPPED CODE": add a row for it (step 7).

## 2. The rail's own answer for anything still open or unclear

```bash
curl -s -H "x-internal-api-key: $WAPAY_INTERNAL_API_KEY" "https://business.wapay.co.za/api/internal/payout-reconcile?reference=WP…"
```

GetPaymentStatus only, never a second pay-out. A PENDING row with a known final answer is finalised and the customer is told.

## 3. Reconcile the balance with what the customer sees

```sql
SELECT "balanceType", "availableCents", "pendingCents" FROM "Wallet" WHERE "accountId" = '<account id>';
SELECT status, "amountCents", "idemKey" FROM holds WHERE "idemKey" LIKE 'payout-<account id>-%' ORDER BY "createdAt" DESC LIMIT 5;
```

Check that the last known balance, minus what is set aside, plus refunds, plus money in, equals what the customer sees. Available plus pending is the balance; pending is what is set aside for a withdrawal (or a purchase) in progress. A FAILED row's hold must be RELEASED. A row open for more than 10 minutes before it reached the rail is a stall: say so to the founder. Any open row (INIT, AWAITING_APPROVAL, PENDING, REJECTING) blocks the customer's next withdrawal until it is resolved, so resolve it here: reconcile it, approve or reject it, or finish the reject. A NEEDS_OPERATOR row does not block, but the customer is told a person is checking it, so check it.

## 4. Reply in one message, from the WaPay business inbox

What happened, where the money is now, the reason, and the next step. No jargon ("bank rail", "OTT", "provider"), no time promises. Example: "I checked your withdrawal: the R100 at 21:40 didn't go through because your bank's payment system did not complete it, and the R100 and the R16 fee came back to your WaPay balance. You have R420. Nothing is pending. Would you like me to help you try again now?"

## 5. Fees

If the failure was on our side or the bank's, or the reason is unclear (`waiveFee: true` in the founder's alert), waive the fee on the next withdrawal with a manual credit through `postEntry` and an idemKey (constitution invariant 2, never a wallet update).

## 6. Secrets typed in chat

If the customer typed a PIN, password or ID number in chat (the PIN step itself counts: BUGLOG #149), ask them to change the PIN (they can say *forgot PIN*) and to delete the message: press and hold it, then *Delete for me*.

## 7. Log the case

Add a line to the incident doc, or a new BUGLOG entry, with the reference, the code, the reply time and a root-cause tag. Review the tags weekly: a code that appears three times or more becomes a fix ticket, and an UNMAPPED code becomes a row in `lib/payout-reasons.js` the same day.
