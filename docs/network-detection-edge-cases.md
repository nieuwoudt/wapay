# 🔍 Network Detection Edge Cases & Training Data

**Purpose**: Track edge cases for NLP training and network detection optimization  
**Date**: November 2, 2025  
**Version**: 1.0

---

## 📋 **Overview**

This document tracks all scenarios where network detection is used, including:
- ✅ Successful auto-detection
- ⚠️ Disambiguation needed
- ❌ Detection failures
- 🎯 NLP training opportunities

**Goal**: Improve NLP model to reduce disambiguation questions and increase auto-detection success rate.

---

## 🎯 **Success Metrics**

### **Current Baseline** (to be measured)
- Auto-detection success rate: TBD%
- Disambiguation required: TBD%
- Detection failures: TBD%

### **Target Goals**
- Auto-detection success rate: >95%
- Disambiguation required: <4%
- Detection failures: <1%

---

## 📊 **Scenario Categories**

### **Category 1: Perfect Auto-Detection** ✅

Customer provides phone number, system auto-detects network.

#### **Scenario 1.1: Full Info Provided**
```
Input: "Buy R50 Vodacom airtime for 0821234567"

NLP Extracts:
- Amount: 5000 cents
- Network: "Vodacom" (from text)
- Phone: "+27821234567"

Action: Skip detection (network already provided)
Result: ✅ SUCCESS - No API call needed
```

**Training Note**: When network is explicitly mentioned, trust NLP extraction.

---

#### **Scenario 1.2: Phone Number Only - Vodacom**
```
Input: "Buy R50 airtime for 0821234567"

NLP Extracts:
- Amount: 5000 cents
- Phone: "+27821234567"
- Network: MISSING

Blu API Call: checkMobileNumber("0821234567")
Response: { vendorName: "Vodacom", vendorId: "vodacom" }

Action: Auto-detected Vodacom
Result: ✅ SUCCESS
Message: "Buy R50 Vodacom airtime for 082 123 4567. Reply YES to confirm."
```

**Training Note**: 082 prefix = Vodacom (most common)

---

#### **Scenario 1.3: Phone Number Only - MTN**
```
Input: "Buy airtime for 0831234567"

NLP Extracts:
- Phone: "+27831234567"
- Network: MISSING

Blu API Call: checkMobileNumber("0831234567")
Response: { vendorName: "MTN", vendorId: "mtn" }

Action: Auto-detected MTN
Result: ✅ SUCCESS
```

**Training Note**: 083 prefix can be Vodacom or MTN - API confirms

---

#### **Scenario 1.4: Phone Number Only - Cell C**
```
Input: "Top up 0841234567 with R20"

NLP Extracts:
- Amount: 2000 cents
- Phone: "+27841234567"
- Network: MISSING

Blu API Call: checkMobileNumber("0841234567")
Response: { vendorName: "Cell C", vendorId: "cellc" }

Action: Auto-detected Cell C
Result: ✅ SUCCESS
```

**Training Note**: 084 prefix = Cell C (usually)

---

#### **Scenario 1.5: Phone Number Only - Telkom**
```
Input: "Recharge 0811234567"

NLP Extracts:
- Phone: "+27811234567"
- Network: MISSING

Blu API Call: checkMobileNumber("0811234567")
Response: { vendorName: "Telkom", vendorId: "telkom" }

Action: Auto-detected Telkom
Result: ✅ SUCCESS
```

**Training Note**: 081 prefix = Telkom or MTN - API confirms

---

### **Category 2: Disambiguation Required** ⚠️

Customer message is ambiguous, need to ask for clarification.

#### **Scenario 2.1: No Phone Number Provided**
```
Input: "I need R50 airtime"

NLP Extracts:
- Amount: 5000 cents
- Phone: MISSING
- Network: MISSING

Action: Ask for phone number
Result: ⚠️ DISAMBIGUATION
Template: topup_collect_number
Message: "To buy prepaid, please enter the mobile number incl. country code (e.g., +27 82 123 4567)."
```

**Training Note**: Teach NLP to prompt for phone number when missing.

---

#### **Scenario 2.2: Ambiguous Network Mention**
```
Input: "Buy airtime for my phone"

NLP Extracts:
- Intent: BUY_AIRTIME
- Phone: MISSING (user said "my phone" but no number)
- Network: MISSING

Action: Ask for phone number
Result: ⚠️ DISAMBIGUATION
```

**Training Note**: "my phone", "my number" = need actual number.

---

#### **Scenario 2.3: Multiple Phone Numbers**
```
Input: "Buy airtime for 0821234567 and 0831234567"

NLP Extracts:
- Phone: ["+27821234567", "+27831234567"]
- Multiple numbers detected

Action: Ask which number
Result: ⚠️ DISAMBIGUATION
Message: "Which number would you like to top up? Reply 1 or 2."
```

**Training Note**: Handle multiple numbers gracefully.

---

#### **Scenario 2.4: Network Mentioned But Unclear**
```
Input: "Buy vodacom"

NLP Extracts:
- Network: "Vodacom"
- Amount: MISSING
- Phone: MISSING

Action: Ask for amount and phone
Result: ⚠️ DISAMBIGUATION
```

**Training Note**: Network alone is not enough - need amount + phone.

---

### **Category 3: Detection Failures** ❌

Blu API fails or returns unknown network.

#### **Scenario 3.1: Invalid Phone Number**
```
Input: "Buy R50 airtime for 1234567"

NLP Extracts:
- Amount: 5000 cents
- Phone: "1234567" (invalid format)

Blu API Call: checkMobileNumber("1234567")
Response: 400 Bad Request - Invalid phone number

Action: Ask for valid phone number
Result: ❌ FAILURE
Message: "Please enter a valid South African mobile number (e.g., 082 123 4567)."
```

**Training Note**: Validate phone number format before API call.

---

#### **Scenario 3.2: International Number**
```
Input: "Buy airtime for +44 7700 900000"

NLP Extracts:
- Phone: "+447700900000" (UK number)

Blu API Call: checkMobileNumber("+447700900000")
Response: 400 Bad Request - Not a South African number

Action: Reject with helpful message
Result: ❌ FAILURE
Message: "Sorry, we only support South African mobile numbers at this time."
```

**Training Note**: Only accept +27 country code.

---

#### **Scenario 3.3: Blu API Timeout**
```
Input: "Buy R50 airtime for 0821234567"

NLP Extracts:
- Amount: 5000 cents
- Phone: "+27821234567"

Blu API Call: checkMobileNumber("0821234567")
Response: TIMEOUT (after 15 seconds)

Action: Fallback to prefix inference
Result: ⚠️ FALLBACK
Inference: 082 = Vodacom (most likely)
Message: "Buy R50 Vodacom airtime for 082 123 4567. Reply YES to confirm."
```

**Training Note**: Have fallback logic based on prefix when API fails.

---

#### **Scenario 3.4: Unknown Network**
```
Input: "Buy airtime for 0991234567"

NLP Extracts:
- Phone: "+27991234567" (hypothetical new prefix)

Blu API Call: checkMobileNumber("0991234567")
Response: { vendorName: "Unknown", vendorId: null }

Action: Ask for network manually
Result: ❌ FAILURE → DISAMBIGUATION
Message: "Which network? [Vodacom] [MTN] [Cell C] [Telkom]"
```

**Training Note**: Handle unknown networks gracefully.

---

### **Category 4: NLP Training Opportunities** 🎯

Variations in how customers express the same intent.

#### **Scenario 4.1: Casual Language**
```
Input: "top up my vodacom 082 123 4567"

NLP Should Extract:
- Intent: BUY_AIRTIME
- Network: "Vodacom"
- Phone: "+27821234567"
- Amount: MISSING (ask)

Training: "top up" = BUY_AIRTIME intent
```

---

#### **Scenario 4.2: Incomplete Sentences**
```
Input: "082 123 4567 R50 airtime"

NLP Should Extract:
- Phone: "+27821234567"
- Amount: 5000 cents
- Intent: BUY_AIRTIME

Training: Order doesn't matter - extract all entities
```

---

#### **Scenario 4.3: Colloquial Network Names**
```
Input: "Buy R20 MTN for 083 123 4567"
Input: "Buy R20 mtn for 083 123 4567"
Input: "Buy R20 Emtien for 083 123 4567" (phonetic)

NLP Should Extract:
- Network: "MTN" (normalize variations)

Training: Handle case-insensitive + phonetic variations
```

---

#### **Scenario 4.4: Implied Self-Topup**
```
Input: "I need R50 airtime"

Context: User's registered number is 082 123 4567

NLP Should Infer:
- Phone: Use user's registered number
- Amount: 5000 cents

Training: When phone is missing, consider self-topup
```

---

#### **Scenario 4.5: Contact Names**
```
Input: "Buy R50 airtime for Mom"

Context: User has contact "Mom" = 082 123 4567

NLP Should:
- Recognize "Mom" as contact reference
- Resolve to phone number
- Ask for confirmation

Training: Handle contact name resolution (future feature)
```

---

### **Category 5: Data Purchase Scenarios** 📊

Network detection for data bundles.

#### **Scenario 5.1: Data Bundle with Network**
```
Input: "Buy 1GB Vodacom data for 082 123 4567"

NLP Extracts:
- Intent: BUY_DATA
- Network: "Vodacom"
- Phone: "+27821234567"
- Data: 1GB

Action: Skip detection (network provided)
Result: ✅ SUCCESS
Next: Show Vodacom data bundles
```

---

#### **Scenario 5.2: Data Bundle Without Network**
```
Input: "Buy 1GB data for 082 123 4567"

NLP Extracts:
- Intent: BUY_DATA
- Phone: "+27821234567"
- Data: 1GB
- Network: MISSING

Blu API Call: checkMobileNumber("0821234567")
Response: { vendorName: "Vodacom", vendorId: "vodacom" }

Action: Auto-detected Vodacom
Result: ✅ SUCCESS
Next: Show Vodacom 1GB bundles
```

---

#### **Scenario 5.3: Generic Data Request**
```
Input: "I need data for 083 123 4567"

NLP Extracts:
- Intent: BUY_DATA
- Phone: "+27831234567"
- Network: MISSING

Blu API Call: checkMobileNumber("0831234567")
Response: { vendorName: "MTN", vendorId: "mtn" }

Action: Auto-detected MTN
Result: ✅ SUCCESS
Next: Show MTN data bundles (all sizes)
```

---

## 📈 **Logging Requirements**

### **What to Log for Each Transaction**

```json
{
  "timestamp": "2025-11-02T14:30:00Z",
  "userId": "cust-123",
  "waId": "+27821234567",
  "intent": "BUY_AIRTIME",
  "rawMessage": "Buy R50 airtime for 0821234567",
  
  "nlp": {
    "confidence": 0.95,
    "extractedEntities": {
      "amount": { "cents": 5000, "raw": "R50" },
      "phone": { "normalized": "+27821234567", "raw": "0821234567" },
      "network": null
    }
  },
  
  "networkDetection": {
    "method": "blu_api",
    "apiCalled": true,
    "apiResponse": {
      "vendorName": "Vodacom",
      "vendorId": "vodacom",
      "responseTime": 234
    },
    "result": "SUCCESS",
    "fallbackUsed": false
  },
  
  "outcome": {
    "disambiguationNeeded": false,
    "questionsAsked": 0,
    "transactionCompleted": true,
    "reference": "AIR-123456"
  }
}
```

---

## 🎯 **Training Data Collection**

### **Priority Utterances to Collect**

1. **Airtime Requests** (100+ variations)
   - "buy airtime"
   - "recharge"
   - "top up"
   - "load airtime"
   - "I need airtime"

2. **Network Mentions** (50+ variations)
   - "vodacom", "Vodacom", "VODACOM"
   - "mtn", "MTN", "Emtien"
   - "cell c", "cellc", "Cell C"
   - "telkom", "Telkom"

3. **Phone Number Formats** (30+ variations)
   - "082 123 4567"
   - "0821234567"
   - "+27 82 123 4567"
   - "+27821234567"
   - "27821234567"

4. **Amount Formats** (20+ variations)
   - "R50"
   - "50 rand"
   - "R 50"
   - "fifty rand"

---

## 📊 **Success Rate Tracking**

### **Weekly Metrics to Monitor**

```
Week 1 (Baseline):
- Total airtime requests: TBD
- Auto-detection success: TBD%
- Disambiguation required: TBD%
- Detection failures: TBD%
- Average questions per transaction: TBD

Week 2 (After NLP training):
- Total airtime requests: TBD
- Auto-detection success: TBD%
- Disambiguation required: TBD%
- Detection failures: TBD%
- Average questions per transaction: TBD

Target: Reduce questions per transaction from 2+ to <1
```

---

## 🔄 **Continuous Improvement Process**

### **Monthly Review Cycle**

1. **Collect Data** (ongoing)
   - Log all network detection attempts
   - Track success/failure rates
   - Identify common failure patterns

2. **Analyze Patterns** (weekly)
   - Which prefixes fail most?
   - Which utterances cause confusion?
   - Where does NLP need improvement?

3. **Update NLP Model** (monthly)
   - Add new training data
   - Improve entity extraction
   - Reduce disambiguation rate

4. **Update Fallback Logic** (as needed)
   - Improve prefix-based inference
   - Add new network prefixes
   - Handle edge cases better

---

## 🚨 **Alert Thresholds**

### **When to Investigate**

| Metric | Threshold | Action |
|--------|-----------|--------|
| Auto-detection success rate | <90% | Review Blu API reliability |
| Disambiguation rate | >10% | Improve NLP entity extraction |
| Detection failures | >2% | Check for new prefixes/networks |
| API timeout rate | >1% | Increase timeout or add fallback |
| Invalid phone format | >5% | Improve phone number validation |

---

## 📝 **Edge Case Checklist**

### **Before Launch**

- [ ] Test all SA mobile prefixes (082, 083, 084, 081, 071, 072, 073, 074)
- [ ] Test Blu API timeout handling
- [ ] Test invalid phone number formats
- [ ] Test international numbers (should reject)
- [ ] Test multiple phone numbers in one message
- [ ] Test with and without network mention
- [ ] Test with and without country code
- [ ] Test casual language variations
- [ ] Test incomplete sentences
- [ ] Test phonetic network names

### **Post-Launch Monitoring**

- [ ] Monitor auto-detection success rate daily
- [ ] Review failed detections weekly
- [ ] Collect user feedback on disambiguation
- [ ] Track average questions per transaction
- [ ] Identify new edge cases
- [ ] Update NLP training data monthly

---

## 🎓 **NLP Training Recommendations**

### **Phase 1: Entity Extraction** (Week 1-2)
Focus on accurately extracting:
- Phone numbers (all formats)
- Amounts (all formats)
- Networks (all variations)

### **Phase 2: Intent Classification** (Week 3-4)
Improve intent detection for:
- Airtime vs Data
- Self-topup vs Other-topup
- Ambiguous requests

### **Phase 3: Context Awareness** (Week 5-6)
Add context understanding:
- User's registered number
- Previous transactions
- Contact name resolution

### **Phase 4: Proactive Suggestions** (Week 7-8)
Suggest based on:
- Usage patterns
- Common amounts
- Frequent recipients

---

## 📚 **Reference: SA Mobile Prefixes**

### **Vodacom**
- 082 (primary)
- 083 (shared with MTN)
- 084 (shared with Cell C)
- 072, 073 (primary)
- 074 (shared with Cell C)

### **MTN**
- 081 (shared with Telkom)
- 083 (shared with Vodacom)
- 071 (primary)

### **Cell C**
- 084 (shared with Vodacom)
- 074 (shared with Vodacom)

### **Telkom**
- 081 (shared with MTN)

**Note**: Shared prefixes require API detection - cannot rely on prefix alone.

---

## 🎯 **Success Stories to Track**

### **Example: Perfect Auto-Detection**
```
Customer: "Buy R50 airtime for 0721234567"
System: Auto-detected Vodacom (072 prefix)
Questions asked: 0
Transaction completed: YES
Customer satisfaction: HIGH
```

### **Example: Smart Disambiguation**
```
Customer: "I need airtime"
System: "Which number? [My number: 082 123 4567] [Other number]"
Customer: "My number"
System: Auto-detected Vodacom
Questions asked: 1
Transaction completed: YES
Customer satisfaction: MEDIUM
```

---

## 🚀 **Future Enhancements**

### **Phase 2: Machine Learning**
- Train ML model on collected data
- Predict network from context
- Reduce API calls

### **Phase 3: Personalization**
- Remember user's preferred network
- Suggest based on history
- Auto-fill common recipients

### **Phase 4: Advanced NLP**
- Handle typos and misspellings
- Understand context across messages
- Support multiple languages

---

**Document Version**: 1.0  
**Last Updated**: November 2, 2025  
**Next Review**: December 2, 2025


