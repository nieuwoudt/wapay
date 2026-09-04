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

## Client BUILT 2026-09-04 — `lib/ott-redemption.js`

`OttRedemptionClient`: `checkVoucher` (validate + value, safe at preview),
`remitVoucher` (redeem, partial-aware), `checkRemitVoucher` (the mandated
timeout recovery). Mirrors the issuing client's proven shape; the hash is
verified against OTT's published golden vector in
`tests/ott-redemption.test.mjs` (13 tests).

Money-safety contract, enforced by tests:
- a remit TIMEOUT raises `TIMEOUT_CHECK_REQUIRED` and NEVER retries the
  remit (spec page 13); recovery is `checkRemitVoucher(uniqueReference)`;
- epoch-shaped references are refused (they would poison derived idemKeys);
- partial redemption returns taken + balance; the residual is OTT's to
  re-vault via SMS, never a WaPay liability;
- PINs are masked in every log; `GetAPIKey` is not implemented.

STILL TO BUILD (deliberately not yet): the preview/execute routes and the
chat flow that call this client, plus the ledger posting
(`buildLoad` rail OTT, `CLEARING:OTT`). Those wait until live credentials
prove reachable, so the flow is built against a working endpoint.

## Live status, honestly (as at 2026-09-04)

| Capability | Built | Live in production |
|---|---|---|
| Issuance (buy/send a voucher) | ✅ sandbox-verified | ❌ still on `test-api`; needs prod credentials |
| Redemption (customer loads a voucher) | ❌ not built (spec only arrived today) | ❌ |
| Payout (cash-out) | ✅ client built, crypto proven | ❌ blocked on credentials + counsel |

Note: WaPay DOES redeem vouchers today, but via **Blu**, not OTT. OTT
redemption would add the OTT voucher network as a cash-in rail.
