// Deterministic sweep of the redacted export: rules that need no judgement. Writes scan.md + scan.json next to the export.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2];
const turns = readFileSync(`${dir}/turns.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const meta = JSON.parse(readFileSync(`${dir}/accounts.json`, 'utf8'));
const by = new Map(); for (const t of turns) { if (!by.has(t.a)) by.set(t.a, []); by.get(t.a).push(t); }
const RULES = {
  ewallet: [/eWallet|e-wallet|FNB ATM/i, 'P1 names the FNB eWallet, which production does not have'],
  r20: [/\bR20\b[^.]{0,40}\b(withdraw|R3000|R3 000)|withdraw[^.]{0,60}\bR20\b|between R20 and/i, 'P1 quotes a R20 withdrawal minimum'],
  date: [/\b(within (?:\d+|a few|twenty-four|24) (?:hours?|days?)|tomorrow|next week|next month|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (?:january|february|march|april|may|june|july|august|september|october|november|december)|20\d\d)\b/i, 'P2 a time or date promise'],
  betting: [/\b(bet|bets|betting|wager|casino|odds|gambl\w*|hollywoodbets|betway|sportingbet)\b/i, 'P1 a betting word in customer copy'],
  emdash: [/[—–]/, 'P3 an em or en dash'],
  internal: [/\b(undefined|null|NaN|\[object Object\]|onboarding_step_\d|otp_register|consent_terms_|welcome_new_user)\b/, 'P1 an internal name or a raw value leaked'],
  error: [/(something went wrong|try again later|an error occurred|internal error|unexpected error|failed to)/i, 'P2 an error line reached the customer'],
  comingSoonLive: [/(send money|get paid|payment link|withdraw\w*)[^.]{0,40}coming soon/i, 'P1 calls a live product coming soon'],
};
const findings = []; const counts = {}; const patterns = { unansweredAccounts: [], loops: [], clarifyRuns: [], gateTier3: [], longReplies: [], comingSoonAsks: {}, businessAsks: 0, withdrawAsksR0: 0 };
const COMING = { airtime: /\bairtime\b/i, data: /\b(data|bundle)\b/i, electricity: /\b(electricity|prepaid|meter)\b/i, fuel: /\b(fuel|petrol|diesel)\b/i, voucher: /\b(ott|voucher|1voucher|blu)\b/i, card: /\b(virtual card|card number|bank card)\b/i, instore: /\b(in-?store|till|shop|spar|shoprite|checkers|pick n pay)\b/i, bills: /\b(dstv|netflix|bill)\b/i, loan: /\b(loan|borrow|credit|lend)\b/i, betting: /\b(bet|betway|hollywood)\b/i };
for (const [acc, ts] of by) {
  const m = meta[acc] || {};
  // rules on bot text
  for (const t of ts) {
    if (t.r !== 'assistant') continue;
    for (const [key, [re, label]] of Object.entries(RULES)) {
      if (re.test(t.t)) { counts[key] = (counts[key] || 0) + 1; findings.push({ rule: key, label, account: acc, at: t.at, quote: t.t.slice(0, 220) }); }
    }
    if (t.t.length > 1200) patterns.longReplies.push({ account: acc, at: t.at, chars: t.t.length });
  }
  // unanswered: the last turn is a user turn older than 10 minutes relative to the next bot reply (none)
  const last = ts[ts.length - 1];
  if (last?.r === 'user' && Date.now() - Date.parse(last.at) > 10 * 60 * 1000) patterns.unansweredAccounts.push({ account: acc, at: last.at, text: last.t.slice(0, 120), state: m.state });
  // loops: identical bot text 3 times within the account; clarify runs
  const seen = {}; let clar = 0;
  for (const t of ts) {
    if (t.r !== 'assistant') continue;
    const k = t.t.slice(0, 160); seen[k] = (seen[k] || 0) + 1;
    if (/not sure what you mean|do you mean|didn't catch|did not catch|could you rephrase/i.test(t.t)) { clar += 1; if (clar === 2) patterns.clarifyRuns.push({ account: acc, at: t.at }); } else clar = 0;
    if (t.refs?.gate && t.refs?.tier >= 2) patterns.gateTier3.push({ account: acc, at: t.at });
  }
  for (const [k, n] of Object.entries(seen)) if (n >= 3) patterns.loops.push({ account: acc, times: n, text: k.slice(0, 100) });
  // what customers ask for that is coming soon
  for (const t of ts) {
    if (t.r !== 'user') continue;
    for (const [k, re] of Object.entries(COMING)) if (re.test(t.t)) patterns.comingSoonAsks[k] = (patterns.comingSoonAsks[k] || 0) + 1;
    if (/business account|my business|for my (shop|business|spaza)/i.test(t.t)) patterns.businessAsks += 1;
  }
}
const md = [`# Deterministic scan · ${new Date().toISOString()} · ${by.size} accounts · ${turns.length} turns`, '', '## Rule hits (bot text)'];
for (const [k, [, label]] of Object.entries(RULES)) md.push(`- ${k}: ${counts[k] || 0} · ${label}`);
md.push('', '## Hits in detail');
for (const f of findings) md.push(`- [${f.rule}] ${f.account} ${f.at.slice(5, 16)}Z: ${f.quote.replace(/\n/g, ' / ')}`);
md.push('', `## Unanswered last user turns (${patterns.unansweredAccounts.length})`); for (const u of patterns.unansweredAccounts) md.push(`- ${u.account} ${u.at.slice(5, 16)}Z state ${u.state}: ${u.text.replace(/\n/g, ' / ')}`);
md.push('', `## Repeated bot text 3+ times (${patterns.loops.length})`); for (const l of patterns.loops) md.push(`- ${l.account} ×${l.times}: ${l.text.replace(/\n/g, ' / ')}`);
md.push('', `## Two clarifications in a row (${patterns.clarifyRuns.length})`); for (const c of patterns.clarifyRuns) md.push(`- ${c.account} ${c.at.slice(5, 16)}Z`);
md.push('', `## Third-tier gate reached (${patterns.gateTier3.length})`); for (const g of patterns.gateTier3) md.push(`- ${g.account} ${g.at.slice(5, 16)}Z`);
md.push('', `## Bot replies over 1,200 characters (${patterns.longReplies.length})`); for (const l of patterns.longReplies.slice(0, 30)) md.push(`- ${l.account} ${l.at.slice(5, 16)}Z ${l.chars} chars`);
md.push('', '## What customers asked for (user turns matching a coming-soon or absent product)'); for (const [k, n] of Object.entries(patterns.comingSoonAsks).sort((a, b) => b[1] - a[1])) md.push(`- ${k}: ${n}`);
md.push(`- business account asks: ${patterns.businessAsks}`);
writeFileSync(`${dir}/scan.md`, md.join('\n')); writeFileSync(`${dir}/scan.json`, JSON.stringify({ counts, findings, patterns }, null, 1));
console.log(md.slice(0, 12).join('\n')); console.log(`unanswered ${patterns.unansweredAccounts.length} · loops ${patterns.loops.length} · clarify runs ${patterns.clarifyRuns.length} · tier3 ${patterns.gateTier3.length} · long ${patterns.longReplies.length}`); console.log('asks', JSON.stringify(patterns.comingSoonAsks), 'business', patterns.businessAsks);
