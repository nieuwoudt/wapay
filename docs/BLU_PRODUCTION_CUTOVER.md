# Blu (Blue Label Telecoms) production cutover checklist

Owner: the "WaPay BluVas integration testing" thread. Execute the moment Blu issues production
credentials. One cutover moves airtime, data and electricity (and Blu Voucher redemption) from
Blu's QA host to production together. Nothing here changes code; it changes configuration, then
verifies.

Prerequisites (from Blu, in writing): production base URL; production basic-auth user and
password; production API key(s) for voucher redemption and VAS; the answer on IP whitelisting;
the production test allowance (if any). See `EMAIL_TO_PHUTI_2_UAT_PACK_V2.txt` asks 1, 2 and 6.

## 0. Before touching Vercel

- [ ] `git fetch` in the iCloud repo; HEAD = production build (`GET /api/internal/meta-status`
      with `x-internal-api-key` reports `build`). Coordinate with any live peer session.
- [ ] Record the current production catalogue counts (`VasProduct` by category) and the founder
      wallet balance; both are compared after the flip.
- [ ] If Blu requires IP whitelisting: decide the egress route first (memory
      `vercel-static-egress-ip`: Vercel Pro static IPs are shared; Fly.io Johannesburg is the
      dedicated option) and have Blu whitelist it BEFORE the flip. Do not flip into a 403.

## 1. Vercel (project WaPay, environment Production)

Set, replacing the QA values:

| Variable | Value | Note |
|---|---|---|
| `BLU_BASE_URL` | the production host Blu confirmed, including the `/v2/api/trade` style path exactly as Blu writes it | `bluIsQa()` reads this host; a host without `qa.` lifts the real-number refusal automatically |
| `BLU_BASIC_USER` | production | voucher endpoints use Basic auth |
| `BLU_BASIC_PASS` | production | |
| `BLU_API_KEY` | production voucher key | |
| `BLU_TRADE_API_KEY` | production VAS key | falls back to `BLU_API_KEY` if Blu issues one key |
| `BLU_VAS_STUB_MODE` | `false` (or unset) | must never be `true` in production |
| `BLU_QA_TEST_MSISDNS` / `BLU_QA_TEST_NUMBERS` | unset | QA-only override |
| `VAS_ALLOWLIST_ELECTRICITY` | keep the founder for the first vend; widen or unset after it | gate sits at the preview and at the PIN step |

- [ ] Redeploy (env changes do nothing until a deployment picks them up). Note the build id.

## 2. First production vends (founder's phone, real targets, small amounts)

Capture each receipt and run `node --env-file=.env scripts/blu-uat-evidence.mjs --since <today>`
afterwards; the rows must show `SUCCESS`, a Blu reference, a SETTLED hold and balanced postings.

- [ ] Airtime R10 to the founder's own number ("buy R10 airtime" → "mine" → yes → PIN). The
      QA refusal must NOT appear; the preview must call `GET /mobile/airtime/mobile-number/check`
      for a real number.
- [ ] One cheap data bundle to the founder's own number (name network and size exactly).
- [ ] Electricity R20 to the founder's own meter (allow up to 90 s; token delivered).
- [ ] If Blu issued production test vouchers: redeem one; otherwise redeem the smallest real
      Blu Voucher bought at a till (R10).
- [ ] One negative: an unknown meter number; expect a clean rejection and no charge.
- [ ] `scripts/verify-ledger-db.mjs` is for scratch databases, not production; instead confirm
      `CLEARING:BLU` moved by exactly the vended amounts (section 7 of the generated pack).

## 3. Catalogue

- [ ] Trigger `GET /api/cron/daily-vas-sync?key=<CRON_SECRET>` (or the admin sync route) so the
      production catalogue is read from the production host; compare counts with the QA counts
      recorded in step 0 and report differences (product ids may differ between environments).
- [ ] Confirm the daily cron is actually scheduled (as of 2026-10-04 the catalogue had not
      changed since 2026-08-18).

## 4. Records (same day)

- [ ] `docs/CAPABILITIES.md` §3: AIRTIME, DATA, ELECTRICITY rows to "Live in production" with
      the date and the first references; the Blu provider row.
- [ ] `WAPAY_STATUS.md` (iCloud root): bump the version; product table rows for airtime, data,
      electricity; rails table Blu row; founder to-do item 4 closed.
- [ ] Phase map product table (`docs/architecture/rows.json`, republish keeping the URL; see its
      README).
- [ ] `docs/BUGLOG.md` for anything found; `docs/CHANGELOG.md` entry; `WAPAY_BUILD_TRACKER.md` delta.
- [ ] Memory `blu-qa-vend-limit`: close it (the limit no longer applies).
- [ ] `lib/msisdn.js`: the QA whitelist and `bluIsQa()` stay (harmless on a production host);
      the honest-refusal copy stays for any future QA deployment.

## 5. Security

- [ ] Ask Blu to rotate the QA credentials that are committed in plain text in
      `docs/providers/blu-vas-integration.md` and `docs/providers/blu-voucher-integration.md`
      (memory `key-rotation-deferred`); then replace those values in the docs with placeholders.
- [ ] Production credentials live only in Vercel and in the founder's password manager; never in
      the repo, a doc, a log line or chat.
