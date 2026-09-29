# Adumo staging run, 2026-09-29

**Setup:** scratch schema `wapay_qa_adumo_0929` (dropped afterwards), `scripts/dev-adumo-staging.sh`
on port 3010 with the published staging merchant `9BA5008C-…`, non-3DS application `904A34AF-…`,
published JWT secret, published OAuth test client; seeded account `27600000902` and pay link
`PRBRJKGW` (R38, fee R0 under the free threshold).

| Step | Result |
|---|---|
| `/pay/PRBRJKGW` | rendered with "Pay R38 by card, Instant EFT or Capitec Pay" (Adumo) and the PayFast fallback |
| checkout (payer 0600000903, rail adumo) | auto-submitting form to `staging-apiv3…/product/payment/v1/initialisevirtual`, JWT claims incl. `notificationURL` |
| hosted page `staging-gateway.adumoonline.com/virtual-v2/card/add` | Ref PRBRJKGW-1, ZAR 38.00; card 4111 1111 1111 1111, 05/2028, CVV 123, Joe Soap; Pay Now |
| return | `/pay/PRBRJKGW?r=1`, page state PAID |
| intent | `SUCCESS`, providerRef `5825a3ef-a946-49e1-a066-e02cfd72d989`, `adumoOutcome` {method CARD, panMasked 411111******1111, cardCountry PL, threeDStatus 07, bankErrorCode 00, puid …} |
| journal | `LOAD_ADUMO`: CLEARING:ADUMO 3800 debit, wallet 3800 credit |
| reporting | OAuth token OK; `getState?merchantReference=PRBRJKGW-1&applicationUid=…` and `getState/5825a3ef…` both `AUTHORISED`, amount 38, authorised 38, settled 0 |
| probe | `GET /api/internal/adumo-status?mref=PRBRJKGW-1`: switches on, credentials masked, `tokenOk: true`, transaction found |
| reconcile | intent reset to PENDING; `GET /api/cron/adumo-reconcile?olderThanMinutes=0` → `{count:1, settled:1, status SETTLED}`; intent SUCCESS again; journal still one entry, 3800 (no double credit) |

**Findings:** the hosted page's end state for an approved card is AUTHORISED (Adumo captures
in batch), so the reconciler credits on AUTHORISED or SETTLED with a matching amount and the
live application must have auto-settlement on. `pnpm build` while `next dev` is running
breaks the dev server (shared `.next`). The 3-D Secure challenge needs a real browser.
