/**
 * The model boundary (BUGLOG #111; founder 2026-10-16: "you can never leave
 * personal information to the AI, ever"). Every request this codebase sends
 * to a model provider passes through here, in the package that owns the
 * model clients, so no caller can skip it (tests/model-boundary.test.mjs
 * fails the build when a model call appears anywhere else):
 *
 *   SECRETS are never sent and never tokenised: an SA ID or passport number,
 *   a bank account number, a PIN, a voucher PIN or token, any other run of
 *   7 or more digits. A chat call that carries one is REFUSED with
 *   AI_PRIVACY_BLOCK (ModelBoundaryError); the caller answers from its
 *   deterministic fallback and logs the refusal. Refusing, not redacting,
 *   is the point: a model that sees "[hidden]" still improvises the next
 *   step (Lisa, 2026-10-15: her ID went to the AI after her withdrawal timed
 *   out and it replied "Now enter your WaPay PIN to confirm the payout").
 *
 *   PERSONAL DATA the model needs to work with is swapped for tokens before
 *   the call and swapped back in what comes out (slots, tool arguments, the
 *   reply): phone numbers [[P1]], e-mail addresses [[E1]], and the names we
 *   know [[N1]] (the customer's own, the account holder typed in a flow,
 *   saved people). The model handles "send R50 to [[P1]]" without ever
 *   seeing the number.
 *
 *   TRANSLATION of our own deterministic copy (lib/localize.js) tokenises
 *   secrets too, because the text is ours, the output is restored before it
 *   is sent, and refusing would only cost the customer their language.
 *
 * Names come from the caller (opts.names) and from the request's privacy
 * scope: the message processor opens one per inbound message
 * (runWithPrivacy) and adds every name it learns (addPrivacyNames).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export class ModelBoundaryError extends Error {
  readonly code = 'AI_PRIVACY_BLOCK';
  readonly kinds: string[];
  constructor(kinds: string[]) {
    super('AI_PRIVACY_BLOCK');
    this.name = 'ModelBoundaryError';
    this.kinds = kinds;
  }
}

// --- The request's privacy scope --------------------------------------------

interface PrivacyScope { names: Set<string>; refusals: string[] }
const scope = new AsyncLocalStorage<PrivacyScope>();

/**
 * Run fn with a privacy scope (one per inbound message). Inside an active
 * scope (the processor re-entering itself for an escape) the same scope is
 * kept and the names are added to it.
 */
export function runWithPrivacy<T>(names: Array<string | null | undefined>, fn: () => T): T {
  const active = scope.getStore();
  if (active) { for (const n of names || []) addName(active, n); return fn(); }
  const s: PrivacyScope = { names: new Set(), refusals: [] };
  for (const n of names || []) addName(s, n);
  return scope.run(s, fn);
}

/** Names learned during the request (a flow's account holder, the pack's saved people). No-op outside a scope. */
export function addPrivacyNames(names: Iterable<string | null | undefined> | null | undefined): void {
  const s = scope.getStore();
  if (!s || !names) return;
  for (const n of names) addName(s, n);
}

/** The scope's names (tests and diagnostics). */
export function privacyScopeNames(): string[] {
  return [...(scope.getStore()?.names || [])];
}

// Words that are also everyday WaPay words or common English: never treated
// as a name on their own (a customer called Gift must not turn "gift" into a token).
const NAME_STOPLIST = new Set([
  'gift', 'gifts', 'precious', 'blessing', 'patience', 'mercy', 'faith', 'hope', 'joy', 'prince', 'given', 'lucky', 'happy',
  'smart', 'grace', 'love', 'honest', 'innocent', 'justice', 'beauty', 'success', 'trust', 'wisdom', 'mom', 'mum', 'mama',
  'dad', 'papa', 'baby', 'sister', 'brother', 'friend', 'customer', 'wapay', 'cash', 'money', 'pay', 'send', 'data',
  'airtime', 'voucher', 'balance', 'bank', 'account', 'name', 'saved', 'none', 'unknown', 'the', 'and',
  // Words of our own prompts and everyday chat: a WhatsApp profile called "User" or "Hello"
  // must not turn every "user" in the instructions into a token.
  'user', 'users', 'message', 'messages', 'reply', 'customer', 'customers', 'hello', 'hi', 'hey', 'thanks', 'thank',
  'you', 'your', 'yours', 'me', 'my', 'mine', 'our', 'we', 'they', 'them', 'him', 'her', 'his', 'hers', 'its', 'this',
  'that', 'what', 'when', 'where', 'who', 'why', 'how', 'yes', 'no', 'ok', 'okay', 'please', 'help', 'home', 'menu',
  'wallet', 'test', 'admin', 'team', 'support', 'agent', 'bot', 'system', 'record', 'pending', 'payout', 'withdraw',
  'deposit', 'fee', 'fees', 'rand', 'cents', 'today', 'new', 'all', 'any', 'for', 'with', 'from', 'not', 'just', 'now',
  'good', 'morning', 'afternoon', 'evening', 'night', 'god', 'lord', 'king', 'queen', 'boss', 'big', 'small', 'one',
  'two', 'three', 'south', 'africa', 'african', 'mobile', 'phone', 'cell', 'whatsapp', 'business', 'shop', 'store',
]);

function addName(s: PrivacyScope, raw: string | null | undefined): void {
  const full = String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (full.length < 2 || full.length > 80 || /\d/.test(full)) return;
  if (!/^[\p{L}][\p{L}' .-]*$/u.test(full)) return;
  if (!NAME_STOPLIST.has(full.toLowerCase())) s.names.add(full);
  for (const part of full.split(/[ .-]+/)) {
    if (part.length >= 3 && !NAME_STOPLIST.has(part.toLowerCase())) s.names.add(part);
  }
}

function namesFor(extra: Array<string | null | undefined> = []): string[] {
  const s: PrivacyScope = { names: new Set(scope.getStore()?.names || []), refusals: [] };
  for (const n of extra) addName(s, n);
  // Longest first, so "Ruth Mahlangu" is one token before "Ruth" is another.
  return [...s.names].sort((a, b) => b.length - a.length);
}

// --- Detection ---------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// SA numbers as people type them: 082 123 4567, 0821234567, +27 82 123 4567, 27821234567.
const PHONE_RE = /(?<![\p{L}\p{N}])(?:\+?27[\s-]?|0)[1-8]\d(?:[\s-]?\d){7}(?![\p{L}\p{N}])/gu;
// 7+ digits, separators allowed, not inside a word (a reference like WPC92BDD9664297F is not a secret).
const LONG_DIGITS_RE = /(?<![\p{L}\p{N}])\d(?:[\s-]?\d){6,}(?![\p{L}\p{N}])/gu;
// A passport or foreign ID: 6 to 12 letters and digits, at least one letter and four digits.
const ID_TOKEN_RE = /(?<![\p{L}\p{N}])(?=[A-Za-z0-9]*[A-Za-z])(?=(?:[A-Za-z]*\d){4})[A-Za-z0-9]{6,12}(?![\p{L}\p{N}])/gu;
// A PIN or code named as one: "my pin is 2580", "password 4821", "OTP: 9012".
const NAMED_PIN_RE = /\b(?:pin|pins|password|passcode|pass code|otp|one[- ]time (?:pin|code))\b[^\d\n]{0,15}\d{4,8}(?!\d)/gi;
// A message that is nothing but a PIN.
const BARE_PIN_RE = /^\s*\d{4,6}\s*$/;
// Our own tokens survive every pass untouched.
const TOKEN_RE = /\[\[[PENS]\d+\]\]/g;
// Rand amounts are not secrets ("R1 500 000" has 7 digits); thousands groups only, so
// "R50 1234567890" still shows the account number after the amount.
const AMOUNT_RE = /\bR\s?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:[.,]\d{1,2})?(?!\d)/g;
// Dates are not secrets: 2026-10-15, 15/10/2026, 15.10.2026.
const DATE_RE = /(?<!\d)(?:(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d{2})(?!\d)/g;
// Bundle and unit names are not ID documents: 1000MB, 1500MIN, 2000KWH.
const UNIT_TOKEN_RE = /^\d+(?:MB|GB|KB|TB|MIN|MINS|SMS|KWH|KW|HR|HRS|DAY|DAYS|ML|KG|GIG|GIGS|MEG|MEGS)$/i;

function isDate(m: string): boolean {
  DATE_RE.lastIndex = 0;
  const hit = DATE_RE.exec(m);
  DATE_RE.lastIndex = 0;
  return !!hit && hit[0] === m;
}

function maskTokens(text: string): string {
  return text.replace(TOKEN_RE, ' ');
}

/**
 * The secrets in a text, by kind ([] = none). Phones are personal data, not
 * secrets, and are removed before the digit rule runs. Pure.
 */
export function findSecrets(text: string, { current = false }: { current?: boolean } = {}): string[] {
  const t = maskTokens(String(text || ''));
  const kinds = new Set<string>();
  if (current && BARE_PIN_RE.test(t)) kinds.add('PIN');
  NAMED_PIN_RE.lastIndex = 0;
  if (NAMED_PIN_RE.test(t)) kinds.add('PIN');
  const noPhones = t.replace(EMAIL_RE, ' ').replace(PHONE_RE, ' ').replace(DATE_RE, ' ').replace(AMOUNT_RE, ' ');
  if ((noPhones.match(LONG_DIGITS_RE) || []).length) kinds.add('NUMBER');
  if ((noPhones.match(ID_TOKEN_RE) || []).some((m) => !UNIT_TOKEN_RE.test(m))) kinds.add('ID_DOCUMENT');
  return [...kinds];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- The vault: tokens for one model call -----------------------------------

export interface PrivacyVault {
  tokens: Map<string, string>;   // token -> value
  byValue: Map<string, string>;  // kind:value -> token
  counts: Record<'P' | 'E' | 'N' | 'S', number>;
}

export function newVault(): PrivacyVault {
  return { tokens: new Map(), byValue: new Map(), counts: { P: 0, E: 0, N: 0, S: 0 } };
}

function tokenFor(vault: PrivacyVault, kind: 'P' | 'E' | 'N' | 'S', value: string): string {
  const key = `${kind}:${kind === 'N' ? value.toLowerCase() : value.replace(/[\s-]/g, '')}`;
  const hit = vault.byValue.get(key);
  if (hit) return hit;
  vault.counts[kind] += 1;
  const token = `[[${kind}${vault.counts[kind]}]]`;
  vault.tokens.set(token, value);
  vault.byValue.set(key, token);
  return token;
}

/**
 * Swap personal data for tokens. mode 'chat' (the customer's current line)
 * leaves secrets in place for the refusal check; mode 'all' (our own text:
 * the record, history, tool results, copy to translate) tokenises them as
 * well. Pure apart from the vault it fills.
 */
export function tokenize(text: string, vault: PrivacyVault, { names = [], mode = 'chat' }: { names?: string[]; mode?: 'chat' | 'all' | 'translate' } = {}): string {
  let s = String(text ?? '');
  if (!s) return s;
  s = s.replace(EMAIL_RE, (m) => tokenFor(vault, 'E', m));
  s = s.replace(PHONE_RE, (m) => tokenFor(vault, 'P', m));
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'giu');
    s = s.replace(re, (m) => tokenFor(vault, 'N', m));
  }
  if (mode === 'all' || mode === 'translate') {
    s = s.replace(NAMED_PIN_RE, (m) => m.replace(/\d{4,8}$/, (d) => tokenFor(vault, 'S', d)));
    s = s.replace(LONG_DIGITS_RE, (m) => (isDate(m) ? m : tokenFor(vault, 'S', m)));
    s = s.replace(ID_TOKEN_RE, (m) => (UNIT_TOKEN_RE.test(m) ? m : tokenFor(vault, 'S', m)));
  }
  return s;
}

/** Put the values back. Unknown tokens are left as they are. Pure. */
export function restore(text: string, vault: PrivacyVault): string {
  if (!text || !vault.tokens.size) return text;
  return String(text).replace(TOKEN_RE, (t) => vault.tokens.get(t) ?? t);
}

/** restore() through every string in a JSON-shaped value (slots, tool arguments). */
export function restoreDeep<T>(value: T, vault: PrivacyVault): T {
  if (!vault.tokens.size || value == null) return value;
  if (typeof value === 'string') return restore(value, vault) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = restoreDeep(v, vault);
    return out as T;
  }
  return value;
}

// A field that holds a PERSON's name in a tool result: its whole value is a name token.
// A plain "name" is a product or a merchant ("MTN 1GB 30 days", a till), never hidden;
// saved people reach the boundary as known names instead (lib/privacy-names.js).
const NAME_KEY_RE = /^(?:counterparty|recipientName|senderName|fullName|displayName|nickname|holder|accountHolder|beneficiaryName|payerName|requesterName|personName)$/;

/** Tokenise through every string in a JSON-shaped value (a tool result on its way to the model). */
export function tokenizeDeep<T>(value: T, vault: PrivacyVault, opts: { names?: string[] } = {}): T {
  if (value == null) return value;
  if (typeof value === 'string') return tokenize(value, vault, { ...opts, mode: 'all' }) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => tokenizeDeep(v, vault, opts)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = NAME_KEY_RE.test(k) && typeof v === 'string' && /\p{L}/u.test(v) && !/^[A-Z_]+$/.test(v)
        ? tokenFor(vault, 'N', v.trim())
        : tokenizeDeep(v, vault, opts);
    }
    return out as T;
  }
  return value;
}

// --- The one door ------------------------------------------------------------

export interface GuardedMessages<M> { messages: M[]; vault: PrivacyVault; names: string[] }

/**
 * Prepare chat messages for a model call. The customer's current message
 * (`currentIndex`) is tokenised for names, phones and e-mails, and REFUSED
 * if it carries a secret (a bare PIN counts there). Every other message is
 * our own text (the record, history, tool results): its secrets, such as a
 * payment reference, become tokens too. Then the belt-and-braces check: any
 * secret, name, phone or e-mail still present refuses the call.
 * Throws ModelBoundaryError; the caller degrades to its fallback.
 */
export function guardChatMessages<M extends { role: string; content?: unknown }>(
  messages: M[],
  { names = [], currentIndex = -1, vault = newVault() }: { names?: Array<string | null | undefined>; currentIndex?: number; vault?: PrivacyVault } = {}
): GuardedMessages<M> {
  const all = namesFor(names);
  const out = messages.map((m, i) => {
    if (typeof m.content !== 'string') return m;
    const content = tokenize(m.content, vault, { names: all, mode: i === currentIndex ? 'chat' : 'all' });
    const kinds = findSecrets(content, { current: i === currentIndex });
    if (kinds.length) throw refuse(kinds);
    return { ...m, content };
  });
  assertNoPersonalData(out.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'), all);
  return { messages: out, vault, names: all };
}

/** Refuse when a name, phone, e-mail or secret is still present. Pure apart from the scope's refusal log. */
export function assertNoPersonalData(text: string, names: string[] = []): void {
  const t = maskTokens(String(text || ''));
  const left: string[] = [];
  EMAIL_RE.lastIndex = 0; PHONE_RE.lastIndex = 0;
  if (EMAIL_RE.test(t)) left.push('EMAIL');
  if (PHONE_RE.test(t)) left.push('PHONE');
  EMAIL_RE.lastIndex = 0; PHONE_RE.lastIndex = 0;
  for (const n of names) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'iu').test(t)) { left.push('NAME'); break; }
  }
  if (left.length) throw refuse(left);
}

function refuse(kinds: string[]): ModelBoundaryError {
  scope.getStore()?.refusals.push(...kinds);
  // Kinds only, never the value: the log must not become the leak.
  console.error(JSON.stringify({ type: 'model_boundary_refused', kinds }));
  return new ModelBoundaryError(kinds);
}

/** What the current scope refused this request (agent_turns rows record it). */
export function privacyRefusals(): string[] {
  return [...(scope.getStore()?.refusals || [])];
}

/**
 * Prepare one of our own texts for translation: everything personal and
 * every secret becomes a token. Returns null when anything survives (the
 * caller then sends the original, untranslated).
 */
export function guardTranslation(text: string, { names = [] }: { names?: Array<string | null | undefined> } = {}): { text: string; vault: PrivacyVault } | null {
  const vault = newVault();
  const all = namesFor(names);
  const out = tokenize(text, vault, { names: all, mode: 'all' });
  if (findSecrets(out).length) return null;
  try { assertNoPersonalData(out, all); } catch { return null; }
  return { text: out, vault };
}

/** Embedding input: names and phones tokenised; a secret means no embedding (null). */
export function guardEmbeddingInput(text: string): string | null {
  const vault = newVault();
  const all = namesFor([]);
  const out = tokenize(text, vault, { names: all });
  if (findSecrets(out).length) return null;
  try { assertNoPersonalData(out, all); } catch { return null; }
  return out;
}

/**
 * The last check inside the embeddings client: every text in the batch is
 * tokenised as our own text (a product code becomes a token, never a
 * refusal) and must carry no name, phone or e-mail afterwards.
 */
export function guardEmbeddingBatch(texts: string[]): string[] {
  const vault = newVault();
  const all = namesFor([]);
  const out = (texts || []).map((t) => tokenize(String(t ?? ''), vault, { names: all, mode: 'all' }));
  for (const t of out) { const kinds = findSecrets(t); if (kinds.length) throw refuse(kinds); }
  assertNoPersonalData(out.join('\n'), all);
  return out;
}
