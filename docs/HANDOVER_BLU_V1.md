# WaPay × Blu (Blue Label Telecoms) — production enablement thread, v1

Written 2026-10-04 by the main build session for a dedicated side thread named
**"WaPay BluVas integration testing"**. Mission, in the founder's words: *"start getting the
BluVas products live: the airtime, data, electricity, and any other product that BluVas sells
… we need to get into the production environment with BluVas as soon as possible … look at
other tests that have been done for BluVas, lead that thread, be solely focused on finishing
that."*

Read in order before touching anything: `CLAUDE.md`, `WAPAY_STATUS.md` (iCloud root, v1.5.2),
this file, `docs/testing/BLU_UAT_EVIDENCE.md`, `docs/providers/blu-vas-integration.md`,
`docs/providers/blu-vas-catalogue.md`, `docs/providers/blu-voucher-integration.md`,
`docs/BLU_VAS_CATEGORY_REQUEST.md`, `EMAIL_TO_PHUTI_1_TESTLOGS.txt`, memory `blu-qa-vend-limit`.
Fast copy `~/Projects/wapay`; commits from the iCloud repo `WaPay V1.01`; coordinate with any
live peer session before committing (ListAgents / SendMessage); stage by path.

---

## 1. The one fact that frames everything

**Nothing is wrong with the VAS code. We hold QA credentials.** `BLU_BASE_URL` in production
points at Blu's QA host (`api.qa.bltelecoms.net`), and QA vends only to Blu's whitelisted test
MSISDNs (`lib/msisdn.js BLU_QA_TEST_NUMBERS`: 0840012300 Cell C, 0720012345 Vodacom,
0830012300 MTN, 0850012345 Telkom). The chat refuses a real number BEFORE the preview with
honest copy (BUGLOG #78). One production cutover (credentials + base URL + redeploy) turns
airtime, data and electricity live together. **The deliverable of this thread is that
cutover**, and the gate to it is Blu's sign-off, which Phuti has asked for in writing:

> "Please provide the testing logs. This will help in getting sign off." (Phuti, received
> 2026-10-04, replying to the 18 August / 28 August thread)

So the thread's first product is a **fresh, complete UAT evidence pack** covering every
product Blu has enabled for us, run against Blu QA with their test numbers, with Blu's own
references on every line, in a format Phuti can match against their records. The second
product is the production cutover once credentials arrive. Nothing else.

## 2. What is already proven (do not redo blindly, extend it)

| Product | Where proven | Evidence |
|---|---|---|
| Voucher redemption (16-digit Blu Voucher) | our production deployment, Blu QA host | 8 redemptions 2025-11-24 to 2026-01-06, references `BLU-1763971714144` … (`docs/testing/BLU_UAT_EVIDENCE.md` §2); used/expired/invalid paths; idempotent |
| Airtime | our production deployment, Blu QA host | 6 vends 2025-12-20 to 2026-01-02, references 829666075, 829673309, 829717452, 829720901, 829720907, 829720922 (`ProviderRequest` route `airtime-preview`, status SUCCESS); 5 FAILED and 7 abandoned previews from the same period |
| Data | Blu QA during integration | catalogue lookup + priced preview + vend + receipt; NOT in our production ledger |
| Electricity | Blu QA during integration | vend on Blu's compliance test meter `000001020001` (R200 generic), token reference returned; vends can take ~90 s; NOT in our production ledger |

Two things to verify rather than assume: (a) two of the six January airtime successes went
to numbers that are NOT on our four-number QA list (829717452 → 0829837088, 829720907 →
0831118881); either QA accepted real numbers then, or those are whitelisted numbers we do not
know about. Ask Blu what QA accepts today. (b) 2026-09-19 (founder, R10 to his own number):
QA refused with "the network is rejecting this phone number". That is the current behaviour.

**Catalogue in production (`VasProduct`, provider BLU):** AIRTIME 14, DATA 830, ELECTRICITY 3,
BILLPAY 1, GAMING 2, LIFESTYLE 3, REMITTANCE 1 (all `active`; airtime/data synced 2026-08-18
by the daily cron `/api/cron/daily-vas-sync`, the rest last touched 2025-11-29). Chat
categories are gated per user (`isCategoryEnabledForWaId`, `VAS_ALLOWLIST_*`): airtime and
data are on; electricity is allowlist-gated (`VAS_ALLOWLIST_ELECTRICITY`); the other four
categories exist only as rows, with no customer flow (`docs/BLU_VAS_CATEGORY_REQUEST.md`
explains why and what was asked of Blu).

## 3. The spreadsheet in ~/Downloads/wa_pay.xlsx (received 2026-10-04)

Twelve vouchers issued by Blu to reference `Wa_pay` on **2026-09-14 14:25 to 14:27**,
expiring 2029-09-14: six with `SupplierCode 13` and **16-digit PINs** (3 × R60, 3 × R50:
`BL01F8EB11DCA4B5`, `BL0156EB47657C98`, `BL01325807F2EA71`, `BL01ADA798CCECCE`,
`BL01A86B162FAC0A`, `BL01AAB88C94A1A1`) and six with `SupplierCode 41` and **12-digit PINs**
(2 × R50, 4 × R10: `BL04CB86F9C35CE0`, `BL04D4CBC3307B38`, `BL0411D21C64216A`,
`BL0448C68D2CFA08`, `BL04E3C3486A486D`, `BL04FB966D7FCD01`). Read: supplier 13 looks like Blu
Voucher (our 16-digit redemption rail); supplier 41 with 12-digit PINs looks like OTT vouchers
sold through Blu (our OTT redemption rail, `lib/ott-redemption.js`, also on a test host).
These are Blu-issued **test vouchers for the redemption leg of the UAT**. The PINs are bearer
secrets: use them from the spreadsheet, never paste them into the repo, a doc, a log line or a
chat message; mask to the last four in evidence. Confirm with Phuti what supplier 41 is before
redeeming one.

## 4. Environment and credentials (names, never values)

`BLU_BASE_URL` (QA: `https://api.qa.bltelecoms.net/v2/api/trade`; production host: NOT yet
confirmed in writing by Blu, our notes carry three different hosts), `BLU_BASIC_USER`,
`BLU_BASIC_PASS`, `BLU_API_KEY` (voucher), `BLU_TRADE_API_KEY` (VAS), `BLU_VEND_CHANNEL`,
`BLU_VAS_STUB_MODE` (must be `false`), `BLU_QA_TEST_MSISDNS` / `BLU_QA_TEST_NUMBERS`
(optional override of the whitelist), `VAS_ALLOWLIST_ELECTRICITY` (waIds). Auth: HTTP Basic
+ `apikey` header. Swagger UI for QA: `https://api.qa.bltelecoms.net/swagger-ui.html` (no
OpenAPI JSON has been given to us; the VAS integration doc was written from the Swagger UI).
⚠️ `docs/providers/blu-vas-integration.md` §Authentication contains the QA credentials in
clear text: they are already treated as leaked (memory `key-rotation-deferred`); do not copy
them anywhere new, and ask Blu to rotate them with the production issue. The local fast copy
`.env` has no `BLU_*` values; tests use stubs; a live QA run needs the values from Vercel
(ask the founder to paste them into the local `.env`, or run the test through production
with the founder's phone, see §5).

## 5. End-to-end test plan (what to run, what to capture)

Run every product through the real chat on the production deployment (the honest path:
same code, same ledger, same receipts) OR through the local harness against Blu QA. Capture
for every transaction: our idemKey / preview id, Blu's reference, timestamp, amount, MSISDN or
meter, the customer-visible receipt (screenshot from the founder's phone), and the journal
lines. The evidence table shape is in `docs/testing/BLU_UAT_EVIDENCE.md`; produce
`docs/testing/BLU_UAT_EVIDENCE_v2.md` (and a CSV) from a script that reads `ProviderRequest`
+ `JournalEntry`/`JournalLine`, so it can be re-generated and never hand-typed.

1. **Airtime (4 networks).** From the founder's phone: "buy R10 airtime" → the test number
   for each network in turn (0830012300 MTN, 0720012345 Vodacom, 0840012300 Cell C,
   0850012345 Telkom) → confirm → PIN. Expect a vend reference from Blu in the receipt.
   Also one negative: a real number, expect the honest refusal before the preview.
2. **Data (4 networks).** "show MTN bundles" → pick a cheap bundle → the MTN test number →
   confirm → PIN; repeat per network. Capture the bundle SKU and Blu reference.
3. **Electricity.** Add the founder's waId to `VAS_ALLOWLIST_ELECTRICITY` (Vercel, redeploy)
   if not already there; "buy R20 electricity" → meter `000001020001` (Blu's compliance
   meter) → confirm → PIN. Expect a 20-digit token; allow 90 s. Also test a bad meter number.
4. **Voucher redemption.** Redeem the six supplier-13 vouchers from the spreadsheet through
   the chat (paste the 16-digit PIN); expect the face value credited and a `BLU-…` reference;
   try one twice (idempotent, no double credit). For the six supplier-41 vouchers first ask
   Phuti which rail they belong to; if OTT, they test `lib/ott-redemption.js` (chat: "load
   voucher" / paste the 12-digit PIN) which is on OTT's test host.
5. **Failure paths.** Declined vend, timeout (electricity), invalid meter, used voucher,
   expired voucher: each must release the hold and say so; capture them too, Blu's sign-off
   on 28 August explicitly valued the unhappy paths.
6. **Ledger check.** `scripts/verify-ledger-db.mjs` after the round; balances equal journal
   truth; `CLEARING:BLU` moved by exactly the vended face values.

Tooling that exists: `scripts/test-blu-vas-airtime-qa.js` (direct QA airtime vend, CommonJS,
needs `BLU_*` envs), `scripts/smoke-vas.js`, `packages/providers/blu/src/vas-test-helper.js`,
`setup-blu-tests.sh` / `run-blu-tests.sh` + `BLU_QA_TEST_GUIDE.md` (voucher suite against a
deployment), `tests/e2e/chat-qa.mjs` (the chat harness; it stubs Blu, so it proves the flow,
not the vend). The chat is the better evidence because it produces the receipts Blu asked for.

## 6. The email back to Phuti (write it, no em dashes, print it for the founder to send)

Contents: thank you; the fresh evidence pack attached (v2: every product, every network,
Blu's references, receipts, ledger lines, negative paths); the questions that still gate us,
numbered: (1) production credentials and the production base URL in writing, (2) IP
whitelisting yes/no and shared static egress acceptable or not, (3) which categories our
trade account is enabled for in production (airtime, data, electricity confirmed; lifestyle,
bill pay, gaming, remittance per `docs/BLU_VAS_CATEGORY_REQUEST.md`), (4) the OpenAPI JSON
for QA and production, (5) what supplier code 41 in the 14 September voucher batch is, (6) a
production UAT allowance or test-vend budget, (7) rotation of the QA credentials. Keep the
earlier thread's tone (`EMAIL_TO_PHUTI_1_TESTLOGS.txt`).

## 7. Production cutover (when Blu answers)

1. Vercel (WaPay project, Production): `BLU_BASE_URL` = the production host Blu confirms,
   `BLU_BASIC_USER`/`BLU_BASIC_PASS`/`BLU_API_KEY`/`BLU_TRADE_API_KEY` = production values,
   `BLU_VAS_STUB_MODE=false`. **Redeploy** (env changes do nothing until then).
2. `bluIsQa()` turns false automatically (it reads the host), so the real-number refusal
   lifts by itself; check `lib/msisdn.js` has no other QA assumption.
3. If Blu requires IP whitelisting, decide the egress route first (memory
   `vercel-static-egress-ip`: Vercel Pro static IPs are shared; Fly.io Johannesburg is the
   dedicated option).
4. First production vends: R10 airtime to the founder's own number, one data bundle, R20
   electricity to his own meter; verify receipts, journal, and Blu's portal.
5. Daily catalogue sync continues to run (`/api/cron/daily-vas-sync`); check the production
   catalogue counts match QA's after the first sync.
6. Update `docs/CAPABILITIES.md` §3 rows, `WAPAY_STATUS.md` (bump the version), the phase
   map product table (`docs/architecture/rows.json` + republish, see its README), BUGLOG for
   anything found, CHANGELOG, memory `blu-qa-vend-limit` (close it).

## 8. Standing rules for this thread

Never push a red test; run `pnpm test` and `pnpm build` before every push, never `pnpm build`
while `next dev` or the harness runs; voucher PINs and tokens are bearer secrets (never in the
repo, logs, docs or chat; mask to the last four); no em dashes in anything the founder sends;
never promise dates; money execution stays deterministic (reserve → vend → settle/release,
idempotency keys from the preview); review agents are read-only; coordinate with live peer
sessions before committing; deletions in the repo are `git rm` in iCloud, never `rm` in the
fast copy alone. Do not touch the agent architecture, the pay-out rail or Adumo in this
thread; those are owned elsewhere.

## 9. Hard-to-reconstruct details

Phuti Maphoto, Branded Voucher Coordinator, Blue Label Telecoms (the 18 Aug and 28 Aug mails
are the thread). WaPay registration 2025/759220/07. Compliance test meter `000001020001`.
Electricity vends up to ~90 s. The 2025-11-24 first live voucher redemption used test voucher
`3608644555612212` → `BLU-1763971714144`. The chat refuses real numbers on QA with copy that
blames our supplier access, not the customer (BUGLOG #78). Electricity's silent R50 default
was removed 2026-09-19 (BUGLOG #79). The last airtime attempt in production: 2026-09-19
15:14, founder, R10 to 27787051175, FAILED on QA.
