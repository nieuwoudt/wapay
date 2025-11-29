# Blu VAS (Value Added Services) API Reference

## 📋 Overview

**Blu VAS** provides airtime and data bundle purchasing services. This document outlines what we know and what we need to discover from the Blu API.

---

## 🔐 Authentication (Same as Voucher API)

**Base URL**: `https://api.qa.bltelecoms.net/v2/api/trade`  
**Swagger**: https://api.qa.bltelecoms.net/swagger-ui.html

### Credentials (QA Environment)
```bash
USERNAME: bld
PASSWORD: ornuk3i9vseei125s8qea71kub
API_KEY: [PENDING - Need from Blu support]
```

### Auth Method
```http
Authorization: Basic base64(username:password)
apikey: [YOUR_API_KEY_HERE]
Content-Type: application/json
```

---

## 🎯 Expected VAS Services

Based on typical VAS provider APIs, Blu likely offers:

### 1. **Airtime Top-Up** 📱

**Expected Endpoint**: `POST /airtime/purchase` or `/vas/airtime`

**Purpose**: Purchase prepaid airtime for a mobile number

**Expected Request**:
```json
{
  "requestId": "wapay-air-123456789",
  "msisdn": "+27821234567",
  "amount": 5000,
  "network": "VODACOM"
}
```

**Expected Response**:
```json
{
  "requestId": "wapay-air-123456789",
  "reference": "BLU-AIR-987654321",
  "msisdn": "+27821234567",
  "amount": 5000,
  "network": "VODACOM",
  "status": "SUCCESS",
  "dateTime": "2025-01-09T14:07:41+02:00"
}
```

**Networks Supported** (typical SA providers):
- Vodacom
- MTN
- Cell C
- Telkom Mobile

---

### 2. **Data Bundles** 📊

**Expected Endpoint**: `POST /data/purchase` or `/vas/data`

**Purpose**: Purchase data bundles for a mobile number

**Expected Request**:
```json
{
  "requestId": "wapay-data-123456789",
  "msisdn": "+27821234567",
  "bundleCode": "VODA_1GB_30D",
  "network": "VODACOM"
}
```

**Expected Response**:
```json
{
  "requestId": "wapay-data-123456789",
  "reference": "BLU-DATA-987654321",
  "msisdn": "+27821234567",
  "bundleCode": "VODA_1GB_30D",
  "bundleName": "1GB 30-Day Bundle",
  "network": "VODACOM",
  "price": 3500,
  "status": "SUCCESS",
  "dateTime": "2025-01-09T14:07:41+02:00"
}
```

**Typical Bundle Types**:
- Daily bundles (50MB, 100MB, 250MB, 500MB, 1GB)
- Weekly bundles (500MB, 1GB, 2GB, 5GB)
- Monthly bundles (1GB, 2GB, 5GB, 10GB, 20GB, 50GB)

---

### 3. **Bundle Catalog** 📚

**Expected Endpoint**: `GET /vas/bundles` or `/data/catalog`

**Purpose**: Retrieve available data bundles for a specific network

**Expected Request**:
```http
GET /vas/bundles?network=VODACOM
```

**Expected Response**:
```json
{
  "network": "VODACOM",
  "bundles": [
    {
      "code": "VODA_50MB_1D",
      "name": "50MB Daily",
      "size_mb": 50,
      "validity_days": 1,
      "price_cents": 500,
      "description": "50MB valid for 24 hours"
    },
    {
      "code": "VODA_1GB_7D",
      "name": "1GB Weekly",
      "size_mb": 1024,
      "validity_days": 7,
      "price_cents": 2500,
      "description": "1GB valid for 7 days"
    },
    {
      "code": "VODA_1GB_30D",
      "name": "1GB Monthly",
      "size_mb": 1024,
      "validity_days": 30,
      "price_cents": 3500,
      "description": "1GB valid for 30 days"
    }
  ]
}
```

---

### 4. **Transaction Status Query** 🔍

**Expected Endpoint**: `GET /vas/transactions/{requestId}` or `/vas/status`

**Purpose**: Query the status of a VAS transaction

**Expected Request**:
```http
GET /vas/transactions/wapay-air-123456789
```

**Expected Response**:
```json
{
  "requestId": "wapay-air-123456789",
  "reference": "BLU-AIR-987654321",
  "status": "SUCCESS",
  "type": "AIRTIME",
  "msisdn": "+27821234567",
  "amount": 5000,
  "dateTime": "2025-01-09T14:07:41+02:00"
}
```

**Possible Statuses**:
- `PENDING` - Transaction in progress
- `SUCCESS` - Completed successfully
- `FAILED` - Transaction failed
- `REVERSED` - Transaction was reversed

---

## 🚨 Error Handling

### Expected Error Response
```json
{
  "timestamp": "2025-01-09T14:07:41+02:00",
  "status": 400,
  "error": "Bad Request",
  "message": "Invalid MSISDN format",
  "path": "/vas/airtime"
}
```

### WaPay Error Mapping
| HTTP Status | Blu Error (expected) | WaPay Code | User Message |
|-------------|---------------------|------------|--------------|
| `400` | "Invalid MSISDN" | `USER_INPUT` | "Invalid phone number. Please check and try again." |
| `400` | "Insufficient balance" | `USER_INPUT` | "Insufficient balance for this purchase." |
| `400` | "Invalid bundle code" | `USER_INPUT` | "Selected bundle is not available." |
| `400` | "Network not supported" | `USER_INPUT` | "This network is not supported." |
| `401` | "Unauthorized" | `AUTH` | "Authentication failed. Please contact support." |
| `404` | "Bundle not found" | `USER_INPUT` | "Bundle not found. Please select another." |
| `409` | "Duplicate transaction" | `USER_INPUT` | "This transaction was already processed." |
| `429` | "Rate limit exceeded" | `RETRYABLE` | "Too many requests. Please try again shortly." |
| `500`, `502`, `503` | Server errors | `RETRYABLE` | "Service temporarily unavailable. Please try again." |

---

## 🔄 Idempotency

Like the voucher API, VAS endpoints should support idempotency via `requestId`:
- Same `requestId` = same result (no duplicate purchase)
- WaPay maps `X-Idempotency-Key` → `requestId`

---

## 📊 WaPay VAS Catalog Schema

We've already created a universal VAS catalog in our database:

```prisma
model VasProduct {
  id                  String   @id @default(cuid())
  category            String   // AIRTIME | DATA
  network_code        String   // VODA | MTN | CELLC | TELKOM
  sku_code            String   // Provider SKU
  label               String   // "1 GB Daily"
  unit_type           String   // CURRENCY | DATA
  unit_quantity_mb    Int?     // For DATA
  price_cents         Int
  validity_days       Int?     // For DATA
  allow_custom_amount Boolean  @default(false)
  min_cents           Int?     // For AIRTIME
  max_cents           Int?     // For AIRTIME
  step_cents          Int?     // For AIRTIME
  target_type         String   // MSISDN
  metadata            Json?    // Provider-specific hints
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@unique([category, network_code, sku_code])
  @@index([category, network_code])
}
```

**Seed Data Created**: `packages/domain/prisma/seeds/vas-products.json`

---

## 🧪 What We Need to Discover

### From Blu Swagger UI (https://api.qa.bltelecoms.net/swagger-ui.html)

Please explore and document:

1. **Airtime Endpoints** 📱
   - [ ] What is the exact endpoint path?
   - [ ] What are the request parameters?
   - [ ] What are the response fields?
   - [ ] What are the supported networks?
   - [ ] Min/max amounts per network?

2. **Data Bundle Endpoints** 📊
   - [ ] What is the exact endpoint path?
   - [ ] How are bundles identified? (code, ID, name?)
   - [ ] Is there a catalog/list endpoint?
   - [ ] What are the response fields?

3. **Network Codes** 🌐
   - [ ] How does Blu identify networks?
   - [ ] VODACOM = "VODA" or "VODACOM" or "1"?
   - [ ] MTN = "MTN" or "2"?
   - [ ] Cell C = "CELLC" or "CELL_C" or "3"?
   - [ ] Telkom = "TELKOM" or "8"?

4. **Bundle Codes** 🎫
   - [ ] What are the actual bundle codes Blu uses?
   - [ ] Can we get a full list per network?
   - [ ] Do codes change frequently?

5. **Transaction Flow** 🔄
   - [ ] Is purchase synchronous (instant response)?
   - [ ] Or async (webhook notification)?
   - [ ] How long do transactions take?
   - [ ] Is there a status query endpoint?

6. **Pricing** 💰
   - [ ] Are prices fixed or dynamic?
   - [ ] Does Blu return prices in the catalog?
   - [ ] Are there any fees/commissions?

7. **Rate Limits** ⏱️
   - [ ] What are the rate limits?
   - [ ] Per minute? Per hour?
   - [ ] Per account or per IP?

---

## 🛠️ Implementation Plan

### Phase 1: Discovery (CURRENT)
- [ ] Access Blu Swagger UI
- [ ] Document all VAS endpoints
- [ ] Get API key from Blu support
- [ ] Test airtime purchase (small amount)
- [ ] Test data bundle purchase
- [ ] Document actual request/response formats

### Phase 2: Client Implementation
- [ ] Create `BluVasClient` in `packages/providers/blu/src/vas.ts`
- [ ] Implement `purchaseAirtime(msisdn, amount, network, idemKey)`
- [ ] Implement `purchaseDataBundle(msisdn, bundleCode, network, idemKey)`
- [ ] Implement `getBundles(network)` (if available)
- [ ] Add timeout & retry logic (30s, 2 retries)
- [ ] Add error mapping

### Phase 3: BFF Routes
- [ ] `POST /api/vas/airtime/preview` - Show preview before purchase
- [ ] `POST /api/vas/airtime/execute` - Execute airtime purchase
- [ ] `POST /api/vas/data/preview` - Show bundle preview
- [ ] `POST /api/vas/data/execute` - Execute data purchase
- [ ] `GET /api/vas/bundles/:network` - Get available bundles

### Phase 4: Integration
- [ ] Wire NLP → BFF routes
- [ ] Add ledger postings (Dr Wallet / Cr Payables:BluVAS)
- [ ] Add WhatsApp receipts
- [ ] Add to observability (Sentry, logs)

### Phase 5: Testing
- [ ] Test with real QA credentials
- [ ] Test all networks (Vodacom, MTN, Cell C, Telkom)
- [ ] Test various bundle types
- [ ] Test error scenarios
- [ ] Test idempotency

---

## 📞 Action Items for You

### Immediate (BLOCKING):
1. **Get API Key** 🔑
   - Email Blu support (use template in `EMAIL_TO_BLU.txt`)
   - Request API key for QA environment
   - Request test voucher PINs

2. **Explore Swagger UI** 🔍
   - Visit: https://api.qa.bltelecoms.net/swagger-ui.html
   - Login with browser Basic Auth:
     - Username: `bld`
     - Password: `ornuk3i9vseei125s8qea71kub`
   - Look for VAS/Airtime/Data endpoints
   - Take screenshots or copy endpoint details

3. **Document Findings** 📝
   - Share endpoint paths
   - Share request/response examples
   - Share network codes
   - Share bundle codes (if available)

### Once We Have API Key:
4. **Test Airtime Purchase** 📱
   - Buy R5 airtime for a test number
   - Verify it works
   - Document the response

5. **Test Data Purchase** 📊
   - Buy smallest data bundle
   - Verify it works
   - Document the response

---

## 🎯 Expected Timeline

| Task | Time | Status |
|------|------|--------|
| Get API key from Blu | 1-2 days | ⏳ WAITING |
| Explore Swagger UI | 30 mins | ⏳ PENDING |
| Document endpoints | 1 hour | ⏳ PENDING |
| Implement BluVasClient | 2 hours | ⏳ PENDING |
| Create BFF routes | 2 hours | ⏳ PENDING |
| Wire to NLP | 1 hour | ⏳ PENDING |
| Test end-to-end | 2 hours | ⏳ PENDING |
| **TOTAL** | **1-2 days + 8 hours** | ⏳ |

---

## 📝 Summary

### What We Know:
✅ Authentication method (Basic + API key)  
✅ Base URL and Swagger location  
✅ QA credentials (username/password)  
✅ Error handling approach  
✅ Idempotency pattern  
✅ Database schema ready  
✅ NLP can parse VAS commands  

### What We Need:
❓ API key  
❓ Exact VAS endpoint paths  
❓ Network codes Blu uses  
❓ Bundle codes/catalog  
❓ Request/response formats  
❓ Rate limits  
❓ Test credentials (phone numbers)  

### Next Steps:
1. 🔑 **YOU**: Get API key from Blu
2. 🔍 **YOU**: Explore Swagger UI and document endpoints
3. 💻 **ME**: Implement BluVasClient based on your findings
4. 🔌 **ME**: Wire to BFF and NLP
5. 🧪 **WE**: Test end-to-end together

---

## 🚀 Once Complete

Customers will be able to:
- ✅ "Buy me R50 Vodacom airtime for 0821234567"
- ✅ "Get 1GB data for 0721234567"
- ✅ "What data bundles are available?"
- ✅ Get instant WhatsApp confirmations
- ✅ See balance deducted correctly

**This is the final piece to make WaPay fully functional!** 🎉


