# WaPay for Business — founder test guide

*Written 2026-09-05 for the first live test of the business portal. Every step below is real money or real WhatsApp, so amounts are kept tiny. Two phones help (yours as the business owner, a second WaPay wallet as the customer), but one phone plus a card works.*

## 0. Setup (Vercel, five minutes)

*Status 2026-09-05: the founder attached `business.wapay.co.za`, set the envs and redeployed; the portal serves on its own host. Section 0 is now a confirmation list.*

1. Vercel → project `wapay-api` → Settings → Environment Variables:
   - `WAPAY_BUSINESS_MSISDNS` (plural; the singular spelling also works) = your WaPay WhatsApp number (any SA form, e.g. `0787051175`). Add the laundry owner's number with a comma when they are ready. Registration is closed to everyone else: an uninvited number receives no code at all (the screen still says one is on its way, on purpose).
   - Nothing else is required: the portal reuses `WAPAY_ADMIN_SESSION_SECRET`.
2. Optional host: Settings → Domains → add `business.wapay.co.za`, create the CNAME Vercel shows at the DNS provider for wapay.co.za, then set `WAPAY_BUSINESS_HOST=business.wapay.co.za` and exempt that host from Attack Challenge Mode under Firewall. Without this the portal is at `https://pleasepayme.co.za/business`.
3. **Redeploy** (Deployments → ⋯ → Redeploy). Env changes do nothing until then.

Sanity check after the deploy: open `https://business.wapay.co.za`. You should see the "Sign in or register" glass card. `https://business.wapay.co.za/api/business/auth` should return `{"authed":false,"configured":true,"business":null}`.

## 0. Fastest path: register from the chat (2 min, 2026-09-06)

From the business phone, WhatsApp **`business account`** to WaPay. It asks for the trading name; reply with it (e.g. `I Love My Laundry`). Expected: "*I Love My Laundry* is now a WaPay business" with the portal address and the `business login` hint. Then WhatsApp **`business login`**, and type the code at [business.wapay.co.za](https://business.wapay.co.za) → you land on Overview. (A brand-new number is asked "for you, or for a business? 1 / 2" right after onboarding instead; reply 2.) Negative checks: `business account` again names the existing business; a wallet NOT on the invite list gets the "small group first" answer and no business.

## 1. Register the business on the portal (5 min)

1. From your phone, WhatsApp **`business login`** to the WaPay number. The code comes straight back in the chat (this is the primary path; the portal's "Send me a code" only delivers if you chatted with WaPay in the last 24 hours, a WhatsApp rule). Asked twice inside a minute? The chat tells you to wait 60 seconds. On the portal, enter your number and press **I have my code from WhatsApp** (it only opens the code box; it never asks for another code), then type the code from the chat.
2. Enter the code → **Name your business** (e.g. `I Love My Laundry`, category Laundry) → set a password (10+ characters) → **Create my business**.
3. Expected: you land on Overview with zeros; the header shows your business name. Sign out, sign back in with **I have a password**.

Negative checks worth 30 seconds: a wrong code burns it (request a fresh one); a name like `WaPay Support` or `Wa Pay Support` is refused; a second WaPay number that is NOT on the allowlist receives no code.

## 2. Customers (5 min)

1. **Customers → Add customer**: your second number (or a friend's) with a name.
2. **Import**: paste two lines like `Thabo Nkosi, 073 123 4567` and `Lerato M; 0825551234`, plus a vCard block if you have one. Expected: "Found N numbers: added / updated / already there".
3. Search by name and by a few digits. Tap a customer → profile opens with zeros and "No links yet".

## 3. Create and send a link (5 min)

1. From the profile tap **Payment link for <name>** (or Payment links → pick the customer).
2. Add items: `Wash & fold 5kg` × 1 at `R 5.00` (keep it tiny for the test), reference `T-1`, note optional, expiry 7 days. Watch the quote: **You receive R5 from a WaPay balance, or R5 by card (no fee under R50)**.
3. **Create link**. Expected: a green "Link ready" card with `https://pleasepayme.co.za/PRXXXXXX`, the message text, **Send on WhatsApp** and **Copy link**.
4. Tap **Send on WhatsApp**. Your own WhatsApp opens on the customer's chat with the message prefilled. Send it. Back in the portal the link shows "sent · WhatsApp" in the ledger.
5. Open the link in a browser: the pay page reads "<Business> is requesting R5", lists the item and "Ref: T-1", and offers the two pay options.

Also try a **walk-in** link (leave the customer empty, amount `R 5`): no WhatsApp button, just copy; whoever pays it will be added to Customers automatically.

## 4. Get paid, both ways (10 min)

**Balance rail (free):** on the customer phone, tap "Pay from my WaPay account" → WhatsApp opens with `Pay request PRXXXXXX` → YES → PIN. Expected within seconds:
- The owner's WhatsApp gets "Your payment request was PAID: R5.00 received!" with a second line `from <name> · ref T-1`.
- Portal Overview: Paid R5, Outstanding drops, Recent payments shows the customer with "WaPay balance"; Customers list shows Paid R5 / 1 payment; the profile shows the link as PAID.

**Card rail (real PayFast charge):** create a second R5 link, open it, enter a WhatsApp number, pay by card. Expected: the same PAID notification (the payer also gets a receipt), and in the portal the link shows PAID · card with fee R0 (under R50 is free). If you want to see the fee logic, use a R60 link: the pay page still shows R60 to the payer, the portal shows fee and net.

## 5. The rest (5 min)

- Overview range switcher (7d / 30d / 90d / 1y / All), revenue-by-month bars, the 3/6/12-month chips, card vs balance split, top customers.
- Payment links → filters Open / Paid / Closed / All → **Cancel** an open link → the pay page says the request is no longer active.
- **Export CSV (90 days)** downloads a spreadsheet with one row per link: customer, number, reference, items, amount, fee, net, link. This is the reconciliation file the laundry does by hand today.
- Settings: rename the business, change the default expiry, change the password; the pay page reflects the new name immediately.
- Phone: open the portal on your phone; the tab bar scrolls, cards stack.

## 6. What to report back

Anything that shows a wrong number, any message that reads wrong to a customer, and any step where you had to guess. Screenshots with the link code (PRXXXXXX) let me trace it in the ledger.

## 5b. Optional: "Also send from WaPay" (only with `WAPAY_BUSINESS_NOTIFY=true`, redeployed)

Do step 4's balance-rail payment first: the customer who paid from their own WaPay wallet is now the only kind of customer this button appears for (a card payment, or a number you typed in, never qualifies). Create a second R5 link for that customer. Expected: the "Link ready" card shows **Also send from WaPay**; tap it and the customer phone receives, from WaPay's number, "A WaPay business, <your business>, sent you a payment request for R5 (ref …) … If you don't recognise this business, ignore this message." Tap it again: "Already handed to WaPay for this link." The message delivers without a template here because that phone messaged WaPay minutes ago; outside a 24-hour window it needs Direct Send or an approved template (`WAPAY_TEMPLATE_BUSINESS_REQUEST`). Limits: one per link, 20 per business per day. To switch the feature off, remove the variable and redeploy.

## Not in this test (by design)

Importing contacts straight from WhatsApp is not possible through Meta's API; paste them once, payers are captured automatically after that.
