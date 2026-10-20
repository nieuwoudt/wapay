# Process checks for the daily conversation audit

*Hand-maintained. One section per feature: what correct looks like, what to flag. `lib/audit/brief.js` reads this file at run time and appends it to the reviewer's brief after the generated "what is true today" block, so a new feature's checks belong here the day the feature ships (docs/audits/DAILY_AUDIT.md, "how to add a feature's checks"). Plain English, short lines, no dates, no names, no words about games of chance, no em dashes.*

## Onboarding

Correct: a new number gets the welcome, the code to this WhatsApp number, the PIN twice, consent, then the home card or (for an ad arrival) the first-link prompt. Free text before the account is open is answered once with a short line and the next step, never the same line three times. The business question is asked only when the switch says "ask".

Flag: the welcome or the code step repeated to the same message; a customer who typed a clear question or complaint answered with "once your account is open" again; a PIN asked for before the code step; an account that never opens after three customer messages; the business question asked at sign-up.

## Pay links (please pay me)

Correct: an amount within the limits makes one link with the fee stated before it is shared (the requester pays, the payer never does; free below the free threshold); the share copy names who owes the money when the customer said so; "is my link paid" is answered from the record (paid, open, or expired); a request for the same amount a link was just made for is that link again, not a second one; the grossed-up option nets the amount asked.

Flag: a link made for the first-link example or for "nobody owes me"; a link the requester is told to pay themselves; the fee charged to the payer or described as a surcharge; an open link described as paid or as "being confirmed"; a second link compounding the card padding; an amount above the ceiling answered with a link; a payer-name parse that lifts the wrong words into "Forward it to".

## Send money

Correct: "send R50 to 083..." moves balance to balance, free, straight away for a member and held for a non-member (lands when they join, comes back after 30 days); the preview names the number in full and the amount, the PIN confirms; the sender reads the same words whether or not the number is on WaPay; the customer's own number is refused with the two things they might have meant.

Flag: a send described or executed as a voucher; a fee on a send; a tapped "Send Money" answered with a fact and no flow; a recipient's balance claimed when the record shows a hold; a send to the customer's own number sold as a voucher purchase.

## Add money (card, Instant EFT)

Correct: "deposit R100" makes an add-money link with the fee on top and the full amount landing in the balance; the link is called an add-money link, never a payment link; a typed amount always gets the button message (the chat records it); a pending card payment is reported as pending, from the record.

Flag: a typed amount with no reply at all; a cash voucher, a till, Samsung Pay or any other method named that the truth block does not list as live; "PayFast is still confirming" about a payment never started; the deposit fee contradicted by "the full amount lands" without the fee context; a coming-soon cash top-up sold with steps.

## Withdraw

Correct: the methods are the ones in the truth block, with their fees and the rail minimum; the flow asks for the account number, bank, cellphone, the name as on the account (once), the SA ID or passport with its country; the PIN is typed only at the flow's own PIN step; a wrong PIN never ends the flow and names "forgot PIN"; a timed-out step is asked again or the confirmation is shown again with the money read fresh; at a R0 balance the three-tier gate runs and the third tier brings in a person; an outcome is stated only from the record (paid with a reference, pending, failed with the money back).

Flag: a method that does not exist on production; a minimum below the rail floor; "being confirmed" or "on its way" with no pending pay-out in the record; the PIN asked for by the model or in free text; the ID or passport asked for twice; a how-it-works walkthrough offered at a R0 balance; the gate line repeated with no fuller picture and no person; an "add money" escape the flow just offered then swallowed; a raw placeholder such as "R<amount>" in any language.

## Ad flow (Click-to-WhatsApp arrivals)

Correct: the four tapped questions are answered from the brief; Q1 and Q4 go straight to onboarding without the welcome; the five FAQ truths say coming soon where the truth block says so; after onboarding the first-link prompt, then the short forwardable link copy; one reminder ever; "stop" opts out; the example typed back gets "That was my example"; "nobody owes me" gets the truth that WaPay does not pay them.

Flag: the FAQ block sent twice within minutes; the first-link prompt restarted instead of an answer to a question; a link made for the example or for nobody; a second reminder; a coming-soon product sold in an FAQ answer.

## Business accounts

Correct: "business account" from an uninvited number gets the waitlist answer once; an invited number gets the sign-up in chat; the business question after onboarding is asked only when the switch says so; a business owner's links and payments are the owner's wallet.

Flag: an offer then a refusal in the same conversation; "set it up in two questions" or any promise of a person or a time; the business question swallowing normal messages or button taps; the portal flow started for a personal account.

## Close account

Correct: "close my account" is answered once with the truth that a person closes it, and the person alert is raised; no "secure final step", no self-service closure invented.

Flag: a closure step the product does not have; the same closure line repeated; a closure promised without the alert.

## Balance, transactions, PIN reset

Correct: balance and transactions come from the ledger, in one format; "forgot PIN" from anywhere sends the code, asks the whole ID when one is on file, takes the new PIN twice and resumes what was waiting; a locked PIN names the reset.

Flag: a balance or a transaction status stated by the model; two balance-card formats within minutes; "type reset PIN" answered to "reset pin"; a reset that restarts itself on its own words; a PIN asked for outside a PIN step.

## Language and tone

Correct: the customer's language is kept once chosen; one reply per message; two lines and one question; lists only when the content is multifaceted; names used as given, without emoji or possessives mangled.

Flag: "just say it in English" against "in any language"; the same line sent twice in a row; a reply over 1,200 characters to a short question; internal strings, "please try again later" suffixes or raw values in customer text; a time promise ("in minutes", "shortly", a date); a partner named; an em dash.

## Messaging compliance (docs/WHATSAPP_POLICY_COMPLIANCE.md)
- Correct: every bot message answers a message the customer sent in that conversation, or is the receipt of a transaction they just made; one message per customer turn, a second only when it is the payment card or the receipt; "stop" from anyone is acknowledged once and nothing follows it.
- Flag (P1): a bot message with no customer message in the 24 hours before it that is not a receipt; any message after the customer said stop, unsubscribe or leave me alone; a marketing line of any kind.
- Flag (P2): three or more bot messages in one minute for one customer turn; the same prompt repeated without new information; a customer asking for a person without the person being promised.
