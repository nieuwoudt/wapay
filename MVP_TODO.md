# WaPay MVP Development - TODO Tracker

**Last Updated**: November 7, 2025  
**Status**: Templates working, ready for onboarding implementation

---

## 🎯 **Sprint 1: Onboarding Flow (Week 1)**

### **Templates** ⏳
- [ ] Create `onboarding_step_1` template in Meta
- [ ] Create `onboarding_step_2` template in Meta
- [ ] Create `account_created` template in Meta
- [ ] Create `balance_summary` template in Meta
- [ ] Wait for Meta approval (1-2 days)
- [ ] Verify templates appear in production WABA

### **Backend** ⏳
- [ ] Add `onboardingStatus` field to `Account` model
- [ ] Create Prisma migration
- [ ] Update `user-manager.js` to track onboarding state
- [ ] Implement onboarding state machine in `message-processor.js`
- [ ] Link templates together (welcome → step1 → step2 → created)
- [ ] Add button click handlers
- [ ] Test onboarding flow locally

### **Testing** ⏳
- [ ] Test with new WhatsApp number
- [ ] Verify all templates send correctly
- [ ] Verify buttons work
- [ ] Verify account is created
- [ ] Verify balance shows R 0.00
- [ ] Test on mobile device

**Acceptance Criteria**:
- ✅ New user sends "Hi"
- ✅ Receives welcome template
- ✅ Completes onboarding in < 2 minutes
- ✅ Sees account created confirmation
- ✅ Can check balance

---

## 🎯 **Sprint 2: Voucher Redemption (Week 1-2)**

### **Templates** ⏳
- [ ] Verify `bluvoucher_redeem_prompt` works
- [ ] Verify `redeem_in_progress` works
- [ ] Verify `bluvoucher_redeem_success` works
- [ ] Verify `deposit_failed` works

### **Backend** ⏳
- [ ] Wire `POST /api/deposit/blu/redeem` endpoint
- [ ] Add voucher redemption intent to NLP
- [ ] Implement conversation state for PIN capture
- [ ] Add Blu API error handling
- [ ] Implement ledger posting for deposits
- [ ] Update wallet balance
- [ ] Send success/failure templates
- [ ] Add idempotency handling

### **Testing** ⏳
- [ ] Test with valid Blu voucher
- [ ] Test with invalid voucher
- [ ] Test with expired voucher
- [ ] Verify balance updates correctly
- [ ] Verify ledger entries are correct
- [ ] Test idempotency (duplicate requests)

**Acceptance Criteria**:
- ✅ User: "redeem voucher"
- ✅ Bot: "Please enter your voucher PIN"
- ✅ User: "1234567890123456"
- ✅ Bot: "Processing..." → "Success! R 100 added"
- ✅ Balance updates from R 0 to R 100

---

## 🎯 **Sprint 3: Balance & Quick Actions (Week 2)**

### **Templates** ⏳
- [ ] Verify `balance_summary` template works
- [ ] Copy `help_me_menu` from Test account
- [ ] Verify quick reply buttons work

### **Backend** ⏳
- [ ] Wire balance check intent
- [ ] Query wallet balance from database
- [ ] Format balance display (R 100.50)
- [ ] Add quick action button handlers
- [ ] Route button clicks to respective flows

### **Testing** ⏳
- [ ] Test balance check
- [ ] Test quick action buttons
- [ ] Verify routing works

**Acceptance Criteria**:
- ✅ User: "what's my balance?"
- ✅ Bot: Shows balance + action buttons
- ✅ User clicks "Buy Airtime" → starts airtime flow

---

## 🎯 **Sprint 4: VAS Purchases (Week 2-3)**

### **Templates** ⏳
- [ ] Create `airtime_preview` template
- [ ] Copy `airtime_receipt` from Test account
- [ ] Copy `data_disambiguate` from Test account
- [ ] Create `data_preview` template
- [ ] Copy `data_receipt` from Test account
- [ ] Wait for Meta approval

### **Backend** ⏳
- [ ] Wire `POST /api/vas/airtime/preview` endpoint
- [ ] Wire `POST /api/vas/airtime/execute` endpoint
- [ ] Wire `POST /api/vas/data/preview` endpoint
- [ ] Wire `POST /api/vas/data/execute` endpoint
- [ ] Add airtime/data intents to NLP
- [ ] Implement network detection (Blu API)
- [ ] Implement confirmation flow (YES/NO)
- [ ] Call Blu VAS API for purchase
- [ ] Debit wallet via ledger
- [ ] Send receipt templates
- [ ] Add error handling

### **Testing** ⏳
- [ ] Test airtime purchase (all networks)
- [ ] Test data purchase (all networks)
- [ ] Test insufficient balance
- [ ] Test invalid phone number
- [ ] Verify receipts are sent
- [ ] Verify balance updates

**Acceptance Criteria**:
- ✅ User: "buy R50 airtime for 0821234567"
- ✅ Bot: Shows preview with network, fee, total
- ✅ User: "YES"
- ✅ Bot: Purchases airtime via Blu API
- ✅ Bot: Sends receipt
- ✅ Balance updates correctly

---

## 🎯 **Sprint 5: P2P Transfers (Week 3-4)**

### **Templates** ⏳
- [ ] Create `p2p_preview` template
- [ ] Create `p2p_receipt_sender` template
- [ ] Create `p2p_receipt_recipient` template
- [ ] Wait for Meta approval

### **Backend** ⏳
- [ ] Create `POST /api/p2p/transfer` endpoint
- [ ] Add P2P intent to NLP
- [ ] Validate recipient (must be WaPay user)
- [ ] Implement preview flow
- [ ] Add PIN verification
- [ ] Execute transfer via ledger (double-entry)
- [ ] Send receipts to both users
- [ ] Add fraud checks (velocity limits)

### **Testing** ⏳
- [ ] Test P2P between two users
- [ ] Test with invalid recipient
- [ ] Test with insufficient balance
- [ ] Test with wrong PIN
- [ ] Verify both users get receipts
- [ ] Verify balances update correctly

**Acceptance Criteria**:
- ✅ User A: "send R100 to +27821234567"
- ✅ Bot: Shows preview (recipient, amount, fee)
- ✅ User A: "YES"
- ✅ Bot A: "You sent R 100 to John Doe"
- ✅ Bot → User B: "You received R 100 from Jane Smith"

---

## 🎯 **Sprint 6: AI Chat Banking (Week 4-5)**

### **Setup** ⏳
- [ ] Create OpenAI API account
- [ ] Get API key
- [ ] Add `OPENAI_API_KEY` to Vercel env vars
- [ ] Install `openai` npm package

### **Knowledge Base** ⏳
- [ ] Create `/docs/knowledge-base/` folder
- [ ] Write `voucher-redemption.md`
- [ ] Write `airtime-purchase.md`
- [ ] Write `data-purchase.md`
- [ ] Write `p2p-transfers.md`
- [ ] Write `balance-check.md`
- [ ] Write `fees-limits.md`
- [ ] Write `security-pin.md`
- [ ] Write `supported-networks.md`
- [ ] Write `troubleshooting.md`
- [ ] Write `languages.md`

### **RAG Implementation** ⏳
- [ ] Choose vector database (Supabase pgvector or Pinecone)
- [ ] Embed knowledge base documents
- [ ] Store embeddings in vector DB
- [ ] Implement similarity search
- [ ] Test retrieval accuracy

### **LLM Integration** ⏳
- [ ] Create `packages/ai/src/chat.ts`
- [ ] Design system prompt
- [ ] Implement context retrieval
- [ ] Add language detection
- [ ] Wire LLM into `message-processor.js`
- [ ] Add fallback to LLM when no intent detected
- [ ] Implement intent extraction from LLM response
- [ ] Add conversation memory (last 5 messages)

### **Templates** ⏳
- [ ] Create `ai_chat_intro` template
- [ ] Create `ai_chat_response` template
- [ ] Wait for Meta approval

### **Testing** ⏳
- [ ] Test in English
- [ ] Test in Afrikaans
- [ ] Test in Zulu
- [ ] Test in Xhosa
- [ ] Test in Sotho
- [ ] Test diverse queries
- [ ] Test intent triggering
- [ ] Verify LLM never refuses to help

**Acceptance Criteria**:
- ✅ User: "How do I redeem a voucher?" (English)
- ✅ LLM: Provides helpful guidance
- ✅ User: "Hoe koop ek lugtyD?" (Afrikaans)
- ✅ LLM: Responds in Afrikaans
- ✅ User: "yes, help me"
- ✅ LLM: Triggers voucher redemption flow

---

## 🎯 **Sprint 7: Polish & Launch (Week 5-6)**

### **Multi-Language Support** ⏳
- [ ] Add language detection to NLP
- [ ] Translate templates to Afrikaans
- [ ] Translate templates to Zulu
- [ ] Translate templates to Xhosa
- [ ] Test all languages

### **Security** ⏳
- [ ] Implement PIN setup flow
- [ ] Add PIN verification for transfers
- [ ] Add rate limiting
- [ ] Add fraud detection
- [ ] Security audit

### **Monitoring** ⏳
- [ ] Add Sentry error tracking
- [ ] Add analytics (Mixpanel or Amplitude)
- [ ] Create admin dashboard
- [ ] Add transaction monitoring
- [ ] Set up alerts

### **Documentation** ⏳
- [ ] Update README
- [ ] Create user guide
- [ ] Create admin guide
- [ ] Document API endpoints
- [ ] Create troubleshooting guide

### **Testing** ⏳
- [ ] End-to-end testing
- [ ] Load testing
- [ ] Security testing
- [ ] User acceptance testing
- [ ] Bug fixes

### **Launch** ⏳
- [ ] Final deployment
- [ ] Announce to users
- [ ] Monitor closely
- [ ] Gather feedback
- [ ] Iterate

---

## 📊 **Progress Tracking**

### **Week 1**
- [ ] Onboarding flow complete
- [ ] Voucher redemption working
- [ ] Balance check working

### **Week 2**
- [ ] VAS purchases working (airtime + data)
- [ ] Quick actions working

### **Week 3**
- [ ] P2P transfers working
- [ ] AI chat foundation ready

### **Week 4**
- [ ] AI chat fully integrated
- [ ] Multi-language support

### **Week 5-6**
- [ ] Polish and launch
- [ ] Production ready

---

## 🎯 **MVP Demo Checklist**

On demo day, you should be able to:

- [ ] Show new user onboarding (< 2 min)
- [ ] Redeem R100 Blu Voucher
- [ ] Check balance (shows R100)
- [ ] Buy R50 airtime for any network
- [ ] Check balance (shows R50)
- [ ] Send R25 to another WaPay user
- [ ] Check balance (shows R25)
- [ ] Ask AI: "How do I buy data?" in Zulu
- [ ] AI responds in Zulu and helps purchase data
- [ ] Check balance (shows remaining amount)
- [ ] Ask AI: "What are the fees?" in Afrikaans
- [ ] AI responds with fee structure

**Total demo time**: 10-15 minutes  
**Wow factor**: ⭐⭐⭐⭐⭐

---

**Ready to start? Begin with Sprint 1 (Onboarding Flow)!** 🚀

