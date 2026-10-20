// Exports every conversation (redacted: numbers masked, first names only, account ids instead of phones) into shards for review.
import { writeFileSync } from 'node:fs';
import prisma from '../../lib/prisma.js';
const out = process.argv[2]; const shards = Number(process.argv[3] || 4);
const redact = (t) => String(t || '').replace(/\+?\d[\d \-]{5,}\d/g, '[number]').replace(/\b\d{6,}\b/g, '[number]').replace(/(Name on the account: )[^\n]+/g, '$1[name]');
// The customer's answer to a full-name ask is a name, whatever it looks like: redacted by position (audit finding S2-14).
const NAME_ASK = /full name|name on (the|your) (bank )?account|first name and surname/i;
const turns = await prisma.conversationTurn.findMany({ orderBy: [{ accountId: 'asc' }, { createdAt: 'asc' }], select: { accountId: true, role: true, kind: true, text: true, createdAt: true, refs: true } });
const ids = [...new Set(turns.map((t) => t.accountId))];
const accounts = await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, onboardingState: true, createdAt: true, profile: true } });
const links = await prisma.paymentRequest.groupBy({ by: ['accountId', 'status'], _count: true, where: { accountId: { in: ids } } });
const linkStats = {}; for (const l of links) { linkStats[l.accountId] ||= { made: 0, paid: 0 }; linkStats[l.accountId].made += l._count; if (l.status === 'PAID') linkStats[l.accountId].paid += l._count; }
const byAcc = new Map(); for (const t of turns) { if (!byAcc.has(t.accountId)) byAcc.set(t.accountId, []); byAcc.get(t.accountId).push(t); }
for (const ts of byAcc.values()) for (let i = 1; i < ts.length; i++) if (ts[i].role === 'user' && ts[i - 1].role === 'assistant' && NAME_ASK.test(ts[i - 1].text)) ts[i] = { ...ts[i], text: '[name]' };
const meta = Object.fromEntries(accounts.map((a) => [a.id, { name: String(a.displayName || '').trim().split(/\s+/)[0] || '(none)', state: a.onboardingState, created: a.createdAt.toISOString(), source: a.profile?.acquisitionSource || 'organic', entry: a.profile?.attribution?.entry || null, ad: !!a.profile?.attribution?.ctwaClid, links: linkStats[a.id] || { made: 0, paid: 0 }, turns: (byAcc.get(a.id) || []).length }]));
const order = [...byAcc.keys()].sort((a, b) => (byAcc.get(b).length - byAcc.get(a).length));
const files = Array.from({ length: shards }, () => []);
order.forEach((id, i) => files[i % shards].push(id));
const ts = (d) => new Date(d).toISOString().slice(5, 16).replace('T', ' ') + 'Z';
files.forEach((idsInShard, i) => {
  const lines = [`# Conversation shard ${i + 1} of ${shards} · ${idsInShard.length} accounts · exported ${new Date().toISOString()}`, '', 'Numbers are masked as [number]; names are first names only; BOT(kind) is which path answered: flow = scripted flow or orchestrator, agent = Pay agent, guard, home, receipt, ops = a person. refs carry gate ids.', ''];
  for (const id of idsInShard) {
    const m = meta[id] || {}; const ts0 = byAcc.get(id);
    lines.push(`## Account ${id} · ${m.name} · created ${String(m.created).slice(0, 16)}Z · state ${m.state} · source ${m.source}${m.ad ? ' (ad)' : ''}${m.entry ? ' · entry ' + m.entry : ''} · links made ${m.links?.made ?? 0} paid ${m.links?.paid ?? 0} · ${ts0.length} turns`);
    for (const t of ts0) {
      const who = t.role === 'user' ? 'USER' : t.role === 'assistant' ? `BOT(${t.kind || '?'})` : `EVENT(${t.kind || '?'})`;
      const refs = t.refs && Object.keys(t.refs).length ? ` {refs: ${JSON.stringify(t.refs)}}` : '';
      lines.push(`[${ts(t.createdAt)}] ${who}: ${redact(t.text).replace(/\n/g, ' / ')}${refs}`);
    }
    lines.push('');
  }
  writeFileSync(`${out}/shard-${i + 1}.md`, lines.join('\n'));
});
writeFileSync(`${out}/turns.jsonl`, turns.map((t) => JSON.stringify({ a: t.accountId, r: t.role, k: t.kind, t: redact(t.text), at: t.createdAt.toISOString(), refs: t.refs || null })).join('\n'));
writeFileSync(`${out}/accounts.json`, JSON.stringify(meta, null, 1));
console.log('accounts', ids.length, 'turns', turns.length, 'shards', files.map((f) => f.length).join('/'));
process.exit(0);
