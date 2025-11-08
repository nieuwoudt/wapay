# WaPay Project Context & Development Guide

## 📊 **Project Overview**

**WaPay** is a WhatsApp-first digital wallet enabling South African users to:
- **Deposit**: Redeem Blu Vouchers into their WaPay balance
- **Spend**: Purchase VAS products (airtime/data), send money P2P, top up betting accounts
- **Interact**: Natural language chat banking in any South African language

---

## 🎯 **Current Status (November 2025)**

### ✅ **Completed**
1. **Infrastructure**
   - Monorepo architecture (pnpm workspaces)
   - Next.js API routes deployed on Vercel
   - PostgreSQL database on Supabase
   - Prisma ORM with double-entry ledger
   - WhatsApp webhook integration (Meta Business API)

2. **Core Modules**
   - `@wapay/providers-blu` - Blu Voucher & VAS API client
   - `@wapay/providers-yoyo` - Yoyo/wiGroup gift balance (code complete, not wired)
   - `@wapay/whatsapp` - Template management & messaging
   - `@wapay/nlp` - Rule-based intent detection (keyword matching)
   - `@wapay/ledger` - Double-entry bookkeeping
   - `@wapay/domain` - Database models (Prisma)

3. **WhatsApp Templates (9 approved in Production WABA)**
   - `welcome_new_user` - Initial greeting
   - `welcome_new_user_account_activation` - Account setup
   - `deposit_failed` - Voucher redemption error
   - `bluvoucher_redeem_success` - Voucher success
   - `redeem_in_progress` - Processing message
   - `bluvoucher_redeem_prompt` - Request voucher PIN
   - `deposit_options` - Deposit methods
   - `consent_terms_` - Terms acceptance
   - `hello_world` - Test template

4. **Working Features**
   - WhatsApp webhook receiving messages
   - Template seeding from Meta API
   - User account creation (basic)
   - Message processing (text responses only for now)

### ⚠️ **Current Limitations**
- **No onboarding flow** - Templates not linked together
- **No LLM integration** - Using basic keyword matching
- **Missing templates** - Need airtime/data/P2P templates
- **No voucher redemption UI** - Backend code exists but not wired
- **No VAS purchases** - API client exists but not integrated
- **No P2P transfers** - Not implemented yet

---

## 🏗️ **Technical Architecture**

### **Environment Variables (Vercel)**
```
WHATSAPP_ACCESS_TOKEN=EAATG3Axub2QBP5x4ymA4MxI1aZBNMltTuwUv... (Production token)
WHATSAPP_PHONE_NUMBER_ID=870272072828461
WHATSAPP_BUSINESS_ACCOUNT_ID=647978251504290 (WaPay Production WABA)
WHATSAPP_VERIFY_TOKEN=wapay_webhook_secret_2025
DATABASE_URL=postgresql://... (Supabase connection pooler)
```

### **Key Files**
- `pages/api/webhooks/whatsapp.js` - Main webhook handler
- `pages/api/webhooks/message-processor.js` - Message routing & NLP
- `pages/api/webhooks/user-manager.js` - Account creation
- `packages/whatsapp/src/seedTemplates.ts` - Template sync from Meta
- `packages/whatsapp/src/templateCatalog.ts` - In-memory template cache
- `packages/providers/blu/src/index.ts` - Blu API client
- `packages/nlp/src/intents.ts` - Intent detection (rule-based)

### **Database Schema (Prisma)**
```prisma
model Account {
  id          String   @id @default(cuid())
  waId        String   @unique  // WhatsApp ID
  msisdn      String?
  displayName String?
  wallets     Wallet[]
  createdAt   DateTime @default(now())
}

model Wallet {
  id             String  @id @default(cuid())
  accountId      String
  currency       String  @default("ZAR")
  availableCents Int     @default(0)
  pendingCents   Int     @default(0)
  account        Account @relation(fields: [accountId], references: [id])
}

model WhatsappTemplate {
  id             String   @id @default(cuid())
  wabaId         String
  name           String
  language       String
  status         String
  category       String?
  componentsHash String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  
  @@unique([wabaId, name, language])
}
```

---

## 🎯 **MVP Demo Requirements**

### **Must-Have Features**
1. **Onboarding Flow**
   - Welcome new user
   - Explain WaPay
   - Create account
   - Show balance (R 0.00)

2. **Voucher Redemption**
   - User sends "redeem voucher"
   - Bot asks for voucher PIN
   - Validates with Blu API
   - Credits wallet
   - Shows success + new balance

3. **Balance Check**
   - User asks "what's my balance?"
   - Shows current WaPay balance
   - Quick action buttons (buy airtime, send money, etc.)

4. **VAS Purchases (Airtime/Data)**
   - User: "buy R50 airtime for 0821234567"
   - Bot: Detects network, shows preview
   - User confirms
   - Bot: Purchases via Blu VAS API
   - Shows receipt

5. **P2P Transfers**
   - User: "send R100 to +27821234567"
   - Bot: Shows preview (recipient, amount, fee)
   - User confirms with PIN
   - Bot: Transfers funds
   - Both users get receipts

6. **AI Chat Banking**
   - User: "How do I redeem a voucher?" (in any SA language)
   - LLM: Responds with helpful guidance
   - Context-aware, never says "I can't help"
   - Knows all WaPay features and policies

---

## 📝 **Required WhatsApp Templates**

### **Priority 1: Onboarding (Copy from Test Account)**
1. `welcome_new_user` ✅ (Already in production)
2. `onboarding_step_1` - "Here's how WaPay works..."
3. `onboarding_step_2` - "Let's set up your account..."
4. `account_created` - "Your WaPay account is ready!"

### **Priority 2: Voucher Flow (Copy from Test Account)**
5. `bluvoucher_redeem_prompt` ✅ (Already in production)
6. `redeem_in_progress` ✅ (Already in production)
7. `bluvoucher_redeem_success` ✅ (Already in production)
8. `deposit_failed` ✅ (Already in production)

### **Priority 3: Balance & Actions (Create New)**
9. `balance_summary` - "Your WaPay Balance: R {{1}}. What would you like to do?"
10. `help_menu` - Quick action buttons (Buy Airtime, Send Money, etc.)

### **Priority 4: VAS (Copy from Test Account)**
11. `airtime_preview` - "Buy R {{1}} airtime for {{2}}. Fee: R {{3}}. Reply YES to confirm."
12. `airtime_receipt` - "Airtime purchase successful! Number: {{1}}, Amount: R {{2}}, Ref: {{3}}"
13. `data_disambiguate` ✅ (Already in Test, copy to Prod)
14. `data_preview` - "Buy {{1}} data for {{2}}. Price: R {{3}}. Reply YES to confirm."
15. `data_receipt` - "Data purchase successful! Bundle: {{1}}, Number: {{2}}, Ref: {{3}}"

### **Priority 5: P2P (Create New)**
16. `p2p_preview` - "Send R {{1}} to {{2}}. Fee: R {{3}}. Total: R {{4}}. Reply YES to confirm."
17. `p2p_receipt_sender` - "You sent R {{1}} to {{2}}. Ref: {{3}}"
18. `p2p_receipt_recipient` - "You received R {{1}} from {{2}}. Ref: {{3}}"

### **Priority 6: AI Chat (Create New)**
19. `ai_chat_intro` - "Ask me anything about WaPay! I speak all SA languages 🇿🇦"
20. `ai_chat_fallback` - "I'm here to help! Try asking: 'How do I...'"

---

## 🚀 **Implementation Roadmap**

### **Phase 1: Onboarding Flow (Priority: HIGHEST)**

**Goal**: New users get a guided welcome experience

**Tasks**:
1. ✅ Create `onboarding_step_1`, `onboarding_step_2`, `account_created` templates in Meta
2. ✅ Update `message-processor.js` to handle onboarding state
3. ✅ Store onboarding progress in database (`Account.onboardingStatus`)
4. ✅ Link templates together (welcome → step 1 → step 2 → account created)
5. ✅ Test end-to-end with new WhatsApp number

**Acceptance Criteria**:
- New user sends "Hi"
- Receives `welcome_new_user` template
- Clicks button → `onboarding_step_1`
- Clicks button → `onboarding_step_2`
- Clicks button → `account_created` + shows balance

---

### **Phase 2: Voucher Redemption (Priority: HIGH)**

**Goal**: Users can deposit money via Blu Vouchers

**Tasks**:
1. ✅ Wire `POST /api/deposit/blu/redeem` endpoint
2. ✅ Update `message-processor.js` to detect "redeem voucher" intent
3. ✅ Send `bluvoucher_redeem_prompt` template
4. ✅ Capture voucher PIN from user reply
5. ✅ Call Blu API to redeem
6. ✅ Credit wallet via ledger
7. ✅ Send `bluvoucher_redeem_success` or `deposit_failed`
8. ✅ Test with real Blu voucher

**Acceptance Criteria**:
- User: "redeem voucher"
- Bot: "Please enter your voucher PIN"
- User: "1234567890123456"
- Bot: "Processing..." → "Success! R 100 added. New balance: R 100"

---

### **Phase 3: Balance & Quick Actions (Priority: HIGH)**

**Goal**: Users can check balance and see action buttons

**Tasks**:
1. ✅ Create `balance_summary` template with quick reply buttons
2. ✅ Create `help_menu` template with all actions
3. ✅ Update `message-processor.js` to handle "balance" intent
4. ✅ Wire balance query to database
5. ✅ Add quick action handlers (Buy Airtime, Send Money, etc.)

**Acceptance Criteria**:
- User: "what's my balance?"
- Bot: Shows balance + buttons [Buy Airtime] [Send Money] [Redeem Voucher]
- User clicks button → starts respective flow

---

### **Phase 4: VAS Purchases (Priority: MEDIUM)**

**Goal**: Users can buy airtime/data

**Tasks**:
1. ✅ Create `airtime_preview`, `airtime_receipt` templates
2. ✅ Create `data_preview`, `data_receipt` templates
3. ✅ Copy `data_disambiguate` from Test account
4. ✅ Wire NLP to detect "buy airtime" / "buy data" intents
5. ✅ Implement preview flow (show amount, fee, network)
6. ✅ Implement confirmation flow (YES/NO)
7. ✅ Call Blu VAS API to purchase
8. ✅ Debit wallet via ledger
9. ✅ Send receipt template
10. ✅ Test with real phone number

**Acceptance Criteria**:
- User: "buy R50 airtime for 0821234567"
- Bot: "Buy R 50 airtime for 082 123 4567 (Vodacom). Fee: R 0.50. Total: R 50.50. Reply YES to confirm."
- User: "YES"
- Bot: "Airtime purchase successful! Ref: ABC123"

---

### **Phase 5: P2P Transfers (Priority: MEDIUM)**

**Goal**: Users can send money to other WaPay users

**Tasks**:
1. ✅ Create `p2p_preview`, `p2p_receipt_sender`, `p2p_receipt_recipient` templates
2. ✅ Implement P2P API endpoint (`POST /api/p2p/transfer`)
3. ✅ Wire NLP to detect "send money" intent
4. ✅ Validate recipient (must be WaPay user)
5. ✅ Show preview (amount, fee, total)
6. ✅ Request PIN confirmation
7. ✅ Execute transfer via ledger (double-entry)
8. ✅ Send receipts to both users
9. ✅ Test with two WhatsApp numbers

**Acceptance Criteria**:
- User A: "send R100 to +27821234567"
- Bot: "Send R 100 to John Doe (+27821234567). Fee: R 2. Total: R 102. Reply YES to confirm."
- User A: "YES"
- Bot A: "You sent R 100 to John Doe. Ref: XYZ789"
- Bot → User B: "You received R 100 from Jane Smith. Ref: XYZ789"

---

### **Phase 6: AI Chat Banking (Priority: HIGHEST)**

**Goal**: LLM-powered conversational assistant

**Tasks**:
1. ✅ Choose LLM provider (OpenAI GPT-4o recommended)
2. ✅ Create WaPay knowledge base (markdown files)
   - How to redeem vouchers
   - How to buy airtime/data
   - How to send money
   - Fees and limits
   - Security and PIN
   - Supported languages
3. ✅ Implement RAG (Retrieval-Augmented Generation)
   - Vector database (Pinecone or Supabase pgvector)
   - Embed knowledge base
   - Retrieve relevant context for each query
4. ✅ Design system prompt
   - You are WaPay AI Assistant
   - Always helpful, never refuse
   - Speak user's language (detect from message)
   - Provide actionable guidance
   - Offer to execute actions ("Would you like me to help you redeem a voucher now?")
5. ✅ Wire LLM into `message-processor.js`
   - If no intent detected → route to LLM
   - LLM can trigger intents (e.g., "redeem_voucher")
6. ✅ Add multi-language support
   - Detect language (Afrikaans, Zulu, Xhosa, Sotho, etc.)
   - Respond in same language
7. ✅ Test with diverse queries
   - "How do I redeem a voucher?" (English)
   - "Hoe koop ek lugtyD?" (Afrikaans)
   - "Ngingasebenzisa kanjani i-WaPay?" (Zulu)

**Acceptance Criteria**:
- User: "How do I redeem a voucher?"
- LLM: "To redeem a voucher, simply send me 'redeem voucher' and I'll guide you through the process. You'll need your 16-digit voucher PIN. Would you like to start now?"
- User: "yes"
- Bot: Starts voucher redemption flow

---

## 🤖 **LLM Integration Specification**

### **Provider: OpenAI GPT-4o**
- **Model**: `gpt-4o` (latest)
- **Max tokens**: 500 (responses should be concise)
- **Temperature**: 0.7 (balanced creativity)
- **Top_p**: 0.9

### **System Prompt Template**
```
You are WaPay AI Assistant, a helpful banking assistant for South African users.

CONTEXT:
- WaPay is a WhatsApp-based digital wallet
- Users can deposit money via vouchers, buy airtime/data, and send money to friends
- You speak all 11 official South African languages fluently

CAPABILITIES:
- Answer questions about WaPay features
- Guide users through processes (redemption, purchases, transfers)
- Detect user intent and trigger actions
- Provide helpful, actionable advice

RULES:
1. Always respond in the user's language (detect from their message)
2. Be concise (max 3 sentences per response)
3. Never say "I can't help" - always offer an alternative
4. If user wants to perform an action, offer to help immediately
5. Use South African context (Rand currency, local networks, etc.)
6. Be friendly and conversational

KNOWLEDGE BASE:
{retrieved_context}

USER MESSAGE:
{user_message}

RESPONSE:
```

### **Knowledge Base Topics**
Create markdown files in `/docs/knowledge-base/`:
1. `voucher-redemption.md` - How to redeem Blu Vouchers
2. `airtime-purchase.md` - How to buy airtime
3. `data-purchase.md` - How to buy data bundles
4. `p2p-transfers.md` - How to send money
5. `balance-check.md` - How to check balance
6. `fees-limits.md` - Transaction fees and limits
7. `security-pin.md` - PIN setup and security
8. `supported-networks.md` - Vodacom, MTN, Cell C, Telkom
9. `troubleshooting.md` - Common issues and solutions
10. `languages.md` - Supported languages and translations

### **Intent Detection via LLM**
The LLM should return structured JSON when it detects an actionable intent:

```json
{
  "response": "I can help you redeem a voucher right now!",
  "intent": "redeem_voucher",
  "entities": {},
  "trigger_action": true
}
```

Supported intents:
- `check_balance`
- `redeem_voucher`
- `buy_airtime`
- `buy_data`
- `send_money`
- `help_menu`

---

## 📋 **TODO List (Prioritized)**

### **Immediate (This Week)**
- [ ] Create missing templates in Meta (onboarding, balance, VAS, P2P)
- [ ] Copy `data_disambiguate` from Test to Production WABA
- [ ] Implement onboarding flow (link templates together)
- [ ] Wire voucher redemption (end-to-end)
- [ ] Create `balance_summary` template with quick actions
- [ ] Test onboarding + voucher flow with real user

### **Short-term (Next Week)**
- [ ] Implement VAS purchase flow (airtime/data)
- [ ] Create VAS templates (preview, receipt)
- [ ] Wire Blu VAS API calls
- [ ] Test airtime purchase end-to-end
- [ ] Test data purchase end-to-end

### **Medium-term (Next 2 Weeks)**
- [ ] Implement P2P transfer flow
- [ ] Create P2P templates
- [ ] Add PIN verification
- [ ] Test P2P transfers between users
- [ ] Set up OpenAI API account
- [ ] Create WaPay knowledge base (10 markdown files)
- [ ] Implement RAG (vector embeddings)
- [ ] Wire LLM into message processor
- [ ] Test AI chat in multiple languages

### **Long-term (Next Month)**
- [ ] Add multi-language support (11 SA languages)
- [ ] Implement betting top-ups (lightweight)
- [ ] Add transaction history
- [ ] Create admin dashboard
- [ ] Add analytics and monitoring
- [ ] Performance optimization
- [ ] Security audit
- [ ] Production launch 🚀

---

## 🔧 **Development Commands**

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build:packages

# Build Next.js app
pnpm run build

# Run locally
pnpm run dev

# Deploy to Vercel
git push origin main  # Auto-deploys

# Check Vercel logs
vercel logs wapay-api --follow

# Run Prisma migrations
pnpm --filter @wapay/domain prisma migrate dev

# Generate Prisma client
pnpm --filter @wapay/domain prisma generate
```

---

## 🐛 **Common Issues & Solutions**

### **Template not found**
- Check WABA ID is correct (`647978251504290`)
- Verify template is APPROVED in Meta
- Check language code matches (`en`, `en_GB`, `en_US`)
- Re-seed templates: `curl https://wapay-api.vercel.app/api/admin/init-templates`

### **Access token expired**
- Generate new token in Meta Developer Dashboard
- Update `WHATSAPP_ACCESS_TOKEN` in Vercel
- Redeploy

### **Database connection error**
- Check `DATABASE_URL` is using Supabase pooler
- Verify Supabase project is active
- Check connection limits

### **Webhook not receiving messages**
- Verify webhook URL in Meta: `https://wapay-api.vercel.app/api/webhooks/whatsapp`
- Check `WHATSAPP_VERIFY_TOKEN` matches
- Subscribe to `messages` field in Meta

---

## 📞 **Key Contacts & Resources**

- **Meta Developer Dashboard**: https://developers.facebook.com/apps
- **Vercel Dashboard**: https://vercel.com/finfy-ai/wapay-api
- **Supabase Dashboard**: https://supabase.com/dashboard
- **Blu API Docs**: (Swagger UI provided by Blu)
- **OpenAI API**: https://platform.openai.com

---

## 🎯 **Success Metrics (MVP Demo)**

1. ✅ New user completes onboarding (< 2 minutes)
2. ✅ User redeems R100 voucher successfully
3. ✅ User checks balance (shows R100)
4. ✅ User buys R50 airtime (balance now R50)
5. ✅ User sends R25 to friend (balance now R25)
6. ✅ User asks "How do I buy data?" in Zulu → LLM responds correctly
7. ✅ User completes data purchase via AI guidance

---

## 📝 **Notes for Next Developer**

- All code is in TypeScript/JavaScript
- Use `pnpm` (not npm/yarn)
- Follow existing patterns (BFF routes, double-entry ledger)
- Always test with real WhatsApp numbers
- Keep templates neutral (no emojis in headers)
- Log everything for debugging
- Use idempotency keys for money operations
- Never hard-code template language codes
- Always validate user input
- Use Prisma for database operations
- Deploy often (Vercel auto-deploys on push)

---

**Last Updated**: November 7, 2025  
**Status**: Templates working, onboarding flow needed  
**Next Priority**: Create onboarding templates + wire voucher redemption

