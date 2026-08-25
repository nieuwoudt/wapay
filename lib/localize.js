/**
 * Outbound localization for DETERMINISTIC surfaces (founder feedback
 * 2026-08-25: isiZulu/isiXhosa testers got hardcoded-English menus while the
 * bot claimed "any South African language works").
 *
 * The AI path already replies in the user's language (orchestrator rule);
 * this covers the canned surfaces — menus, prompts, confirmations.
 *
 * Safety model:
 * - MONEY AND CODES ARE FROZEN: rand amounts, PR-codes, serials, URLs,
 *   phone numbers and digit-runs are replaced with placeholders before
 *   translation and restored verbatim after — a translation can never
 *   alter an amount, a code, or a link. If any placeholder goes missing
 *   from the model output, the ENGLISH original is sent instead.
 * - FAIL-OPEN: any error, timeout, or missing API key sends the English
 *   original. Localization must never block or delay a money flow beyond
 *   its own small budget (~2.5s).
 * - Cached per (text, language) for the life of the instance — the big
 *   menus translate once per cold start, not once per message.
 */

const SUPPORTED = new Set(['af', 'zu', 'xh', 'st', 'tn', 'nso', 'ts', 've', 'ss', 'nr']);

const LANGUAGE_NAMES = {
  af: 'Afrikaans', zu: 'isiZulu', xh: 'isiXhosa', st: 'Sesotho', tn: 'Setswana',
  nso: 'Sepedi', ts: 'Xitsonga', ve: 'Tshivenda', ss: 'siSwati', nr: 'isiNdebele',
};

const cache = new Map(); // `${lang}:${text}` -> translated
const MAX_CACHE = 500;

/** Freeze anything a translation must never touch. */
function freeze(text) {
  const frozen = [];
  const out = text.replace(
    // URLs · PR-codes · rand amounts · phone numbers · long digit runs · emoji-ish markers stay as-is
    /(https?:\/\/\S+|\bPR[A-Z]{6}\b|R\s?\d[\d\s,.]*|\b0\d{9}\b|\b27\d{9}\b|\b\d{4,}\b)/g,
    (m) => {
      frozen.push(m);
      return `⟦${frozen.length - 1}⟧`;
    }
  );
  return { out, frozen };
}

function thaw(raw, frozen) {
  // The model must return the placeholders in the SAME order and count — a
  // reordering (isiZulu/isiXhosa freely re-order clauses) could invert a
  // range like R5–R3000 with a presence-only check (abuse review 2026-08-25).
  const seq = [...String(raw).matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1]));
  if (seq.length !== frozen.length) return null;
  for (let i = 0; i < seq.length; i += 1) if (seq[i] !== i) return null;
  return String(raw).replace(/⟦(\d+)⟧/g, (_, i) => frozen[Number(i)]);
}

/**
 * Translate outbound copy into the user's language. English (or unknown /
 * unsupported language) returns the text untouched.
 *
 * @param {string} text - the English copy (may contain *WhatsApp bold*)
 * @param {string|null|undefined} language - ISO-ish code from the profile
 * @returns {Promise<string>}
 */
export async function localizeOutbound(text, language) {
  const lang = String(language || '').toLowerCase();
  if (!lang || lang === 'en' || !SUPPORTED.has(lang)) return text;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !text || text.length > 2500) return text;

  const key = `${lang}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { out, frozen } = freeze(text);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              `Translate the user's message into ${LANGUAGE_NAMES[lang]} for a WhatsApp money app in South Africa. ` +
              `Keep it natural, warm and SHORT — everyday township ${LANGUAGE_NAMES[lang]}, not textbook formal. ` +
              `PRESERVE EXACTLY: every ⟦n⟧ placeholder, all *asterisk bold* markers, emoji, line breaks, and bullet layout. ` +
              `Never add, drop, or reorder placeholders. Output ONLY the translation.`,
          },
          { role: 'user', content: out },
        ],
      }),
    });
    if (!resp.ok) { clearTimeout(timer); return text; }
    const data = await resp.json();
    clearTimeout(timer);
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return text;
    const restored = thaw(raw, frozen);
    if (!restored) {
      console.log(JSON.stringify({ type: 'localize_placeholder_lost', lang, timestamp: new Date().toISOString() }));
      return text; // a translation that lost an amount/code never ships
    }
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, restored);
    return restored;
  } catch {
    return text;
  }
}

/**
 * Explicit "speak <language>" asks — the strongest possible evidence.
 * Matches English names, native names, and common phrasings across the 11
 * official languages. Returns the language code or null.
 */
export function matchLanguageSwitch(text = '', { inFlow = false } = {}) {
  const s = String(text).toLowerCase().trim();

  const LANGS = [
    ['en', 'english|engels'],
    ['af', 'afrikaans'],
    ['zu', 'isizulu|zulu|ngesizulu'],
    ['xh', 'isixhosa|xhosa|ngesixhosa'],
    ['st', 'sesotho|sotho'],
    ['tn', 'setswana|tswana'],
    ['nso', 'sepedi|pedi'],
    ['ts', 'xitsonga|tsonga'],
    ['ve', 'tshivenda|venda'],
    ['ss', 'siswati|swati'],
    ['nr', 'isindebele|ndebele'],
  ];
  const anyLang = LANGS.map(([, alt]) => alt).join('|');

  // A bare language name ("isiXhosa") only counts as a switch when NOT mid-
  // flow — surnames (Zulu, Venda) are legitimate flow answers (abuse review
  // 2026-08-25: bare-name matching swallowed in-flow input).
  if (!inFlow && new RegExp(`^(${anyLang})$`).test(s)) {
    return firstLang(s, LANGS);
  }

  // STRONG language verbs (about language, not objects): "speak Xhosa",
  // "praat Afrikaans", "khuluma isiZulu" — match with the language anywhere,
  // tolerant of messy transcription ("Speak me me I Xhosa on how to do this").
  const strong = 'speak|talk|praat|khuluma|thetha|bua|bolela|kuluma';
  const strongHit = new RegExp(`\\b(?:${strong})\\b`).test(s) && firstLang(s, LANGS);
  if (strongHit) return strongHit;

  // Explicit "switch to / change to <language>" — the only object-taking
  // verbs allowed, and ONLY with "to". Object phrasings that merely mention
  // a language ("reply to my sister in Xhosa", "change my Zulu voucher")
  // never match (abuse review 2026-08-25: those swallowed the real message).
  const m = s.match(new RegExp(`\\b(?:switch|change)\\s+to\\s+(${anyLang})\\b`));
  if (m) return codeFor(m[1], LANGS);

  // "in <language> please" as a short standalone directive (≤ 4 words total).
  if (s.split(/\s+/).length <= 4) {
    const inm = s.match(new RegExp(`\\bin\\s+(${anyLang})\\b`));
    if (inm) return codeFor(inm[1], LANGS);
  }
  return null;
}

function firstLang(s, LANGS) {
  let best = null; let bestIdx = Infinity;
  for (const [code, alt] of LANGS) {
    const mm = s.match(new RegExp(`\\b(${alt})\\b`));
    if (mm && mm.index < bestIdx) { bestIdx = mm.index; best = code; }
  }
  return best;
}

function codeFor(word, LANGS) {
  for (const [code, alt] of LANGS) if (new RegExp(`^(${alt})$`).test(word)) return code;
  return null;
}

/** Localized "done — speaking X now" confirmations (static — no AI needed). */
export const LANGUAGE_CONFIRMATIONS = {
  en: '👍 English it is!',
  af: '👍 Reg so — ons praat nou Afrikaans!',
  zu: '👍 Kulungile — sesikhuluma isiZulu manje!',
  xh: '👍 Kulungile — sithetha isiXhosa ngoku!',
  st: '👍 Ho lokile — re bua Sesotho jwale!',
  tn: '👍 Go siame — re bua Setswana jaanong!',
  nso: '👍 Go lokile — re bolela Sepedi bjale!',
  ts: '👍 Hi kahle — hi vulavula Xitsonga sweswi!',
  ve: '👍 Zwo luga — ri amba Tshivenda zwino!',
  ss: '👍 Kulungile — sikhuluma siSwati nyalo!',
  nr: '👍 Kulungile — sikhuluma isiNdebele nje!',
};
