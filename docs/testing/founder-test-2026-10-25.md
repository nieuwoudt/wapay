# Founder test guide · 25 October 2026

What shipped on 24 and 25 October and how to try each part from your own phone. Pay-outs are paused for
everyone (CHANGELOG 124). Part C lets you test them without any money moving.

## A. Payment links (live now, in WhatsApp and on the web)

1. **The description.** Send WaPay `request R20`. It asks *What is the R20 for?* Reply `test`.
   You get **one** message: your name, R20, `For: test`, the link and how to pay. Forward it to another phone.
2. **One answer.** Send `request R60 for lunch`. You get the fee choice (1 or 2), reply `1`, then one message.
3. **A refused description.** Send `request R20 for www.example.com`. It explains that a description can't
   carry a website, and asks again.
4. **Tap to send.** Send `request R20 from 082 123 4567 for test` with a real second number. The one message
   ends with *📲 Tap to send it to …*. Tap it: WhatsApp opens your own chat with that person, the request
   ready. Send it. WaPay itself sends that number nothing.
5. **My links.** Send `my links`. Then `remind 1`: you get a reminder card to forward. Then `cancel 1`.
6. **The pay page.** Open one of your links. It shows `For: …`, and the fine print now says WaPay notes the
   rough area the page is opened from.
7. **The web app.** At app.wapay.co.za, open the **Links** tab. Make a link (*What it is for* is required),
   use **Send reminder**, cancel one.

## B. The Link map (Mission Control → **Link map**)

1. Open a link on your phone (step A6). In Mission Control, open **Link map**: your open appears on the map at
   your area, and under **Recent links**.
2. Type the link's code into **One link's journey**: each event with its time, area, device and door.
3. Press **Pay** on the link (you can stop at PayFast's page): a *pressed pay* event appears, with its area.
4. **Paste** (don't forward) the link into any WhatsApp chat: a *link preview (shared)* event appears with
   your phone's area. That is how the map shows where links are sent from.
5. Open the same link once on Wi-Fi and once on mobile data from another phone: mobile data often lands on
   the network's hub city. That is the honest limit of IP areas.
6. A `remind 1` card opened from another phone shows the door *reminder*; a tap-to-send message shows
   *tap-to-send*.

## C. Pay-outs, without moving money (test numbers)

1. **In Vercel**, add `WAPAY_PAYOUT_TEST_NUMBERS` with your number (any spelling, e.g. `0821234567`), then
   **Redeploy**. Your number now passes the pause, and its pay-outs never move money.
2. **The double fee.** Pay one of your links with Apple Pay (R20 is enough), then within two hours send
   `withdraw R50`. At the confirmation the fee reads *R16 (double the usual R8)* with the time the normal fee
   is back. Confirm and enter your PIN: *🧪 Test pay-out: every check passed … nothing was sent*.
3. **Your alert.** The same request arrives on WhatsApp and by e-mail with its fraud level 1 to 5 and the
   reasons. Mission Control → Supplier Floats → **Pay-out requests** lists it as *test run*.
4. **The ID check.** Send `withdraw R1500`. Over R1,000 needs the ID check, so you get the *VERIFY* link (your
   identity status was reset for the KYC test on 23 October).
5. **The pause still holds for everyone else.** Any other number gets *⏸ Pay-outs are paused…*.
6. Not testable this way: the R3,000 daily cap (test runs record no pay-out, so they never add up).

## D. After testing

- Leave your number in `WAPAY_PAYOUT_TEST_NUMBERS` or remove it: a test number never moves money.
- Your account still holds the R6,000 of test credits from the KYC test and a reset identity status.
  Claude reverses the credits and restores the identity record when you say the KYC test is done.
- When you want pay-outs back on, tell Claude: the pause lifts with one call and records who and why.
