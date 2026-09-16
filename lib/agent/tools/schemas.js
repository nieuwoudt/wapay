/**
 * Tool schemas for the pay agent (docs/AGENT_ARCHITECTURE_V2.md C10).
 *
 * Every definition is OpenAI STRICT-mode valid: `additionalProperties: false`,
 * EVERY property listed in `required`, optional values typed as a nullable
 * union (['string', 'null'] etc.). Descriptions are model-facing but follow
 * the customer copy rules anyway (no em dashes, never a betting word, never
 * the pay-out partner's name) so nothing here can leak into a reply.
 *
 * Three families:
 *   read tools      give facts (always offered);
 *   proposal tools  propose an action the deterministic flow will confirm
 *                   and execute after a PIN (offered only when the capability
 *                   is live for THIS customer, see lib/capabilities.js);
 *   reply           ends the turn (always offered).
 *
 * The text here is byte-stable across turns for the same registry state, so
 * the provider's prompt cache holds (contract 3).
 */
import { TOPICS } from '../../how-it-works.js';
import { MOVEMENT_KINDS } from '../../context-pack.js';

export const REPLY_TOOL_NAME = 'reply';
export const NOTE_TOOL_NAME = 'propose_note';

/** The actions a proposal tool can carry (the processor dispatches these). */
export const PROPOSAL_ACTIONS = Object.freeze([
  'BUY_AIRTIME', 'BUY_DATA', 'BUY_ELECTRICITY', 'SEND_VOUCHER', 'REQUEST_MONEY',
  'DEPOSIT_START', 'WITHDRAW', 'BUY_FUEL', 'REDEEM_VOUCHER', 'HOME', 'HELP',
]);

export const WITHDRAW_METHODS = Object.freeze(['PAYSHAP', 'RTC', 'CASHSEND', 'NEDCASH', 'EWALLET']);
export const PRODUCT_CATEGORIES = Object.freeze(['AIRTIME', 'DATA', 'ELECTRICITY']);
export const TRANSACTION_RANGES = Object.freeze(['today', 'week', 'month', 'all']);
export const FEE_KINDS = Object.freeze(['deposit', 'send', 'request', 'withdraw', 'voucher', 'ott', 'general']);
export const TOPIC_IDS = Object.freeze(Object.keys(TOPICS));

/** The slot keys every proposal carries (contract 1), all nullable. */
export const SLOT_KEYS = Object.freeze(['amountCents', 'msisdn', 'recipientName', 'self', 'meterNumber', 'productQuery', 'category', 'method']);

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** A strict object schema: every property required, nothing extra allowed. */
export function strictObject(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const nullable = (type, description, extra = {}) => ({ type: [type, 'null'], description, ...extra });
const cents = (description) => nullable('integer', `${description} In INTEGER CENTS (R50 is 5000). null when the customer did not say.`);
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

/** The slots object inside a pending intent (the reply tool), strict and fully nullable. */
export const SLOTS_SCHEMA = strictObject({
  amountCents: cents('Amount.'),
  msisdn: nullable('string', 'SA phone number as the customer gave it, digits only.'),
  recipientName: nullable('string', 'A saved person or a name the customer used.'),
  self: nullable('boolean', 'true when the customer means their own number.'),
  meterNumber: nullable('string', 'Electricity meter number, digits only.'),
  productQuery: nullable('string', 'Free-text product description, in English.'),
  category: nullable('string', 'AIRTIME, DATA or ELECTRICITY.'),
  method: nullable('string', 'Withdrawal method: PAYSHAP, RTC, CASHSEND, NEDCASH or EWALLET.'),
});

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const READ_TOOLS = Object.freeze([
  {
    name: 'get_transactions',
    description: 'The customer\'s own movements (deposits, pay-outs, purchases, sends, pay links, voucher loads) for a period, with totals summed server-side. Use this for "how much did I spend", "what did I buy", "show my transactions". Quote the totals as given; never add rows up yourself.',
    parameters: strictObject({
      range: str('Period, in South African time.', { enum: [...TRANSACTION_RANGES] }),
      kind: nullable('string', `Only this kind, or null for all. One of ${MOVEMENT_KINDS.join(', ')}.`),
    }),
  },
  {
    name: 'get_products',
    description: 'Search the live product catalogue for airtime, data bundles or prepaid electricity, with prices. Use it before answering "how much is 1GB" or "what bundles do you have".',
    parameters: strictObject({
      category: str('Product category.', { enum: [...PRODUCT_CATEGORIES] }),
      query: nullable('string', 'What the customer asked for, in English ("1GB weekly", "WhatsApp bundle"). null for the top products.'),
      network: nullable('string', 'Mobile network when known: Vodacom, MTN, Cell C or Telkom. null when not said.'),
    }),
  },
  {
    name: 'get_fee_quote',
    description: 'The exact WaPay fee for a kind of transaction, computed from the live fee table. Use it for "how much does it cost to deposit/send/withdraw", "is it free".',
    parameters: strictObject({
      kind: str('What the fee is for.', { enum: [...FEE_KINDS] }),
      amountCents: cents('The amount the customer named, to make the example exact.'),
    }),
  },
  {
    name: 'where_accepted',
    description: 'Whether a named shop or service takes an OTT voucher as payment, and where OTT vouchers work. Use it for "is it accepted at Checkers", "where can I spend my voucher".',
    parameters: strictObject({
      merchant: nullable('string', 'The shop or service the customer named, or null for the general list.'),
    }),
  },
  {
    name: 'get_payout_status',
    description: 'The status of the customer\'s newest withdrawal (or the one with the given reference), checked with the bank rail when it is still pending. Use it for "did my withdrawal go through", "where is my money".',
    parameters: strictObject({
      reference: nullable('string', 'The withdrawal reference the customer quoted, or null for the newest one.'),
    }),
  },
  {
    name: 'get_pay_links',
    description: 'The customer\'s open please-pay-me links and their recent paid, expired or cancelled ones.',
    parameters: strictObject({}),
  },
  {
    name: 'how_it_works',
    description: 'The steps, limits and rules for one WaPay capability, from the knowledge base. Use it for "how do I", "can I", "what happens when" questions.',
    parameters: strictObject({
      topic: str('The capability asked about.', { enum: [...TOPIC_IDS] }),
    }),
  },
]);

// ---------------------------------------------------------------------------
// Proposal tools: one per capability. `capabilityId` scopes the offer.
// ---------------------------------------------------------------------------

const msisdnArg = nullable('string', 'The SA phone number the customer gave, digits only, or null to ask.');
const selfArg = nullable('boolean', 'true when it is for the customer\'s own number, null when unclear.');

export const PROPOSAL_TOOLS = Object.freeze([
  {
    name: 'start_buy_airtime',
    action: 'BUY_AIRTIME',
    capabilityId: 'AIRTIME',
    description: 'Start buying airtime from the balance. The flow asks for whatever is missing, shows a preview and takes the PIN.',
    parameters: strictObject({ amountCents: cents('Airtime amount.'), msisdn: msisdnArg, self: selfArg }),
  },
  {
    name: 'start_buy_data',
    action: 'BUY_DATA',
    capabilityId: 'DATA',
    description: 'Start buying a data bundle from the balance. Give the bundle the customer described; the flow shows matching bundles and takes the PIN.',
    parameters: strictObject({
      productQuery: nullable('string', 'The bundle described in English ("1GB weekly", "MTN 500MB"), or null.'),
      amountCents: cents('Budget or bundle price if the customer named one.'),
      msisdn: msisdnArg,
      self: selfArg,
    }),
  },
  {
    name: 'start_buy_electricity',
    action: 'BUY_ELECTRICITY',
    capabilityId: 'ELECTRICITY',
    description: 'Start buying prepaid electricity from the balance. The flow asks for the meter and amount if missing, previews, and takes the PIN.',
    parameters: strictObject({ amountCents: cents('Electricity amount.'), meterNumber: nullable('string', 'Meter number, digits only, or null to ask.') }),
  },
  {
    name: 'start_send',
    action: 'SEND_VOUCHER',
    capabilityId: 'SEND',
    description: 'Start sending money to a person: a saved name, a number or the customer themself (an OTT voucher for their own use). The system picks the rail; the flow confirms and takes the PIN.',
    parameters: strictObject({
      amountCents: cents('Amount to send.'),
      msisdn: msisdnArg,
      recipientName: nullable('string', 'A saved person\'s name as the customer said it, or null.'),
      self: selfArg,
    }),
  },
  {
    name: 'start_pay_link',
    action: 'REQUEST_MONEY',
    capabilityId: 'REQUEST_MONEY',
    description: 'Start a please-pay-me link the customer can share to get paid.',
    parameters: strictObject({ amountCents: cents('Amount to request.') }),
  },
  {
    name: 'start_deposit',
    action: 'DEPOSIT_START',
    capabilityId: 'DEPOSIT_CARD',
    description: 'Start a card, Instant EFT, Apple Pay or Google Pay deposit with a secure payment link.',
    parameters: strictObject({ amountCents: cents('Amount to add.') }),
  },
  {
    name: 'start_withdraw',
    action: 'WITHDRAW',
    capabilityId: 'WITHDRAW',
    description: 'Start a withdrawal to the customer\'s own bank account or as cash at an ATM. The flow verifies identity when needed, asks for the method and details, previews the fee and takes the PIN.',
    parameters: strictObject({
      amountCents: cents('Amount to withdraw.'),
      method: nullable('string', `Method if the customer named one: ${WITHDRAW_METHODS.join(', ')}; null to ask.`),
    }),
  },
  {
    name: 'start_fuel',
    action: 'BUY_FUEL',
    capabilityId: 'FUEL',
    description: 'Start buying a fuel voucher from the balance for participating stations.',
    parameters: strictObject({ amountCents: cents('Fuel amount.') }),
  },
  {
    name: 'start_voucher_load',
    action: 'REDEEM_VOUCHER',
    capabilityId: 'DEPOSIT_VOUCHER',
    description: 'Start loading a cash voucher (Blu or OTT) into the balance. The flow asks the customer to type the voucher PIN itself; never pass a PIN here.',
    parameters: strictObject({}),
  },
  {
    name: 'show_home',
    action: 'HOME',
    capabilityId: null,
    description: 'Show the home screen with the balance and what the customer can do.',
    parameters: strictObject({}),
  },
  {
    name: 'show_help',
    action: 'HELP',
    capabilityId: null,
    description: 'Show the help menu with every command.',
    parameters: strictObject({}),
  },
]);

// ---------------------------------------------------------------------------
// Note and reply
// ---------------------------------------------------------------------------

export const NOTE_TOOL = Object.freeze({
  name: NOTE_TOOL_NAME,
  description: 'Remember one thing the customer stated about themself (a preference, a habit, who someone is). Plain words, no numbers, at most 120 characters. The customer confirms it once.',
  parameters: strictObject({ note: str('The note in the second person ("you usually buy airtime for your mum").') }),
});

export const REPLY_TOOL = Object.freeze({
  name: REPLY_TOOL_NAME,
  description: 'Send the final answer to the customer and end the turn. kind "reply" is a complete answer. kind "clarify" is ONE question plus the intent to start once it is answered (pendingIntent), for example the amount before a send.',
  parameters: strictObject({
    kind: str('reply or clarify.', { enum: ['reply', 'clarify'] }),
    text: str('The message, in the customer\'s language, short, no menu dumps.'),
    pendingIntent: {
      anyOf: [
        strictObject({
          action: str('The action to start once the question is answered.', { enum: [...PROPOSAL_ACTIONS] }),
          slots: SLOTS_SCHEMA,
        }),
        { type: 'null' },
      ],
      description: 'Only with kind "clarify": the intent this question completes. null otherwise.',
    },
  }),
});

/** An OpenAI function tool from one definition above. */
export function toolDefinition(def) {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      strict: true,
    },
  };
}

const READ_BY_NAME = new Map(READ_TOOLS.map((t) => [t.name, t]));
const PROPOSAL_BY_NAME = new Map(PROPOSAL_TOOLS.map((t) => [t.name, t]));

export function readToolByName(name) { return READ_BY_NAME.get(String(name || '')) || null; }
export function proposalToolByName(name) { return PROPOSAL_BY_NAME.get(String(name || '')) || null; }
