/**
 * The daily audit's export (docs/audits/DAILY_AUDIT.md, 2026-10-19): every
 * account with a turn since `since`, its turns in the window and the ten
 * turns before the window for context, redacted exactly as
 * scripts/audit/export-conversations.mjs redacts (a run of six digits or
 * more becomes [number], "Name on the account: [name]", and the answer to a
 * full-name ask is [name] by position: audit finding S2-14), grouped per
 * account with the facts the shard header carried (state, source, entry,
 * links made and paid, created). Account ids only: no phone number and no
 * display name in the facts. The display name travels apart as
 * `privacyNames`, for the model boundary to turn into tokens and for the
 * rules to mask inside quotes; it is never printed and never sent.
 *
 * Reads only; takes `prisma` so tests stub it. Never throws on an empty
 * window: an export with no accounts is a quiet night, not an error.
 */

/** The script's redaction, verbatim: numbers of six digits or more, and our own name line. */
export function redactText(t) {
  return String(t || '')
    .replace(/\+?\d[\d \-]{5,}\d/g, '[number]')
    .replace(/\b\d{6,}\b/g, '[number]')
    .replace(/(Name on the account: )[^\n]+/g, '$1[name]');
}

// The customer's answer to a full-name ask is a name, whatever it looks like: redacted by position.
export const NAME_ASK = /full name|name on (the|your) (bank )?account|first name and surname/i;

/** In place of the script's loop: the user turn after a name ask becomes [name]. Pure. */
export function maskNameAnswers(turns) {
  const out = turns.slice();
  for (let i = 1; i < out.length; i++) {
    if (out[i].role === 'user' && out[i - 1].role === 'assistant' && NAME_ASK.test(out[i - 1].text || '')) {
      out[i] = { ...out[i], text: '[name]' };
    }
  }
  return out;
}

// Words that are also everyday chat or WaPay words: never masked as a name on their own.
const NAME_STOPLIST = new Set([
  'gift', 'gifts', 'precious', 'blessing', 'patience', 'mercy', 'faith', 'hope', 'joy', 'prince', 'given', 'lucky', 'happy',
  'smart', 'grace', 'love', 'honest', 'innocent', 'justice', 'beauty', 'success', 'trust', 'wisdom', 'mom', 'mum', 'mama',
  'dad', 'papa', 'baby', 'sister', 'brother', 'friend', 'customer', 'wapay', 'cash', 'money', 'pay', 'send', 'data',
  'airtime', 'voucher', 'balance', 'bank', 'account', 'name', 'user', 'hello', 'test', 'admin', 'team', 'support',
  'boss', 'king', 'queen', 'business', 'shop', 'store', 'the', 'and', 'you', 'your', 'yes', 'home', 'menu', 'help',
  'god', 'lord', 'big', 'small', 'good', 'new', 'man', 'lady', 'girl', 'boy', 'miss', 'mrs', 'mister', 'sir', 'madam',
]);

/**
 * The parts of a display name worth masking: the whole name and each part of
 * three letters or more, letters only, none of the everyday words above. Pure.
 */
export function nameParts(displayName) {
  const full = String(displayName || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (full.length < 2 || full.length > 80 || /\d/.test(full)) return [];
  if (!/^[\p{L}][\p{L}' .-]*$/u.test(full)) return [];
  const out = new Set();
  if (!NAME_STOPLIST.has(full.toLowerCase())) out.add(full);
  for (const part of full.split(/[ .-]+/)) {
    if (part.length >= 3 && !NAME_STOPLIST.has(part.toLowerCase())) out.add(part);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace the known names in a text with [name]. Pure. */
export function maskNames(text, names = []) {
  let s = String(text ?? '');
  for (const n of names || []) {
    if (!n || n.length < 3) continue;
    s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
  }
  return s;
}

const toDate = (v) => (v instanceof Date ? v : new Date(v));
const iso = (d) => (d ? toDate(d).toISOString() : null);

/**
 * exportTurns({ prisma, since, until, maxAccounts, contextTurns, contextDays })
 * -> { since, until, accounts: [{ id, state, source, entry, ad, created,
 *      links: { made, paid }, turnsInWindow, turns: [{ role, kind, text, at,
 *      refs, context }], privacyNames }], counts: { accounts, turns,
 *      windowTurns, contextTurns }, truncated }
 *
 * Accounts are ordered busiest first (as the shards were); past `maxAccounts`
 * the rest are left for the next run and counted in `truncated`. Context is
 * the last `contextTurns` turns in the `contextDays` before the window (one
 * bounded query, never one per account).
 */
export async function exportTurns({ prisma, since, until = new Date(), maxAccounts = 200, contextTurns = 10, contextDays = 7 } = {}) {
  const from = toDate(since);
  const to = toDate(until);
  const select = { accountId: true, role: true, kind: true, text: true, createdAt: true, refs: true };
  const windowTurns = await prisma.conversationTurn.findMany({
    where: { createdAt: { gte: from, lt: to } },
    orderBy: [{ accountId: 'asc' }, { createdAt: 'asc' }],
    select,
  });
  const byAcc = new Map();
  for (const t of windowTurns) {
    if (!byAcc.has(t.accountId)) byAcc.set(t.accountId, []);
    byAcc.get(t.accountId).push(t);
  }
  const ordered = [...byAcc.keys()].sort((a, b) => {
    const d = byAcc.get(b).length - byAcc.get(a).length;
    if (d) return d;
    const la = byAcc.get(a); const lb = byAcc.get(b);
    return toDate(lb[lb.length - 1].createdAt).getTime() - toDate(la[la.length - 1].createdAt).getTime();
  });
  const cap = Math.max(1, Number(maxAccounts) || 200);
  const ids = ordered.slice(0, cap);
  const truncated = Math.max(0, ordered.length - ids.length);

  let contextRows = [];
  if (ids.length && contextTurns > 0) {
    const contextSince = new Date(from.getTime() - Math.max(1, contextDays) * 86400000);
    contextRows = await prisma.conversationTurn.findMany({
      where: { accountId: { in: ids }, createdAt: { gte: contextSince, lt: from } },
      orderBy: [{ accountId: 'asc' }, { createdAt: 'desc' }],
      select,
    });
  }
  const contextBy = new Map();
  for (const t of contextRows) {
    if (!contextBy.has(t.accountId)) contextBy.set(t.accountId, []);
    const list = contextBy.get(t.accountId);
    if (list.length < contextTurns) list.push(t);
  }

  const accountRows = ids.length
    ? await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, onboardingState: true, createdAt: true, profile: true } })
    : [];
  const linkRows = ids.length
    ? await prisma.paymentRequest.groupBy({ by: ['accountId', 'status'], _count: true, where: { accountId: { in: ids } } })
    : [];
  const linkStats = {};
  for (const l of linkRows || []) {
    linkStats[l.accountId] ||= { made: 0, paid: 0 };
    const n = typeof l._count === 'number' ? l._count : Number(l._count?._all || 0);
    linkStats[l.accountId].made += n;
    if (l.status === 'PAID') linkStats[l.accountId].paid += n;
  }
  const meta = new Map((accountRows || []).map((a) => [a.id, a]));

  let turnCount = 0; let contextCount = 0;
  const accounts = ids.map((id) => {
    const a = meta.get(id) || {};
    const context = (contextBy.get(id) || []).slice().reverse().map((t) => ({ ...t, context: true }));
    const inWindow = (byAcc.get(id) || []).map((t) => ({ ...t, context: false }));
    const turns = maskNameAnswers([...context, ...inWindow].map((t) => ({
      role: t.role,
      kind: t.kind || null,
      text: redactText(t.text),
      at: iso(t.createdAt),
      refs: t.refs && typeof t.refs === 'object' && Object.keys(t.refs).length ? t.refs : null,
      context: !!t.context,
    })));
    turnCount += turns.length; contextCount += context.length;
    return {
      id,
      state: a.onboardingState || null,
      source: a.profile?.acquisitionSource || 'organic',
      entry: a.profile?.attribution?.entry || null,
      ad: !!a.profile?.attribution?.ctwaClid,
      created: a.createdAt ? iso(a.createdAt).slice(0, 10) : null,
      links: linkStats[id] || { made: 0, paid: 0 },
      turnsInWindow: inWindow.length,
      turns,
      privacyNames: nameParts(a.displayName),
    };
  });

  return {
    since: from.toISOString(),
    until: to.toISOString(),
    accounts,
    counts: { accounts: accounts.length, turns: turnCount, windowTurns: windowTurns.length - (truncated ? ordered.slice(cap).reduce((s, k) => s + byAcc.get(k).length, 0) : 0), contextTurns: contextCount },
    truncated,
  };
}
