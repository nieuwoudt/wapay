# 🧪 NLP Test Cases

## Test Pack: 30+ Real-World Utterances

### ✅ CHECK_BALANCE (5 tests)

```typescript
classifyIntent("what's my balance?")
// Expected: { intent: 'CHECK_BALANCE', confidence: 0.9 }

classifyIntent("how much money do i have")
// Expected: { intent: 'CHECK_BALANCE', confidence: 0.9 }

classifyIntent("balance")
// Expected: { intent: 'CHECK_BALANCE', confidence: 0.7 }

classifyIntent("show my wallet")
// Expected: { intent: 'CHECK_BALANCE', confidence: 0.9 }

classifyIntent("check balance and gift")
// Expected: { intent: 'CHECK_BALANCE', includeGift: true }
```

---

### ✅ BUY_AIRTIME (6 tests)

```typescript
classifyIntent("buy me R50 Vodacom airtime for 0821234567")
// Expected: {
//   intent: 'BUY_AIRTIME',
//   amountCents: 5000,
//   network: 'VODACOM',
//   targetMsisdn: '+27821234567'
// }

classifyIntent("recharge 0721234567 with R20")
// Expected: {
//   intent: 'BUY_AIRTIME',
//   amountCents: 2000,
//   targetMsisdn: '+27721234567'
// }

classifyIntent("I need airtime")
// Expected: {
//   intent: 'BUY_AIRTIME',
//   confidence: 0.7
// }
// Router should request: amount + phone number

classifyIntent("R50 MTN airtime")
// Expected: {
//   intent: 'BUY_AIRTIME',
//   amountCents: 5000,
//   network: 'MTN'
// }
// Router should request: phone number

classifyIntent("top up 082 123 4567 with R100")
// Expected: {
//   intent: 'BUY_AIRTIME',
//   amountCents: 10000,
//   targetMsisdn: '+27821234567'
// }

classifyIntent("buy 50 rand airtime for +27 82 123 4567")
// Expected: {
//   intent: 'BUY_AIRTIME',
//   amountCents: 5000,
//   targetMsisdn: '+27821234567'
// }
```

---

### ✅ BUY_DATA (6 tests)

```typescript
classifyIntent("buy 1gb data for 0821234567")
// Expected: {
//   intent: 'BUY_DATA',
//   dataMb: 1024,
//   targetMsisdn: '+27821234567'
// }

classifyIntent("500mb weekly for 0721234567")
// Expected: {
//   intent: 'BUY_DATA',
//   dataMb: 512,
//   bundlePreference: 'weekly',
//   targetMsisdn: '+27721234567'
// }

classifyIntent("I need 2GB")
// Expected: {
//   intent: 'BUY_DATA',
//   dataMb: 2048
// }
// Router should request: phone number

classifyIntent("buy me a daily data bundle")
// Expected: {
//   intent: 'BUY_DATA',
//   bundlePreference: 'daily'
// }
// Router should request: phone number

classifyIntent("data for 082 123 4567")
// Expected: {
//   intent: 'BUY_DATA',
//   targetMsisdn: '+27821234567'
// }
// Router should request: data amount

classifyIntent("get 500MB vodacom bundle")
// Expected: {
//   intent: 'BUY_DATA',
//   dataMb: 512,
//   network: 'VODACOM'
// }
```

---

### ✅ BETTING_TOPUP (5 tests)

```typescript
classifyIntent("top up Hollywoodbets R100")
// Expected: {
//   intent: 'BETTING_TOPUP',
//   operatorCode: 'HOLLYWOODBETS',
//   amountCents: 10000
// }

classifyIntent("betway 50 rand")
// Expected: {
//   intent: 'BETTING_TOPUP',
//   operatorCode: 'BETWAY',
//   amountCents: 5000
// }

classifyIntent("deposit R200 to lottostar")
// Expected: {
//   intent: 'BETTING_TOPUP',
//   operatorCode: 'LOTTOSTAR',
//   amountCents: 20000
// }

classifyIntent("I want to bet")
// Expected: {
//   intent: 'BETTING_TOPUP'
// }
// Router should request: operator + amount

classifyIntent("hollywoodbets")
// Expected: {
//   intent: 'BETTING_TOPUP',
//   operatorCode: 'HOLLYWOODBETS'
// }
// Router should request: amount
```

---

### ✅ P2P_SEND (4 tests)

```typescript
classifyIntent("send R75 to Thandi")
// Expected: {
//   intent: 'P2P_SEND',
//   amountCents: 7500,
//   contactName: 'Thandi'
// }
// Router should request: phone number (resolve contact)

classifyIntent("transfer 100 rand to 0821234567")
// Expected: {
//   intent: 'P2P_SEND',
//   amountCents: 10000,
//   targetMsisdn: '+27821234567'
// }

classifyIntent("pay John R50")
// Expected: {
//   intent: 'P2P_SEND',
//   amountCents: 5000,
//   contactName: 'John'
// }

classifyIntent("send money to 082 123 4567")
// Expected: {
//   intent: 'P2P_SEND',
//   targetMsisdn: '+27821234567'
// }
// Router should request: amount
```

---

### ✅ REDEEM_VOUCHER (3 tests)

```typescript
classifyIntent("redeem 5608 6445 5561 2212")
// Expected: {
//   intent: 'REDEEM_VOUCHER',
//   pin: '5608644555612212'
// }

classifyIntent("use voucher pin 1234-5678-9012-3456")
// Expected: {
//   intent: 'REDEEM_VOUCHER',
//   pin: '1234567890123456'
// }

classifyIntent("I have a voucher")
// Expected: {
//   intent: 'REDEEM_VOUCHER'
// }
// Router should request: PIN
```

---

### ✅ PAY_AT_STORE (4 tests)

```typescript
classifyIntent("pay R79.88 at Checkers")
// Expected: {
//   intent: 'PAY_AT_STORE',
//   amountCents: 7988,
//   merchantName: 'checkers'
// }

classifyIntent("can I use WaPay at Shoprite?")
// Expected: {
//   intent: 'PAY_AT_STORE',
//   merchantName: 'shoprite'
// }
// Router: Check eligibility first

classifyIntent("pay at PnP")
// Expected: {
//   intent: 'PAY_AT_STORE',
//   merchantName: 'pnp'
// }
// Router should request: amount

classifyIntent("I want to pay R150 at the store")
// Expected: {
//   intent: 'PAY_AT_STORE',
//   amountCents: 15000
// }
// Router should request: merchant name (or generate generic code)
```

---

### ✅ UNKNOWN (2 tests)

```typescript
classifyIntent("hello")
// Expected: { intent: 'UNKNOWN', reason: 'No matching intent pattern found' }

classifyIntent("what time is it?")
// Expected: { intent: 'UNKNOWN', reason: 'No matching intent pattern found' }
```

---

## 🔄 Disambiguation Tests

### Missing Amount

```typescript
const intent = classifyIntent("buy airtime for 0821234567");
const route = routeIntent(intent, "account-123");

// Expected:
// {
//   success: false,
//   disambiguationNeeded: {
//     entity: 'amount',
//     prompt: 'How much airtime would you like to buy?',
//     quickReplies: ['R10', 'R20', 'R50', 'R100']
//   }
// }
```

### Missing Phone Number

```typescript
const intent = classifyIntent("buy R50 airtime");
const route = routeIntent(intent, "account-123");

// Expected:
// {
//   success: false,
//   disambiguationNeeded: {
//     entity: 'phone_number',
//     prompt: 'Which phone number should receive the airtime?'
//   }
// }
```

### Complete Intent

```typescript
const intent = classifyIntent("buy R50 Vodacom airtime for 0821234567");
const route = routeIntent(intent, "account-123");

// Expected:
// {
//   success: true,
//   route: {
//     method: 'POST',
//     path: '/api/vas/airtime/preview',
//     body: {
//       accountId: 'account-123',
//       targetMsisdn: '+27821234567',
//       amountCents: 5000
//     }
//   }
// }
```

---

## 🎯 Success Criteria

For production readiness, the NLP should:
- ✅ Classify 90%+ of test cases correctly
- ✅ Extract all entities accurately
- ✅ Generate helpful disambiguation prompts
- ✅ Route to correct API endpoints
- ✅ Handle edge cases gracefully

---

## 📊 Testing Instructions

### Manual Testing:
```typescript
import { classifyIntent, routeIntent } from '@wapay/nlp';

// Test individual classification
const intent = classifyIntent("buy R50 airtime for 0821234567");
console.log(intent);

// Test routing
const route = routeIntent(intent, "test-account");
console.log(route);
```

### Automated Testing (Future):
```bash
cd packages/nlp
pnpm test
```

Will run all test cases and report pass/fail rates.

