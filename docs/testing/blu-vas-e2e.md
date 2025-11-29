# Blu VAS End-to-End Testing Guide

This document provides step-by-step instructions for manually testing the Blu VAS integration from WhatsApp message through to receipt delivery.

## Prerequisites

Before testing, ensure:

1. **Environment Variables** are set:
   ```bash
   BLU_BASE_URL=https://api.bluvoucher.co.za  # or QA URL
   BLU_BASIC_USER=<your-blu-username>
   BLU_BASIC_PASS=<your-blu-password>
   BLU_API_KEY=<your-blu-api-key>
   META_WHATSAPP_TOKEN=<whatsapp-token>
   META_WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>
   DATABASE_URL=<postgres-connection-string>
   ```

2. **Test Account** exists with:
   - Verified phone number
   - PIN set
   - Sufficient wallet balance (R100+ recommended)

3. **Test Mobile Numbers** (for airtime/data recipient):
   - Use your own number or test numbers approved by networks
   - Have numbers for each network: Vodacom, MTN, Cell C, Telkom

---

## Test 1: Airtime Purchase Flow

### Scenario
User purchases R20 airtime for their own number.

### Steps

1. **Send WhatsApp Message**
   ```
   Buy R20 airtime
   ```

2. **Expected NLP Response**
   - Intent: `BUY_AIRTIME`
   - Extracted: `amountCents: 2000`
   - Missing: `msisdn` (may use sender's number)

3. **Preview Response**
   ```
   You're about to buy R20.00 airtime for 0821234567 (Vodacom).
   
   Amount: R20.00
   Fee: R0.00
   Total: R20.00
   
   Reply YES to confirm, or NO to cancel.
   ```

4. **Confirm Purchase**
   ```
   YES
   ```

5. **PIN Prompt**
   ```
   Enter your 4-digit PIN to complete the purchase:
   ```

6. **Enter PIN**
   ```
   1234
   ```

7. **Expected Success Response**
   ```
   ✅ Airtime purchased successfully!
   
   R20.00 airtime sent to 0821234567
   Network: Vodacom
   Reference: BLU-12345678
   
   New balance: R80.00
   ```

8. **WhatsApp Receipt (Template)**
   - Should receive `vas_purchase_receipt` template with:
     - Customer name
     - Product type: "Airtime"
     - Amount: R20.00
     - Phone number: 0821234567
     - Date/time
     - Reference number

### Verification

- [ ] Airtime delivered to recipient number
- [ ] Wallet balance decreased by R20.00
- [ ] Journal entry created with correct Dr/Cr
- [ ] ProviderRequest status = SUCCESS
- [ ] WhatsApp receipt delivered

---

## Test 2: Data Bundle Purchase Flow

### Scenario
User purchases a 1GB data bundle for a different number.

### Steps

1. **Send WhatsApp Message**
   ```
   Buy 1GB data for 0831234567
   ```

2. **Expected NLP Response**
   - Intent: `BUY_DATA`
   - Extracted: `msisdn: +27831234567`, `sizeMb: 1024`

3. **Bundle Selection (if multiple match)**
   ```
   Select a data bundle for MTN:
   
   1. 1GB Daily (24hrs) - R29
   2. 1GB Weekly (7 days) - R49
   3. 1GB Monthly (30 days) - R99
   
   Reply with the number of your choice.
   ```

4. **Select Bundle**
   ```
   3
   ```

5. **Preview Response**
   ```
   You're about to buy 1GB Monthly data for 0831234567 (MTN).
   
   Bundle: 1GB Monthly
   Valid for: 30 days
   Price: R99.00
   Fee: R0.00
   Total: R99.00
   
   Reply YES to confirm, or NO to cancel.
   ```

6. **Confirm and Enter PIN**
   ```
   YES
   1234
   ```

7. **Expected Success Response**
   ```
   ✅ Data bundle purchased successfully!
   
   1GB Monthly sent to 0831234567
   Network: MTN
   Valid until: 15 Feb 2025
   Reference: BLU-87654321
   
   New balance: R81.00
   ```

### Verification

- [ ] Data bundle delivered to recipient
- [ ] Correct bundle (1GB Monthly) purchased
- [ ] Wallet balance decreased by R99.00
- [ ] Journal entry created
- [ ] WhatsApp receipt delivered

---

## Test 3: Network Detection Scenario

### Scenario
User requests airtime without specifying network.

### Steps

1. **Send WhatsApp Message**
   ```
   Send R50 airtime to 0841234567
   ```

2. **Expected Behavior**
   - System calls Blu network detection API
   - Identifies network as Cell C
   - Creates preview with detected network

3. **Preview Response**
   ```
   You're about to buy R50.00 airtime for 0841234567 (Cell C).
   
   Amount: R50.00
   Fee: R0.00
   Total: R50.00
   
   Reply YES to confirm, or NO to cancel.
   ```

### Verification

- [ ] Network correctly detected
- [ ] Correct vendorId used in Blu API call
- [ ] No manual network selection required

---

## Test 4: Insufficient Balance

### Scenario
User tries to purchase airtime with insufficient wallet balance.

### Steps

1. **Ensure wallet balance is R10**

2. **Send WhatsApp Message**
   ```
   Buy R50 airtime
   ```

3. **Expected Response**
   ```
   ❌ Insufficient balance
   
   You need R50.00 but only have R10.00 available.
   
   Top up your wallet to continue.
   ```

### Verification

- [ ] No Blu API call made
- [ ] Wallet balance unchanged
- [ ] Clear error message displayed

---

## Test 5: Invalid PIN

### Scenario
User enters wrong PIN during purchase.

### Steps

1. **Start airtime purchase flow**
2. **At PIN prompt, enter wrong PIN 3 times**

3. **Expected Responses**
   - 1st attempt: "Invalid PIN. Please try again."
   - 2nd attempt: "Invalid PIN. 3 attempts remaining."
   - 3rd attempt: "Invalid PIN. 2 attempts remaining."

4. **After 5 failed attempts**
   ```
   🔒 Account temporarily locked
   
   Too many failed PIN attempts. Please wait 15 minutes and try again.
   ```

### Verification

- [ ] No Blu API call made after failed PIN
- [ ] Wallet balance unchanged
- [ ] AuthFactor.attempts incremented
- [ ] AuthFactor.lockedUntil set after 5 failures

---

## Test 6: Duplicate Request (Idempotency)

### Scenario
Same purchase attempted twice with same idempotency key.

### Steps

1. **Complete a normal airtime purchase**
2. **Note the reference number**
3. **Attempt to replay the exact same request** (this requires API-level testing)

4. **Expected Behavior**
   - Blu returns 409 Conflict or original transaction
   - Wallet NOT debited twice
   - Same reference returned

### API Test

```bash
# First request
curl -X POST http://localhost:3000/api/vas/airtime/execute \
  -H "Content-Type: application/json" \
  -d '{"previewId": "preview-123", "accountId": "acc-123", "pin": "1234"}'

# Replay same request (should fail or return same result)
curl -X POST http://localhost:3000/api/vas/airtime/execute \
  -H "Content-Type: application/json" \
  -d '{"previewId": "preview-123", "accountId": "acc-123", "pin": "1234"}'
```

### Verification

- [ ] Second request does NOT create duplicate ledger entry
- [ ] Wallet debited only once
- [ ] Error or idempotent response returned

---

## Test 7: Bundle Catalogue Retrieval

### Scenario
View available data bundles for a network.

### Steps

1. **Send WhatsApp Message**
   ```
   Show data bundles for Vodacom
   ```

2. **Expected Response**
   ```
   📱 Vodacom Data Bundles:
   
   Daily:
   • 100MB - R15
   • 250MB - R25
   • 500MB - R35
   
   Weekly:
   • 500MB - R49
   • 1GB - R69
   • 2GB - R99
   
   Monthly:
   • 1GB - R99
   • 2GB - R159
   • 5GB - R299
   
   Reply with the bundle you want (e.g., "Buy 500MB weekly")
   ```

### API Test

```bash
curl http://localhost:3000/api/vas/bundles/vodacom
```

### Verification

- [ ] Bundles fetched from Blu API or cache
- [ ] Grouped by validity period
- [ ] Prices displayed correctly

---

## Test 8: Preview Expiry

### Scenario
User doesn't confirm within 5 minutes.

### Steps

1. **Create airtime preview**
2. **Wait 6 minutes**
3. **Try to confirm**
   ```
   YES
   ```

4. **Expected Response**
   ```
   ⏰ This request has expired
   
   Please start again with: "Buy R20 airtime"
   ```

### Verification

- [ ] Preview status still PENDING in DB
- [ ] Execute rejected with expiry error
- [ ] No Blu API call made

---

## Blu QA Environment Testing

For full integration testing against Blu's QA environment:

### QA Credentials

Contact Blu for QA credentials:
- QA API Base URL
- QA Basic Auth credentials
- QA API Key
- Test mobile numbers

### QA Test Numbers

Blu typically provides test numbers that:
- Accept airtime without actual delivery
- Return predictable responses
- Don't cost real money

### Running QA Tests

```bash
# Set QA environment
export BLU_BASE_URL=https://qa-api.bluvoucher.co.za
export BLU_BASIC_USER=qa-user
export BLU_BASIC_PASS=qa-pass
export BLU_API_KEY=qa-key

# Run test suite
npm run test:blu-vas
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "AUTH error" | Invalid Blu credentials | Verify BLU_* env vars |
| "Network detection failed" | Invalid phone format | Ensure +27 or 0 prefix |
| "Product not found" | Wrong productId | Refresh bundle catalogue |
| "Insufficient balance" | Wallet empty | Top up test wallet |
| "Preview expired" | Took too long | Start new purchase |
| "Rate limit exceeded" | Too many requests | Wait and retry |

### Log Locations

- **Vercel**: Functions → Logs
- **Local**: Console output
- **Metrics**: Search for `📊 METRIC:` in logs

### Useful Queries

```sql
-- Check recent VAS transactions
SELECT * FROM "JournalEntry" 
WHERE source LIKE 'VAS_%' 
ORDER BY "createdAt" DESC 
LIMIT 10;

-- Check preview status
SELECT * FROM "ProviderRequest" 
WHERE route LIKE '/mobile/%' 
ORDER BY "requestTs" DESC 
LIMIT 10;

-- Check wallet balance
SELECT w.* FROM "Wallet" w
JOIN "Account" a ON w."accountId" = a.id
WHERE a."waId" = '27821234567';
```

---

## Related Documentation

- [Blu VAS Catalogue](../providers/blu-vas-catalogue.md)
- [Blu VAS Deployment](../deploy/blu-vas.md)
- [Blu VAS Runbook](../runbooks/blu-vas.md)

