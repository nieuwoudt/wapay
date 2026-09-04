# OTT Redemption REST API v6 — spec received 2026-09-04

*From Keamo (OTT), attached to her reply on the Payout thread. This is the
document we asked for since 25 August. Source PDF: `OTT_Redemption API Rest
v6.pdf` (21 pages, ©2025 OTT Mobile Technologies).*

## The base URL question is answered

`https://test-api.ott-mobile.com` — the SAME host as issuing. Production is
the identical URL with the `test-` prefix removed. So the "merchant-api /
test-api not found" dead end we hit was a wrong-host guess: redemption lives
on the standard API host, under `/api/v1/`, not a separate merchant host.

## Endpoints (all POST, form variables, Basic auth + SHA256 hash)

| Endpoint | Purpose |
|---|---|
| `/api/v1/GetAPIKey` | ⚠️ **ROTATES the key** — never call (same trap as issuing, BUGLOG #8) |
| `/api/v1/CheckVoucher` | Validate a PIN: returns `success`, `serial`, `value` |
| `/api/v1/RemitVoucher` | Redeem: `mobile`, `pin`, `uniqueReference`, `vendorID`, `hash` |
| `/api/v1/CheckRemitVoucher` | Confirm the outcome of a remit (timeout recovery) |

Auth shape is identical to the issuing client we already ship: HTTP Basic
(API username/password, NOT the portal login) + a SHA256 hash of the data
with the API key. Appendix A carries RemitVoucher error codes.

## ⚠️ Contradiction to resolve with Keamo

Her email says: *"I have confirmed that we don't do any whitelisting on our
side."* The spec, point 8, says: **"You will need to give OTT Mobile the IP
address that your service will call from."**

That matters because our merchant-endpoint attempts returned **403**, which
is exactly what an IP restriction looks like. Two readings: either the doc
is stale, or whitelisting applies to redemption/merchant but not payout.
Ask directly, because if an IP allowlist IS required, Vercel's dynamic
egress is a problem and we need the static-egress workaround (memory
`vercel-static-egress-ip`: Fly.io Johannesburg ~R70/month, or Vercel Pro
static IPs).

## Build estimate

Small. The client mirrors `packages/providers/ott` almost exactly (same
host, auth, hashing, form encoding, timeout/recovery discipline). The
CheckRemitVoucher + timeout path maps onto the existing
`TIMEOUT_CHECK_REQUIRED` recovery pattern. Roughly a day including tests,
once we can actually reach the endpoints.

## Live status, honestly (as at 2026-09-04)

| Capability | Built | Live in production |
|---|---|---|
| Issuance (buy/send a voucher) | ✅ sandbox-verified | ❌ still on `test-api`; needs prod credentials |
| Redemption (customer loads a voucher) | ❌ not built (spec only arrived today) | ❌ |
| Payout (cash-out) | ✅ client built, crypto proven | ❌ blocked on credentials + counsel |

Note: WaPay DOES redeem vouchers today, but via **Blu**, not OTT. OTT
redemption would add the OTT voucher network as a cash-in rail.
