# 🤖 AI Chat Banking - Implementation Guide

**Status**: Ready to Implement  
**Priority**: HIGH - This is the game-changer feature!  
**Timeline**: 2-3 days

---

## 🎯 **Why AI Chat Banking?**

Instead of creating 50+ templates for every product variation, use AI to:
- Guide users conversationally
- Handle VAS purchases naturally
- Support all 11 SA languages automatically
- Answer questions about WaPay
- Trigger actions when needed

**Example**:
```
User: "Hoe koop ek lugtyD vir R50?" (Afrikaans)
AI: "Ek kan jou help! Vir watter nommer wil jy R50 lugtyD koop?" 
User: "0821234567"
AI: [Detects network, triggers airtime purchase]
```

---

## 🏗️ **Architecture**

```
User Message
    ↓
Intent Detection (rule-based)
    ↓
  Matched? → Execute action
    ↓ No
  LLM Processing
    ↓
  AI Response + Intent Extraction
    ↓
  Trigger Action if needed
```

---

## 📋 **Implementation Plan**

### **Phase 1: Basic LLM Integration (Day 1)** ✅ START HERE

#### **1.1 Set up OpenAI**

```bash
# Install OpenAI SDK
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"
pnpm add openai

# Add to Vercel environment variables:
OPENAI_API_KEY=sk-proj-...
```

#### **1.2 Create AI Package**

Create: `packages/ai/package.json`
```json
{
  "name": "@wapay/ai",
  "version": "0.0.1",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "openai": "^4.67.0"
  },
  "devDependencies": {
    "typescript": "^5.3.3"
  }
}
```

Create: `packages/ai/src/chat.ts`
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface ChatResponse {
  text: string;
  intent?: string;
  entities?: Record<string, any>;
  triggerAction?: boolean;
}

export async function chatWithAI(userMessage: string, context?: string): Promise<ChatResponse> {
  const systemPrompt = `You are WaPay AI Assistant, a helpful banking assistant for South African users.

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

KNOWLEDGE:
${context || 'General WaPay knowledge'}

INTENT DETECTION:
If the user wants to perform an action, respond with JSON:
{
  "text": "Your helpful response",
  "intent": "BUY_AIRTIME|BUY_DATA|REDEEM_VOUCHER|CHECK_BALANCE|SEND_MONEY",
  "entities": { "amount": "50", "network": "vodacom", etc },
  "triggerAction": true
}

For informational queries, just respond with plain text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const response = completion.choices[0].message.content || '';

    // Try to parse as JSON (for intent detection)
    try {
      const parsed = JSON.parse(response);
      return {
        text: parsed.text,
        intent: parsed.intent,
        entities: parsed.entities,
        triggerAction: parsed.triggerAction || false,
      };
    } catch {
      // Plain text response
      return { text: response };
    }

  } catch (error) {
    console.error('❌ OpenAI error:', error);
    throw error;
  }
}
```

Create: `packages/ai/src/index.ts`
```typescript
export * from './chat';
```

Create: `packages/ai/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

---

### **Phase 2: Wire to Message Processor (Day 1)**

Update `message-processor.js`:

```javascript
import { chatWithAI } from '@wapay/ai';

// In processMessage(), after intent detection fails:
if (intent === 'UNKNOWN') {
  console.log('🤖 Routing to AI chat');
  
  try {
    const aiResponse = await chatWithAI(text);
    
    // If AI detected an intent, trigger it
    if (aiResponse.triggerAction && aiResponse.intent) {
      console.log('🎯 AI detected intent:', aiResponse.intent);
      
      // Send AI response first
      await sendTextMessage({
        to: from,
        text: aiResponse.text,
      });
      
      // Then trigger the action
      return await handleIntent(from, aiResponse.intent, aiResponse.entities, account);
    }
    
    // Otherwise, just send AI response
    return await sendTextMessage({
      to: from,
      text: aiResponse.text,
    });
    
  } catch (error) {
    console.error('❌ AI chat error:', error);
    
    // Fallback to generic help
    return await sendTextMessage({
      to: from,
      text: `I'm having trouble understanding. Type "help" to see what I can do!`,
    });
  }
}
```

---

### **Phase 3: Knowledge Base (Day 2)** ⏳ OPTIONAL FOR MVP

Create markdown files in `/docs/knowledge-base/`:

1. **voucher-redemption.md**
```markdown
# How to Redeem Vouchers

To redeem a Blu Voucher:
1. Type "redeem voucher"
2. Enter your 16-digit voucher PIN
3. We'll add the amount to your WaPay balance instantly

Supported vouchers:
- Blu Vouchers (all denominations)
- Valid vouchers only (not expired or used)

Fees: No fees for voucher redemption
```

2. **airtime-purchase.md**
```markdown
# How to Buy Airtime

To buy airtime:
1. Tell me the amount and number: "Buy R50 airtime for 0821234567"
2. I'll detect the network automatically
3. Confirm the purchase
4. Done! Airtime delivered instantly

Supported networks:
- Vodacom
- MTN  
- Cell C
- Telkom

Minimum: R5
Maximum: R1000
Fee: R0.50 per transaction
```

3. **data-purchase.md**
```markdown
# How to Buy Data

To buy data:
1. Tell me what you need: "Buy 1GB for 0821234567"
2. I'll show you available bundles
3. Pick one and confirm
4. Done! Data activated instantly

Popular bundles:
- Vodacom: 1GB Daily (R12), 1GB Weekly (R29)
- MTN: 500MB Daily (R10), 1GB Weekly (R30)

Fee: R0.50 per transaction
```

4. **fees-limits.md**
```markdown
# Fees and Limits

Transaction Fees:
- Voucher redemption: Free
- Airtime purchase: R0.50
- Data purchase: R0.50
- P2P transfer: R2.00

Limits:
- Minimum airtime: R5
- Maximum airtime: R1000
- Maximum transaction: R5000
- Daily limit: R10,000
```

---

### **Phase 4: Enhanced AI with RAG (Day 3)** ⏳ POST-MVP

For more accurate responses, implement RAG:

1. **Install dependencies**:
```bash
pnpm add @supabase/supabase-js
```

2. **Enable pgvector in Supabase**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_embeddings (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  metadata JSONB
);

CREATE INDEX ON knowledge_embeddings 
USING ivfflat (embedding vector_cosine_ops);
```

3. **Embed knowledge base**:
```typescript
// Create embeddings for all knowledge docs
// Store in Supabase
```

4. **Retrieve context**:
```typescript
// On each query, find relevant context
// Pass to LLM as additional context
```

**Note**: This is optional for MVP. Start without RAG and add later.

---

## 🧪 **Testing**

### **Test Cases**:

1. **English**: "How do I redeem a voucher?"
2. **Afrikaans**: "Hoe koop ek lugtyD?"
3. **Zulu**: "Ngingasebenzisa kanjani i-WaPay?"
4. **Intent Extraction**: "Buy R50 airtime for 0821234567"
5. **Clarification**: "I want airtime" → AI: "How much and for which number?"

---

## 📊 **Success Criteria**

MVP Requirements:
- ✅ AI responds to unknown queries
- ✅ AI speaks user's language
- ✅ AI can trigger actions (airtime, data, vouchers)
- ✅ AI never refuses to help
- ⏳ Knowledge base (nice to have)
- ⏳ RAG implementation (post-MVP)

---

## 💡 **Why This Approach Works**

### **Without AI** (Traditional):
- Need 50+ templates for every variation
- 3-5 days approval per template
- No flexibility
- Language limited
- User frustration

### **With AI**:
- One integration
- Works immediately
- Handles any query
- All languages supported
- Great user experience

---

## 🎯 **Implementation Order**

**Day 1 Morning**:
1. ✅ Set up OpenAI account
2. ✅ Create AI package
3. ✅ Implement basic chat

**Day 1 Afternoon**:
1. ✅ Wire to message processor
2. ✅ Add intent extraction
3. ✅ Test end-to-end

**Day 2** (Optional):
1. ⏳ Create knowledge base
2. ⏳ Enhance prompts
3. ⏳ Test multi-language

**Day 3** (Post-MVP):
1. ⏳ Implement RAG
2. ⏳ Add conversation memory
3. ⏳ Performance optimization

---

## 🚀 **Ready to Start?**

**Minimal MVP** (4 hours):
1. Add OpenAI dependency
2. Create AI package
3. Wire to message processor
4. Test basic queries

**Full Implementation** (2-3 days):
- Add knowledge base
- Multi-language testing
- RAG integration

**Recommendation**: Start with minimal MVP today!

---

## 📝 **Environment Variables Checklist**

Add to Vercel:
```bash
OPENAI_API_KEY=sk-proj-...
```

That's it! The AI package will automatically use this key.

---

**Next**: Implement AI chat in message processor! 🤖

