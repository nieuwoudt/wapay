/**
 * The model review of the daily conversation audit (docs/audits/
 * DAILY_AUDIT.md): the accounts of the export rendered as transcripts, cut
 * into chunks of about 25 accounts or 60,000 characters, each sent once to
 * the reviewer with the brief as the system text, the answer parsed
 * tolerantly into findings of the same shape the rules produce.
 *
 * Privacy (docs/GOLDEN_THREAD.md section 1): the transcript is the redacted
 * memory, account ids only; the names the export knows are handed to the
 * model boundary as `names`, so the model reads [[N1]], never a name; the
 * call is made through packages/ai (callStructuredOnce, the one door), with
 * the tokens left in the answer, so nothing stored carries a name. Without
 * OPENAI_API_KEY there is no model: the run is deterministic only and says
 * so (reviewed:false).
 *
 * `model` is injectable: ({ system, user, names, timeoutMs }) -> object or
 * JSON string. Tests pass a stub; production passes defaultReviewModel().
 */
import { CATEGORIES, SEVERITIES, QUOTE_CHARS } from './rules.js';

export const CHUNK_ACCOUNTS = 25;
export const CHUNK_CHARS = 60000;
export const MIN_CALL_MS = 5000;
export const MAX_CALL_MS = 45000;
export const DEFAULT_CONCURRENCY = 4;
// The reviewer reads whole chunks inside a serverless budget: the fast tier by default
// (the category-agent model), the stronger one by WAPAY_AUDIT_REVIEW_MODEL.
export const DEFAULT_REVIEW_MODEL = 'gpt-5.4-mini';

export function reviewConcurrency(env = process.env) {
  const n = Number(env.WAPAY_AUDIT_REVIEW_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.round(n)) : DEFAULT_CONCURRENCY;
}
export const TITLE_CHARS = 160;
export const TEXT_CHARS = 400;

/** The strict output schema (OpenAI json_schema: every property required, no extras). */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          category: { type: 'string', enum: CATEGORIES },
          title: { type: 'string' },
          accountId: { type: 'string' },
          alsoAccountIds: { type: 'array', items: { type: 'string' } },
          at: { type: 'string' },
          botQuote: { type: 'string' },
          userQuote: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          rule: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['severity', 'category', 'title', 'accountId', 'alsoAccountIds', 'at', 'botQuote', 'userQuote', 'why', 'fix', 'rule', 'confidence'],
      },
    },
    patterns: { type: 'array', items: { type: 'string' } },
    workedWell: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'patterns', 'workedWell'],
};

const stamp = (at) => {
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16) + 'Z' : '?';
};

/** One account as the reviewer reads it: the shard header's facts, then the turns. Pure. */
export function renderAccount(account, { maxChars = CHUNK_CHARS } = {}) {
  const a = account || {};
  const head = `## Account ${a.id} · created ${a.created || '?'} · state ${a.state || '?'} · source ${a.source || 'organic'}${a.ad ? ' (ad)' : ''}${a.entry ? ' · entry ' + a.entry : ''} · links made ${a.links?.made ?? 0} paid ${a.links?.paid ?? 0} · ${a.turnsInWindow ?? (a.turns || []).length} turns in the window`;
  const lines = (a.turns || []).map((t) => {
    const who = t.role === 'user' ? 'USER' : t.role === 'assistant' ? `BOT(${t.kind || '?'})` : `EVENT(${t.kind || '?'})`;
    const refs = t.refs && Object.keys(t.refs).length ? ` {refs: ${JSON.stringify(t.refs)}}` : '';
    return `[${stamp(t.at)}]${t.context ? ' [context]' : ''} ${who}: ${String(t.text || '').replace(/\n/g, ' / ')}${refs}`;
  });
  // A single account longer than a chunk keeps its newest turns; the reviewer is told.
  let body = lines.join('\n');
  if (head.length + body.length + 2 > maxChars) {
    const keep = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (size + lines[i].length + 1 > maxChars - head.length - 80) break;
      keep.unshift(lines[i]); size += lines[i].length + 1;
    }
    body = `(earlier turns cut for length: ${lines.length - keep.length})\n${keep.join('\n')}`;
  }
  return `${head}\n${body}`;
}

/** Cut the accounts into chunks of at most `maxAccounts` or about `maxChars` characters. Pure. */
export function chunkAccounts(accounts, { maxAccounts = CHUNK_ACCOUNTS, maxChars = CHUNK_CHARS } = {}) {
  const chunks = [];
  let cur = null;
  const open = () => { cur = { ids: [], names: new Set(), parts: [], chars: 0 }; chunks.push(cur); };
  for (const account of accounts || []) {
    const text = renderAccount(account, { maxChars });
    if (!cur || cur.ids.length >= maxAccounts || (cur.chars > 0 && cur.chars + text.length + 2 > maxChars)) open();
    cur.ids.push(account.id);
    for (const n of account.privacyNames || []) cur.names.add(n);
    cur.parts.push(text);
    cur.chars += text.length + 2;
  }
  return chunks.map((c, i) => ({ index: i, ids: c.ids, names: [...c.names], text: c.parts.join('\n\n'), chars: c.chars }));
}

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const P1_CONFIDENCE = 0.8;
const COMING_SOON = /coming soon|not available (?:today|yet|just yet|right now)|is coming|i will tell you the moment/i;
const INVITE_WORDS = /invite|invitation|waitlist|wait list/i;

/**
 * The precision gate (first real run, 2026-10-19: 54 of 59 "P1" findings were
 * misreadings). A wrong-fact finding whose bot line says coming soon is
 * dropped; a finding that reasons from the business invite list when nobody
 * mentioned a business is dropped; a P1 without a rule and confidence of at
 * least P1_CONFIDENCE becomes a P3 marked "Verify:".
 */
/**
 * Fixed templates whose facts come from the same functions the brief is built
 * from (the fee schedule, PayFast's method list, the link limits). The reviewer
 * cannot know a wrong fact in them that the brief does not; a wrong-fact
 * finding quoting one is a misreading (the 02:00 run on 2026-10-20 flagged the
 * add-money prompt's method list fourteen times).
 */
export const KNOWN_CORRECT_TEMPLATES = [
  /^💳 \*Add Money to WaPay\*/u,
  /^🙏 \*Get paid with WaPay\*/u,
  /Quick choice before I make your link/,
  /Let's get you paid\. Who owes you, and how much\?/,
  /^Here's your payment link for R/,
  /^💸 \*Confirm send\*/u,
];
export function quotesKnownCorrectTemplate(quote) {
  const q = String(quote || '').trim();
  return KNOWN_CORRECT_TEMPLATES.some((re) => re.test(q));
}

export function gateFinding(f) {
  if (!f) return null;
  const quote = `${f.botQuote || ''}`;
  if ((f.category === 'wrong-fact' || f.category === 'money') && COMING_SOON.test(quote)) return null;
  if ((f.category === 'wrong-fact' || f.category === 'money') && quotesKnownCorrectTemplate(quote)) return null;
  if (INVITE_WORDS.test(`${f.why || ''} ${f.cited || ''}`) && !/business/i.test(`${f.userQuote || ''} ${quote}`)) return null;
  const confidence = Number.isFinite(f.confidence) ? Math.max(0, Math.min(1, f.confidence)) : 0.5;
  if (f.severity === 'P1' && (!f.cited || confidence < P1_CONFIDENCE)) {
    return { ...f, confidence, severity: 'P3', title: /^verify:/i.test(f.title) ? f.title : clip(`Verify: ${f.title}`, TITLE_CHARS) };
  }
  return { ...f, confidence };
}

function normaliseFinding(raw, accountIds) {
  if (!raw || typeof raw !== 'object') return [];
  const title = clip(raw.title, TITLE_CHARS);
  if (!title) return [];
  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'P3';
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'other';
  const at = raw.at && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  const base = {
    severity, category, title,
    at,
    botQuote: clip(raw.botQuote, QUOTE_CHARS),
    userQuote: clip(raw.userQuote, QUOTE_CHARS),
    why: clip(raw.why, TEXT_CHARS),
    fix: clip(raw.fix, TEXT_CHARS),
    rule: 'review',
    cited: clip(raw.rule, TEXT_CHARS),
    confidence: typeof raw.confidence === 'number' ? raw.confidence : Number(raw.confidence),
  };
  const ids = [raw.accountId, ...(Array.isArray(raw.alsoAccountIds) ? raw.alsoAccountIds : [])]
    .map((id) => clip(id, 64))
    .filter((id, i, arr) => id && arr.indexOf(id) === i)
    .filter((id) => !accountIds || accountIds.has(id));
  const gated = gateFinding(base);
  if (!gated) return [];
  return ids.map((accountId, i) => ({ ...gated, accountId, at: i === 0 ? at : null }));
}

/** Pull every complete {...} object, at any depth, out of a cut-off JSON text (string aware). */
function salvageObjects(text) {
  const out = [];
  const starts = [];
  let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { starts.push(i); continue; }
    if (ch === '}' && starts.length) {
      const start = starts.pop();
      try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* an inner object closed inside a broken outer one: skip */ }
    }
  }
  return out;
}

/**
 * parseReviewOutput(raw, { accountIds }) -> { findings, patterns, workedWell, error }
 * raw is the model's object or its JSON text. Bad JSON gives no findings and
 * an error; a cut-off text gives the findings that were complete; a finding
 * with fields missing gets defaults; an accountId outside `accountIds` is
 * dropped (a model may not invent an account). Never throws.
 */
export function parseReviewOutput(raw, { accountIds = null } = {}) {
  const ids = accountIds ? new Set(accountIds) : null;
  let obj = raw;
  let error = null;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      obj = JSON.parse(text);
    } catch {
      const salvaged = salvageObjects(text);
      const top = salvaged.find((o) => o && Array.isArray(o.findings));
      const items = top ? top.findings : salvaged.filter((o) => o && typeof o.title === 'string');
      obj = { findings: items };
      error = items.length ? 'PARTIAL_JSON' : 'BAD_JSON';
    }
  }
  if (!obj || typeof obj !== 'object') return { findings: [], patterns: [], workedWell: [], error: error || 'BAD_JSON' };
  const list = Array.isArray(obj.findings) ? obj.findings : [];
  if (!Array.isArray(obj.findings) && !error) error = 'NO_FINDINGS_ARRAY';
  const findings = list.flatMap((f) => normaliseFinding(f, ids));
  const strings = (v) => (Array.isArray(v) ? v.map((s) => clip(s, TEXT_CHARS)).filter(Boolean) : []);
  return { findings, patterns: strings(obj.patterns), workedWell: strings(obj.workedWell), error };
}

/**
 * The production reviewer: null without OPENAI_API_KEY, otherwise a function
 * that makes one structured call through packages/ai's single door with the
 * chunk's names tokenised and the tokens left in the answer.
 */
export function defaultReviewModel({ env = process.env } = {}) {
  if (!env.OPENAI_API_KEY) return null;
  const model = env.WAPAY_AUDIT_REVIEW_MODEL || env.WAPAY_CATEGORY_AGENT_MODEL || DEFAULT_REVIEW_MODEL;
  return async ({ system, user, names = [], timeoutMs }) => {
    const { callStructuredOnce } = await import('@wapay/ai');
    return callStructuredOnce({ model, system, user, names, schemaName: 'audit_review', schema: REVIEW_SCHEMA, maxTokens: 6000, timeoutMs, restore: false });
  };
}

/**
 * reviewAccounts({ brief, accounts, model, maxChars, maxAccounts, deadlineAt, now, concurrency })
 * -> { reviewed, skipped, chunks, chunksReviewed, chunksSkipped, findings, patterns, workedWell, errors }
 * The chunks are independent, so `concurrency` of them are read at once
 * (the budget is a serverless function's, not a reader's). `reviewed` is
 * true only when every chunk was read. A chunk that would not fit before
 * `deadlineAt` is skipped, not started. Results keep the chunk order.
 * Never throws.
 */
export async function reviewAccounts({ brief, accounts, model, maxChars = CHUNK_CHARS, maxAccounts = CHUNK_ACCOUNTS, deadlineAt = null, now = () => Date.now(), log = console, concurrency = reviewConcurrency() } = {}) {
  const chunks = chunkAccounts(accounts, { maxAccounts, maxChars });
  const out = { reviewed: false, skipped: null, chunks: chunks.length, chunksReviewed: 0, chunksSkipped: 0, findings: [], patterns: [], workedWell: [], errors: [] };
  if (typeof model !== 'function') { out.skipped = 'NO_MODEL'; return out; }
  if (!chunks.length) { out.reviewed = true; return out; }
  const results = new Array(chunks.length);
  const queue = chunks.slice();
  const worker = async () => {
    while (queue.length) {
      const chunk = queue.shift();
      const remaining = deadlineAt ? deadlineAt - now() : Infinity;
      if (remaining < MIN_CALL_MS) { results[chunk.index] = { skipped: true }; continue; }
      const timeoutMs = Math.max(MIN_CALL_MS, Math.min(MAX_CALL_MS, remaining - 1000));
      try {
        const raw = await model({ system: brief, user: chunk.text, names: chunk.names, timeoutMs });
        const parsed = parseReviewOutput(raw, { accountIds: chunk.ids });
        if (parsed.error) log.error(JSON.stringify({ type: 'audit_review_parse', chunk: chunk.index, error: parsed.error, findings: parsed.findings.length }));
        results[chunk.index] = { parsed, error: parsed.error ? `chunk ${chunk.index}: ${parsed.error}` : null };
      } catch (error) {
        const message = error?.code === 'AI_PRIVACY_BLOCK' ? `AI_PRIVACY_BLOCK:${(error.kinds || []).join('+')}` : String(error?.message || error).slice(0, 200);
        log.error(JSON.stringify({ type: 'audit_review_chunk_failed', chunk: chunk.index, accounts: chunk.ids.length, chars: chunk.chars, error: message }));
        results[chunk.index] = { failed: true, error: `chunk ${chunk.index}: ${message}` };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, chunks.length)) }, worker));
  for (const r of results) {
    if (!r || r.skipped) { out.chunksSkipped += 1; continue; }
    if (r.error) out.errors.push(r.error);
    if (r.failed) continue;
    out.findings.push(...r.parsed.findings);
    out.patterns.push(...r.parsed.patterns);
    out.workedWell.push(...r.parsed.workedWell);
    out.chunksReviewed += 1;
  }
  out.reviewed = out.chunksReviewed === chunks.length;
  if (!out.reviewed && !out.errors.length && out.chunksSkipped) out.skipped = 'DEADLINE';
  return out;
}
