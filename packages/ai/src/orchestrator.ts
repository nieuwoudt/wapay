/**
 * WaPay conversational orchestration engine.
 *
 * Two-tier design (founder-approved architecture, 2026-08-18):
 *   Tier 1 — ORCHESTRATOR (gpt-4o): detects language + domain, and may
 *            complete trivial intents directly (fast path: balance, help,
 *            deposit status, home) so common turns cost one model call.
 *   Tier 2 — CATEGORY AGENTS (gpt-4o-mini): per-domain slot extraction and
 *            reply composition, each with a focused prompt.
 *
 * Every model call uses OpenAI STRUCTURED OUTPUTS (json_schema, strict) at
 * temperature 0 — no bare JSON.parse of free-running text, ever. The engine
 * returns an ACTION + SLOTS + REPLY; it never executes anything itself.
 *
 * MONEY SAFETY INVARIANTS (do not weaken):
 *   - The engine only ever *proposes* an action. Execution stays in the
 *     message processor's deterministic, PIN-gated flows.
 *   - The engine never states balances, amounts received, or payment status
 *     from model knowledge — those are actions the processor answers from
 *     the ledger (the AI must never invent transaction status).
 *   - All slots (msisdn, amounts, meter numbers) are re-validated
 *     deterministically by the processor before any flow starts.
 *
 * Model tiers are env-tunable for the later Claude migration:
 *   WAPAY_ORCHESTRATOR_MODEL   (default gpt-4o)
 *   WAPAY_CATEGORY_AGENT_MODEL (default gpt-4o-mini)
 */

import OpenAI from 'openai';

let openaiInstance: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }
    // WhatsApp replies must land within Meta's webhook budget and Vercel's
    // 60s function cap. Two sequential tiers share that budget, so each call
    // gets 10s and NO retries — worst case 20s, then the deterministic
    // fallback copy takes over. (Retrying inside a webhook that Meta itself
    // retries on slow ACK would just double-spend the budget.)
    openaiInstance = new OpenAI({ apiKey, timeout: 10_000, maxRetries: 0 });
  }
  return openaiInstance;
}

const ORCHESTRATOR_MODEL = () => process.env.WAPAY_ORCHESTRATOR_MODEL || 'gpt-4o';
const CATEGORY_AGENT_MODEL = () => process.env.WAPAY_CATEGORY_AGENT_MODEL || 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Actions the engine may hand to the processor. 1:1 with deterministic handlers. */
export const ORCHESTRATOR_ACTIONS = [
  'CHECK_BALANCE',
  'DEPOSIT_START',
  'DEPOSIT_STATUS',
  'REDEEM_VOUCHER',
  'BUY_AIRTIME',
  'BUY_DATA',
  'BUY_ELECTRICITY',
  'SEND_VOUCHER',
  'LIST_PRODUCTS',
  'LIST_CATEGORY',
  'HELP',
  'HOME',
  'NONE',
] as const;
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];

export const ORCHESTRATOR_DOMAINS = [
  'MONEY',
  'AIRTIME',
  'DATA',
  'ELECTRICITY',
  'SEND',
  'DISCOVER',
  'CHAT',
] as const;
export type OrchestratorDomain = (typeof ORCHESTRATOR_DOMAINS)[number];

/** The 11 official South African languages + 'other'. */
export const SA_LANGUAGES = ['en', 'af', 'zu', 'xh', 'nso', 'st', 'tn', 'ss', 've', 'ts', 'nr', 'other'] as const;

export interface OrchestratorSlots {
  amountCents: number | null;
  msisdn: string | null;
  self: boolean;
  meterNumber: string | null;
  category: string | null;
  productQuery: string | null;
  recipientName: string | null;
}

export interface OrchestratorResult {
  action: OrchestratorAction;
  slots: OrchestratorSlots;
  reply: string;
  language: string;
  domain: OrchestratorDomain;
  /** Which tier produced the action: 1 = fast path, 2 = category agent. */
  tier: 1 | 2;
  models: { orchestrator: string; agent: string | null };
  timings: { orchestratorMs: number; agentMs: number | null };
}

const EMPTY_SLOTS: OrchestratorSlots = {
  amountCents: null,
  msisdn: null,
  self: false,
  meterNumber: null,
  category: null,
  productQuery: null,
  recipientName: null,
};

// ---------------------------------------------------------------------------
// Structured-output schemas (OpenAI strict mode: additionalProperties false,
// every property required, nullability via union types)
// ---------------------------------------------------------------------------

const ORCHESTRATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'domain', 'fastAction', 'note'],
  properties: {
    language: { type: 'string', enum: [...SA_LANGUAGES] },
    domain: { type: 'string', enum: [...ORCHESTRATOR_DOMAINS] },
    fastAction: {
      type: 'string',
      enum: ['CHECK_BALANCE', 'DEPOSIT_STATUS', 'HELP', 'HOME', 'NONE'],
      description: 'Complete trivially-clear intents without a category agent; NONE delegates.',
    },
    note: {
      type: 'string',
      description: 'One-line English restatement of what the user wants, for the category agent.',
    },
  },
} as const;

const AGENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'amountCents', 'msisdn', 'self', 'meterNumber', 'category', 'productQuery', 'recipientName', 'reply'],
  properties: {
    action: { type: 'string', enum: [...ORCHESTRATOR_ACTIONS] },
    amountCents: {
      type: ['integer', 'null'],
      description: 'Money amount in INTEGER CENTS (R50 -> 5000). null when absent.',
    },
    msisdn: {
      type: ['string', 'null'],
      description: 'Beneficiary phone number EXACTLY as the user gave it, digits only. null when absent.',
    },
    self: {
      type: 'boolean',
      description: 'true when the user means their own number ("for me", "my phone").',
    },
    meterNumber: { type: ['string', 'null'], description: 'Electricity meter number, digits only.' },
    category: {
      type: ['string', 'null'],
      enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'LIFESTYLE', 'BILLPAY', 'GAMING', null],
      description: 'Only for LIST_CATEGORY.',
    },
    productQuery: {
      type: ['string', 'null'],
      description: 'Free-text product description for search ("weekly TikTok data"). English.',
    },
    recipientName: {
      type: ['string', 'null'],
      description:
        'The recipient\'s NAME when the user names a person instead of a number ("send R50 to Philly"). Exactly as the user said it. null otherwise.',
    },
    reply: {
      type: 'string',
      description: "Short WhatsApp reply in the user's language. Empty string when the action's own flow will reply.",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Compact multilingual signal vocabulary. These are HINTS for the smaller
 * agent model — the models' own multilingual competence does the heavy
 * lifting, and every slot is re-validated deterministically afterwards.
 */
const LANGUAGE_HINTS = `LANGUAGE SIGNALS (hints, not exhaustive; users mix languages and typo freely):
- Afrikaans (af): krag/elektrisiteit=electricity, lugtyd=airtime, saldo/balans=balance, stuur=send, koop=buy, geld=money, laai=load
- isiZulu (zu): ugesi=electricity, imali=money, thumela=send, thenga=buy, ibhalansi=balance, idatha=data, umoya/i-airtime=airtime
- isiXhosa (xh): umbane=electricity, imali=money, thumela=send, thenga=buy, ibhalansi=balance, idatha=data
- Sepedi (nso): mohlagase=electricity, tšhelete/chelete=money, romela=send, reka=buy
- Sesotho (st): motlakase=electricity, chelete=money, romela=send, reka=buy
- Setswana (tn): motlakase=electricity, madi=money, romela=send, reka=buy
- siSwati (ss): gezi=electricity, imali=money, tfumela=send, tsenga=buy
- Tshivenda (ve): mudagasi=electricity, tshelede=money, rumela=send, renga=buy
- Xitsonga (ts): gezi=electricity, mali=money, rhumela=send, xava=buy
- isiNdebele (nr): close to isiZulu (ugezi/umbani=electricity, imali=money)
Typos are the NORM ("balence", "eirtime", "depsit", "electrisity") — resolve them by meaning.`;

const PRODUCT_TRUTH = `WAPAY TODAY (never claim more, never deny these):
- Add money, two ways: (1) CASH — take cash to the till at any major retailer and ask for a Blu Voucher for the amount you want to deposit; the cashier gives a voucher code; send that code to WaPay and the money loads automatically; (2) CARD / BANK — "deposit R100" (R10–R3000) gets a secure PayFast link accepting cards, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan and Zapper.
- Buy for yourself or ANY number: airtime (R5–R1000), data bundles, prepaid electricity (R10–R5000, needs meter number).
- Send money: "send R50 to 083…", a saved name ("send R50 to Philly"), or share a contact card — the recipient gets a WaPay voucher (R10–R1000, flat R3 fee).
- Getting money OUT (withdrawals): NOT available — WaPay balances and WaPay vouchers are SPEND-ONLY. A WaPay voucher can be spent online at any platform that accepts OTT vouchers as payment; it CANNOT be exchanged for cash or paid into a bank account. NEVER claim cash-out, bank withdrawal, or "take it to your bank" — if asked, say withdrawals aren't available and list what the money CAN do (airtime, data, electricity, online spend, sending to others).
- Check balance; redeem vouchers. NO betting top-ups yet, NO Netflix/DStv yet ("coming soon" is the honest answer for those).`;

const MONEY_TRUTH_RULES = `MONEY TRUTH RULES (absolute):
- NEVER state a balance, amount received, or payment status yourself — you do not know them. Return the matching action (CHECK_BALANCE / DEPOSIT_STATUS) and the system answers from the ledger.
- NEVER promise "your balance will update shortly" or invent transaction outcomes.
- NEVER include a number you were not given in this conversation.
- Purchases and sends are executed by deterministic, PIN-protected flows — your job ends at proposing the action with its slots.`;

const ORCHESTRATOR_PROMPT = `You are the routing brain of WaPay, a WhatsApp wallet for South Africa. Classify ONE user message.

${LANGUAGE_HINTS}

DOMAINS:
- MONEY: balance, deposits (making one, or asking whether one arrived), redeeming a Blu voucher PIN
- AIRTIME: buying/sending airtime
- DATA: buying/sending data bundles
- ELECTRICITY: prepaid electricity, meters, tokens
- SEND: sending MONEY (not a named product) to another person/number — "send R50 to 083…", "pay my sister" — AND buying an OTT voucher for yourself ("buy an OTT voucher", "ott voucher R50")
- DISCOVER: what can I buy, product/price browsing, searching for a specific product
- CHAT: greetings, thanks, help, questions about WaPay, anything else

FAST PATH — set fastAction ONLY when the whole intent is one of these and unmistakable:
- CHECK_BALANCE: any balance question ("balance", "balence", "how much money do I have", "imali yami")
- DEPOSIT_STATUS: asking whether money they PAID IN has arrived ("did my payment go through", "where is my money")
- HELP: asking what WaPay can do / how it works — but NOT withdrawal/cash-out questions ("how do I withdraw", "get cash out", "money to my bank"): those are MONEY domain with fastAction NONE, so the specialist can explain honestly that balances are spend-only.
- HOME: asking for the menu / home / start
Otherwise fastAction = NONE and the domain's specialist continues.

Distinguish carefully:
- "deposit R100" = MAKING a deposit -> MONEY domain, fastAction NONE.
- "did my deposit arrive?" = status question -> fastAction DEPOSIT_STATUS.
- "send R50 airtime to 083…" names a product -> AIRTIME (not SEND).
- "send R50 to 083…" names no product -> SEND.

${MONEY_TRUTH_RULES}`;

function agentPrompt(domain: OrchestratorDomain): string {
  const shared = `You are WaPay's ${domain} specialist. WaPay is a WhatsApp wallet for South Africa; users write in any of the 11 official languages, with heavy typos. You receive the user's message (plus recent conversation) and MUST return the structured action + slots + a short reply in the USER'S language.

${LANGUAGE_HINTS}

${PRODUCT_TRUTH}

${MONEY_TRUTH_RULES}

SLOT RULES:
- amountCents: INTEGER CENTS. "R50" -> 5000. "50" in a money context -> 5000. null when the user gave no amount.
- msisdn: the OTHER party's / beneficiary number exactly as typed, digits only (e.g. 0831234567). null when none. NEVER invent or complete a partial number.
- recipientName: when the user names a PERSON instead of a number ("send R50 to Philly", "pay my sister Thandi"), put the name here exactly as said and leave msisdn null — the system looks the name up in the user's saved recipients. NEVER turn a name into a number yourself.
- self: true when the user means their own phone ("for me", "my number", "buy myself").
- reply: 1–3 short sentences, user's language, warm but precise. When your action starts a flow that itself replies (a preview, a menu, a prompt), return reply as "" — the flow speaks.
- When a REQUIRED slot is missing, still return the action with the slot null — the flow asks for it. Do not interrogate in the reply.`;

  const perDomain: Record<OrchestratorDomain, string> = {
    MONEY: `YOUR ACTIONS:
- DEPOSIT_START: user wants to ADD money by card/EFT ("deposit R100", "laai R50", "put money in"). amountCents null when unspecified.
- REDEEM_VOUCHER: user has a Blu voucher / voucher PIN to load — INCLUDING "I bought a voucher, how do I load it": when they already have one, start the flow (it explains itself) instead of describing steps.
- DEPOSIT_STATUS: user asks whether money they paid in has arrived.
- CHECK_BALANCE: balance questions.
- NONE with a reply: money questions you can answer from WAPAY TODAY (fees, limits, how deposits work, and the honest withdrawals answer: spend-only, no cash-out).`,
    AIRTIME: `YOUR ACTIONS:
- BUY_AIRTIME: buying airtime for self (self=true) or another number (msisdn set). Gifting airtime IS BUY_AIRTIME with the recipient's msisdn.
- LIST_CATEGORY with category AIRTIME: browsing options without an amount.
- NONE with a reply: airtime questions.`,
    DATA: `YOUR ACTIONS:
- BUY_DATA: buying data. productQuery carries what they asked for ("1GB weekly", "TikTok bundle"). msisdn/self as for airtime.
- LIST_CATEGORY with category DATA: browsing bundles.
- NONE with a reply: data questions.`,
    ELECTRICITY: `YOUR ACTIONS:
- BUY_ELECTRICITY: prepaid electricity. meterNumber when given (digits only, typically 11–13 digits). amountCents when given.
- NONE with a reply: electricity questions (how tokens arrive, which municipalities work).`,
    SEND: `YOUR ACTIONS:
- SEND_VOUCHER: sending MONEY to a person/number ("send R50 to 083…", "romela R100", "pay my sister 084…"). msisdn = recipient; a named person with no number goes in recipientName ("send R50 to Philly"). BUYING AN OTT VOUCHER FOR YOURSELF ("buy an OTT voucher", "can I get an ott voucher R50") is also SEND_VOUCHER with self=true and no msisdn — the PIN is delivered in this chat, paid from the WaPay balance. NEVER treat any of this as a bank transfer — WaPay sells a voucher the recipient can spend online where OTT vouchers are accepted (no cash-out); your reply may say exactly that.
- BUY_AIRTIME / BUY_DATA: when the user actually names airtime/data as the thing to send.
- NONE with a reply: questions about sending money (fee R3, limits R10–R1000, how the recipient gets it).`,
    DISCOVER: `YOUR ACTIONS:
- LIST_PRODUCTS: "what can I buy", general browsing.
- SEND_VOUCHER with self=true: any OTT-voucher purchase ask ("can I buy an OTT voucher?") — OTT vouchers are WaPay's money voucher, NOT an entertainment product; never map them to LIFESTYLE.
- LIST_CATEGORY: a specific category (AIRTIME/DATA/ELECTRICITY; LIFESTYLE/BILLPAY/GAMING exist but are coming soon — say so in reply and still return the action).
- BUY_DATA with productQuery: a specific product search ("cheapest weekly TikTok data").
- NONE with a reply: price/product questions you can answer from WAPAY TODAY.`,
    CHAT: `YOUR ACTIONS:
- HELP: user asks what WaPay can do.
- HOME: user wants the menu.
- CHECK_BALANCE / DEPOSIT_STATUS: when the smalltalk actually hides one of these.
- NONE with a reply: greetings, thanks, questions. Reply naturally, 1–2 sentences, user's language. For capability questions stick to WAPAY TODAY.`,
  };

  return `${shared}\n\n${perDomain[domain]}`;
}

// ---------------------------------------------------------------------------
// Structured call helper
// ---------------------------------------------------------------------------

async function callStructured<T>(args: {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<T> {
  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: args.model,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
    max_tokens: args.maxTokens,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: { name: args.schemaName, strict: true, schema: args.schema as any },
    },
  });

  const choice = completion.choices[0];
  if (choice.message.refusal) {
    throw new Error(`AI_REFUSAL: ${choice.message.refusal}`);
  }
  const content = choice.message.content;
  if (!content) {
    throw new Error('AI_EMPTY_RESPONSE');
  }
  // strict json_schema guarantees shape; parse failures here are provider bugs.
  return JSON.parse(content) as T;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface OrchestratorTierOutput {
  language: (typeof SA_LANGUAGES)[number];
  domain: OrchestratorDomain;
  fastAction: 'CHECK_BALANCE' | 'DEPOSIT_STATUS' | 'HELP' | 'HOME' | 'NONE';
  note: string;
}

interface AgentTierOutput {
  action: OrchestratorAction;
  amountCents: number | null;
  msisdn: string | null;
  self: boolean;
  meterNumber: string | null;
  category: string | null;
  productQuery: string | null;
  recipientName: string | null;
  reply: string;
}

function buildUserContent(text: string, context?: string): string {
  return context ? `${context}\n\nUSER MESSAGE:\n${text}` : `USER MESSAGE:\n${text}`;
}

/**
 * Run one user message through the two-tier engine.
 *
 * @param text    the raw WhatsApp message
 * @param context optional recent-conversation block (plain text)
 * @throws AI_UNAVAILABLE / AI_QUOTA_EXCEEDED / AI_CONFIG_ERROR — the names
 *         the processor's fallback copy expects.
 */
export async function orchestrate(text: string, context?: string): Promise<OrchestratorResult> {
  const userContent = buildUserContent(text, context);
  const orchestratorModel = ORCHESTRATOR_MODEL();
  const agentModel = CATEGORY_AGENT_MODEL();

  let tier1: OrchestratorTierOutput;
  const t0 = Date.now();
  try {
    tier1 = await callStructured<OrchestratorTierOutput>({
      model: orchestratorModel,
      system: ORCHESTRATOR_PROMPT,
      user: userContent,
      schemaName: 'wapay_route',
      schema: ORCHESTRATOR_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 200,
    });
  } catch (error) {
    throw normalizeAiError(error);
  }
  const orchestratorMs = Date.now() - t0;

  if (tier1.fastAction !== 'NONE') {
    return {
      action: tier1.fastAction,
      slots: { ...EMPTY_SLOTS },
      reply: '',
      language: tier1.language,
      domain: tier1.domain,
      tier: 1,
      models: { orchestrator: orchestratorModel, agent: null },
      timings: { orchestratorMs, agentMs: null },
    };
  }

  let tier2: AgentTierOutput;
  const t1 = Date.now();
  try {
    tier2 = await callStructured<AgentTierOutput>({
      model: agentModel,
      system: agentPrompt(tier1.domain),
      user: `${userContent}\n\nROUTING NOTE (from the orchestrator): ${tier1.note}\nDETECTED LANGUAGE: ${tier1.language}`,
      schemaName: 'wapay_action',
      schema: AGENT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 350,
    });
  } catch (error) {
    throw normalizeAiError(error);
  }
  const agentMs = Date.now() - t1;

  return {
    action: tier2.action,
    slots: {
      amountCents: Number.isInteger(tier2.amountCents) && (tier2.amountCents as number) > 0 ? tier2.amountCents : null,
      msisdn: tier2.msisdn || null,
      self: Boolean(tier2.self),
      meterNumber: tier2.meterNumber || null,
      category: tier2.category || null,
      productQuery: tier2.productQuery || null,
      recipientName: tier2.recipientName || null,
    },
    reply: tier2.reply || '',
    language: tier1.language,
    domain: tier1.domain,
    tier: 2,
    models: { orchestrator: orchestratorModel, agent: agentModel },
    timings: { orchestratorMs, agentMs },
  };
}

/**
 * Map provider errors onto the error names the processor already handles —
 * and log the underlying cause first, or live AI incidents become
 * undiagnosable (the processor only ever sees the normalized name).
 */
function normalizeAiError(error: any): Error {
  console.error(
    JSON.stringify({
      type: 'orchestrator_provider_error',
      code: error?.code ?? null,
      status: error?.status ?? null,
      message: error?.message?.slice(0, 300) ?? String(error).slice(0, 300),
    })
  );
  if (error?.code === 'insufficient_quota') return new Error('AI_QUOTA_EXCEEDED');
  if (error?.code === 'invalid_api_key') return new Error('AI_CONFIG_ERROR');
  if (error instanceof Error && /^AI_/.test(error.message)) return error;
  return new Error('AI_UNAVAILABLE');
}
