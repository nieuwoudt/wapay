# 🔍 Blu VAS Discovery Guide - Quick Action Steps

## 🎯 Your Mission

Explore the Blu Swagger UI and document all VAS (airtime/data) endpoints so we can integrate them!

---

## 📋 Step-by-Step Instructions

### Step 1: Access Swagger UI (5 minutes)

1. **Open Browser** (Chrome/Safari)
2. **Go to**: https://api.qa.bltelecoms.net/swagger-ui.html
3. **Browser will show login popup** (Basic Auth)
   - Username: `bld`
   - Password: `ornuk3i9vseei125s8qea71kub`
4. **Click Login/OK**
5. **You should see Swagger UI** with a list of endpoints

---

### Step 2: Find VAS Endpoints (10 minutes)

Look for sections/tags like:
- 🎯 **"Airtime"** or **"Airtime Controller"**
- 🎯 **"Data"** or **"Data Bundles"** or **"VAS"**
- 🎯 **"Products"** or **"Catalog"**

**Screenshot or note down:**
- Endpoint paths (e.g., `/vas/airtime`, `/data/purchase`)
- HTTP methods (GET, POST)
- Request parameters
- Response examples

---

### Step 3: Document Airtime Endpoint (10 minutes)

Find the **Airtime Purchase** endpoint and document:

#### 📝 What to Copy:

1. **Endpoint Path**: 
   - Example: `POST /vas/airtime/purchase`

2. **Request Body** (click "Try it out" to see):
   ```json
   {
     "requestId": "?",
     "msisdn": "?",
     "amount": "?",
     "network": "?"
   }
   ```

3. **Response Example** (200 success):
   ```json
   {
     "reference": "?",
     "status": "?",
     ...
   }
   ```

4. **Network Codes**:
   - How is Vodacom represented? (VODACOM, VODA, 1?)
   - How is MTN represented? (MTN, 2?)
   - How is Cell C represented? (CELLC, CELL_C, 3?)
   - How is Telkom represented? (TELKOM, 8?)

---

### Step 4: Document Data Bundle Endpoint (10 minutes)

Find the **Data Bundle Purchase** endpoint and document:

#### 📝 What to Copy:

1. **Endpoint Path**: 
   - Example: `POST /vas/data/purchase`

2. **Request Body**:
   ```json
   {
     "requestId": "?",
     "msisdn": "?",
     "bundleCode": "?",
     "network": "?"
   }
   ```

3. **Response Example**:
   ```json
   {
     "reference": "?",
     "bundleName": "?",
     "price": "?",
     ...
   }
   ```

---

### Step 5: Find Bundle Catalog (10 minutes)

Look for an endpoint to **list available bundles**:

#### 📝 What to Look For:

1. **Endpoint Path**: 
   - Example: `GET /vas/bundles?network=VODACOM`
   - Or: `GET /data/catalog`

2. **Response** (list of bundles):
   ```json
   {
     "bundles": [
       {
         "code": "VODA_1GB_30D",
         "name": "1GB Monthly",
         "price": 3500,
         "size_mb": 1024,
         "validity_days": 30
       }
     ]
   }
   ```

3. **Bundle Codes** (copy 5-10 examples):
   - Vodacom: `VODA_1GB_30D`, `VODA_500MB_7D`, etc.
   - MTN: `MTN_1GB_30D`, etc.
   - Cell C: `CELLC_1GB_30D`, etc.

---

### Step 6: Test in Swagger (OPTIONAL - if you have API key)

If you have the API key:

1. **Click "Authorize" button** (top right in Swagger)
2. **Enter API Key** in the dialog
3. **Click "Try it out"** on an endpoint
4. **Fill in test data**:
   ```json
   {
     "requestId": "test-123",
     "msisdn": "+27821234567",
     "amount": 500
   }
   ```
5. **Click "Execute"**
6. **Copy the response**

---

## 📸 What to Share With Me

### Option 1: Screenshots
Take screenshots of:
1. Swagger UI showing VAS endpoints list
2. Airtime endpoint request/response
3. Data endpoint request/response
4. Bundle catalog (if available)

### Option 2: Text Document
Create a text file with:

```
=== BLU VAS ENDPOINTS ===

1. AIRTIME PURCHASE
   Path: POST /vas/airtime/purchase
   Request:
   {
     "requestId": "string",
     "msisdn": "+27821234567",
     "amount": 5000,
     "network": "VODACOM"
   }
   Response:
   {
     "reference": "BLU-AIR-123",
     "status": "SUCCESS",
     ...
   }

2. DATA PURCHASE
   Path: POST /vas/data/purchase
   Request:
   {
     ...
   }
   Response:
   {
     ...
   }

3. BUNDLE CATALOG
   Path: GET /vas/bundles?network=VODACOM
   Response:
   {
     "bundles": [...]
   }

4. NETWORK CODES
   - Vodacom: VODACOM
   - MTN: MTN
   - Cell C: CELLC
   - Telkom: TELKOM

5. BUNDLE CODES (examples)
   - VODA_1GB_30D
   - MTN_500MB_7D
   - etc.
```

---

## ❓ Common Issues & Solutions

### Issue 1: "401 Unauthorized" in Swagger
**Solution**: You need the API key. Request it from Blu support first.

### Issue 2: "Can't find VAS endpoints"
**Solution**: Look for these alternative names:
- "Recharge"
- "Top-up"
- "Mobile Services"
- "Prepaid"
- "Products"

### Issue 3: "Swagger UI looks different"
**Solution**: That's OK! Just look for any endpoints related to:
- Buying airtime
- Buying data
- Listing products/bundles

---

## 🎯 Success Criteria

You've completed this task when you can answer:

✅ What is the airtime purchase endpoint path?  
✅ What is the data purchase endpoint path?  
✅ How does Blu identify networks? (VODACOM vs VODA vs 1)  
✅ How does Blu identify bundles? (codes, IDs, names?)  
✅ What does a successful response look like?  
✅ What does an error response look like?  

---

## ⏱️ Time Estimate

- **If you have API key**: 30-45 minutes
- **If you DON'T have API key**: 15-20 minutes (just document endpoints)

---

## 📞 Need Help?

If you get stuck:
1. Take a screenshot of what you see
2. Share it with me
3. I'll guide you through it!

---

## 🚀 What Happens Next?

Once you share the endpoint details:
1. **I'll implement** `BluVasClient` (2 hours)
2. **I'll create** BFF routes (2 hours)
3. **I'll wire** NLP → BFF (1 hour)
4. **We'll test** end-to-end together! 🎉

Then customers can buy airtime and data via WhatsApp! 📱

---

## 💡 Pro Tip

If Swagger UI is confusing, just:
1. Take a screenshot of the whole page
2. Send it to me
3. I'll tell you exactly what to look for!

**You've got this!** 💪


