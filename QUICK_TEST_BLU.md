# 🚀 Quick Test: Blu Voucher Integration

## One-Command Setup & Test

```bash
# 1. Setup (interactive - only needed once)
./setup-blu-tests.sh

# 2. Run tests
source .env.blu-tests && ./run-blu-tests.sh
```

---

## What You Need

### From Vercel Dashboard
- ✅ Your deployment URL (e.g., `https://wapay-abc123.vercel.app`)

### From Blu
- ✅ Valid/unused voucher PIN (16 digits)
- ✅ Already-used voucher PIN (16 digits)
- ✅ Expired voucher PIN (16 digits) - optional

---

## Expected Results

```
✅ Passed: 5/5
❌ Failed: 0/5
📈 Success Rate: 100.0%
```

---

## If Tests Fail

### All tests return 401/403
→ Check Blu credentials in Vercel environment variables

### Valid voucher returns 400
→ Voucher already used, get fresh one from Blu

### Connection errors
→ Check Vercel deployment URL is correct

---

## Manual WhatsApp Test

1. Send voucher PIN to your WhatsApp bot
2. Should see: "✅ Voucher Redeemed Successfully!"
3. Check balance increased by voucher amount

---

## Files

| File | Purpose |
|------|---------|
| `test-blu-qa-suite.js` | Test suite |
| `run-blu-tests.sh` | Test runner |
| `setup-blu-tests.sh` | Setup wizard |
| `BLU_QA_TEST_GUIDE.md` | Full docs |
| `BLU_TESTING_COMPLETE.md` | Complete summary |

---

**Questions?** See `BLU_QA_TEST_GUIDE.md` for detailed documentation.

