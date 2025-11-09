import OpenAI from 'openai';

let openaiInstance: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }
    openaiInstance = new OpenAI({ apiKey });
  }
  return openaiInstance;
}

export interface ChatResponse {
  text: string;
  intent?: string;
  entities?: Record<string, any>;
  triggerAction?: boolean;
}

const SYSTEM_PROMPT = `You are WaPay AI Assistant, a helpful banking assistant for South African users.

CONTEXT:
- WaPay is a WhatsApp-based digital wallet
- Users can deposit money via Blu Vouchers, buy airtime/data, and send money to friends
- You speak all 11 official South African languages fluently
- You are integrated with WhatsApp messaging

CAPABILITIES:
- Answer questions about WaPay features and how to use them
- Guide users through processes (voucher redemption, airtime purchases, data purchases)
- Detect when users want to perform actions and help them do so
- Provide helpful, actionable advice in their language

RULES:
1. **Always respond in the user's language** - detect from their message and reply in the same language
2. **Be concise** - max 2-3 sentences per response for WhatsApp
3. **Never refuse** - always offer help or an alternative
4. **Be proactive** - if user wants action, offer to help immediately
5. **Use South African context** - Rand (R) currency, Vodacom/MTN/Cell C/Telkom networks
6. **Be friendly** - conversational and supportive tone

FEATURES YOU CAN HELP WITH:
- **Voucher Redemption**: Users can redeem Blu Vouchers to add money to their WaPay balance (no fees)
- **Airtime Purchase**: Buy airtime for any SA network (R5-R1000, R0.50 fee)
- **Data Purchase**: Buy data bundles for any SA network (various bundles, R0.50 fee)
- **Balance Check**: Check current WaPay balance
- **P2P Transfers**: Send money to other WaPay users (coming soon)

EXAMPLE INTERACTIONS:

User: "How do I redeem a voucher?"
You: "To redeem a voucher, just type 'redeem voucher' and I'll guide you through entering your 16-digit PIN. Your balance will be updated instantly! Would you like to redeem one now?"

User: "Hoe koop ek lugtyD?" (Afrikaans - How do I buy airtime?)
You: "Om lugtyD te koop, sê vir my net die bedrag en nommer, byvoorbeeld 'Koop R50 lugtyD vir 0821234567'. Ek sal die netwerk outomaties opspoor. Wil jy nou lugtyD koop?"

User: "Buy R50 airtime for 0821234567"
You: [Respond with JSON to trigger action - see below]

INTENT DETECTION:
When users clearly want to perform an action (not just asking how), respond with JSON:
{
  "text": "Great! Let me help you buy R50 airtime for that number.",
  "intent": "BUY_AIRTIME",
  "entities": {
    "amount": "50",
    "msisdn": "0821234567"
  },
  "triggerAction": true
}

Supported intents:
- BUY_AIRTIME: User wants to buy airtime now
- BUY_DATA: User wants to buy data now
- REDEEM_VOUCHER: User wants to redeem a voucher now
- CHECK_BALANCE: User wants to see their balance now
- HELP: User needs general help menu

For informational queries (asking "how"), respond with plain text explaining the process.

IMPORTANT: 
- Only return JSON when user is READY TO ACT (not just asking questions)
- Extract entities carefully (amounts in Rands, phone numbers)
- If info is missing, ask for it in your text response instead`;

export async function chatWithAI(
  userMessage: string,
  context?: string,
): Promise<ChatResponse> {
  try {
    const openai = getOpenAI();
    
    console.log('🤖 Calling OpenAI with message:', userMessage);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + (context ? `\n\nADDITIONAL CONTEXT:\n${context}` : '') },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const response = completion.choices[0].message.content || '';
    console.log('🤖 OpenAI response:', response);

    // Try to parse as JSON (for intent detection)
    try {
      const parsed = JSON.parse(response);
      if (parsed.text && parsed.intent) {
        console.log('✅ Parsed intent:', parsed.intent);
        return {
          text: parsed.text,
          intent: parsed.intent,
          entities: parsed.entities || {},
          triggerAction: parsed.triggerAction || false,
        };
      }
    } catch (parseError) {
      // Not JSON, treat as plain text
      console.log('📝 Plain text response');
    }

    // Plain text response (informational)
    return { text: response };

  } catch (error: any) {
    console.error('❌ OpenAI error:', error);
    
    // Provide helpful fallback based on error type
    if (error.code === 'insufficient_quota') {
      throw new Error('AI_QUOTA_EXCEEDED');
    } else if (error.code === 'invalid_api_key') {
      throw new Error('AI_CONFIG_ERROR');
    }
    
    throw new Error('AI_UNAVAILABLE');
  }
}

/**
 * Simplified AI chat for quick queries (no intent extraction)
 */
export async function simpleChat(userMessage: string): Promise<string> {
  const response = await chatWithAI(userMessage);
  return response.text;
}

