# WaPay

## Yoyo / wiGroup Integration (Overview)

- Source docs: [Yoyo Developer Docs — Transactions request](https://developer.yoyogroup.com/#transactions-request)
- Domains: CVS Issuer (gift issue/topup/balance) and VSP/Token Manager (wiCode tokens; Request → Advice).
- WaPay endpoints:
  - `GET /yoyo/eligible?retailer=checkers` → `{ ok, supported }`
  - `POST /yoyo/token/issue` → `{ ok, token: { token, type:"WICODE" } }` (feature‑flagged)
- Flow example: User says “pay R79.88 at Checkers” → check eligibility → issue wiCode → user presents code at POS → Yoyo routes to WaPay VSP → Advice finalizes.

## User Stories

- Deposit via Blu Voucher: redeem voucher, credit wallet, send receipt.
- Check balances: reply with wallet + gift balances.
- Buy airtime/data: preview → confirm → (PIN) → receipt.
- Betting top‑up (Phase 2): operator select → instructions or voucher submit → receipt.
- Retailer eligibility (Yoyo): ask “Can I use WaPay at Checkers?” → yes/no.
- Pay at retailer with wiCode: “pay R79.88 at Checkers” → issue wiCode token.
# WaPay API
