/**
 * "Can you save my number used above as mine?", "call it mother", "name that
 * account mine": a real action on the customer's saved pay-out destinations,
 * answered deterministically before any model runs (founder 2026-10-12: the
 * agent answered "Saved, Nieuwoudt 😊 I'll remember that the number used
 * above is yours" and saved nothing, the second false save claim in a week).
 *
 * The destination named is the one the newest pay-out went to when it is
 * saved; if that pay-out's destination is not saved, the reply says so (it
 * never renames a different row); with no pay-out yet, the most recently used
 * saved row. Labels and masks only; nothing full is read here.
 */
import prisma from './prisma.js';
import { beneficiariesAvailable, listPayoutDestinations, setPayoutDestinationNickname, cleanNickname, DESTINATION_FAMILY } from './payout-beneficiaries.js';

const NICK = `["'“‘]?([\\p{L}][\\p{L}' -]{0,23}?)["'”’]?`;
const END = `\\s*[?.!]*\\s*$`;
const PATTERNS = [
  // "can you save my number used above as mine?", "save that account as mother"
  new RegExp(`\\b(?:save|keep|store|remember)\\b[^?.!]{0,60}?\\b(?:number|account|cellphone|phone|it|that|this|one|details)\\b[^?.!]{0,30}?\\bas\\s+${NICK}${END}`, 'iu'),
  // "name that account mine", "call my capitec account mine", "call the number above mother"
  new RegExp(`\\b(?:call|name|label|nickname)\\s+(?:my|the|that|this)\\s+(?:[\\p{L}]+\\s+){0,3}?(?:number|account|cellphone|phone)(?:\\s+(?:above|used above|i used))?\\s+(?:as\\s+)?${NICK}${END}`, 'iu'),
  // "call it mother", "name that one mine", "label it mine"
  new RegExp(`\\b(?:call|name|label|nickname)\\s+(?:that one|this one|the last one|it|that|this|them)\\s+(?:as\\s+)?${NICK}${END}`, 'iu'),
];

/** The nickname the customer is giving, or null. Pure. "Call me Thandi" is never a destination name. */
export function matchNicknameAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 140) return null;
  if (/\b(?:call|name)\s+me\b|\bmy name is\b/i.test(t)) return null;
  for (const re of PATTERNS) {
    const m = t.match(re);
    if (m) return cleanNickname(m[1]);
  }
  return null;
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const NOTHING_SAVED = 'Nothing is saved for your withdrawals yet, so there is nothing to name. After your next withdrawal I will ask whether to save the account or cellphone, and you can give it a name then.';

/**
 * Set the nickname. deps (tests): { listDestinations, setNickname, latestPayout, available }.
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function nicknameLastDestination({ prisma: db = prisma, account, nickname, deps = {} } = {}) {
  const nick = cleanNickname(nickname);
  if (!account?.id || !nick) return { ok: false, text: 'Tell me the name, like "call it mine" or "call it mother".' };
  const available = deps.available ? deps.available() : beneficiariesAvailable();
  if (!available) return { ok: false, text: NOTHING_SAVED };
  const list = await (deps.listDestinations || listPayoutDestinations)({ prisma: db, accountId: account.id }).catch(() => []);
  if (!list?.length) return { ok: false, text: NOTHING_SAVED };
  const latest = await (deps.latestPayout || (async () => db.providerRequest.findFirst({ where: { accountId: account.id, route: 'ott-payout' }, orderBy: { requestTs: 'desc' } })))().catch(() => null);
  let target = list[0];
  if (latest?.metadata?.method) {
    const family = DESTINATION_FAMILY[latest.metadata.method];
    const tail = digits(family === 'BANK' ? latest.metadata.recipient?.account : latest.metadata.recipient?.mobile);
    const hit = tail ? list.find((d) => d.family === family && (digits(d.label).endsWith(tail) || tail.endsWith(digits(d.label).slice(-3)))) : null;
    if (!hit) {
      const what = family === 'BANK' ? 'account' : 'cellphone number';
      return { ok: false, text: `The ${what} your last withdrawal went to is not saved, so I cannot name it. Next time you withdraw to it, reply *yes* when I ask to save it, and give it a name then.` };
    }
    target = hit;
  }
  const res = await (deps.setNickname || setPayoutDestinationNickname)({ prisma: db, accountId: account.id, id: target.id, nickname: nick }).catch(() => ({ ok: false }));
  if (!res?.ok) return { ok: false, text: 'I could not change the name just now, so nothing changed. Please try again in a moment.' };
  return { ok: true, text: `✅ Done: it is saved as *${res.nickname}*: ${res.label}. Next time you withdraw, say "${res.nickname.toLowerCase()}" to use it.` };
}
