import prisma from './lib/prisma.js';
const rows = await prisma.agentTurn.findMany({ orderBy: { createdAt: 'desc' }, take: 25,
  select: { createdAt: true, path: true, outcome: true, gatesFired: true, ms: true, error: true, toolCalls: true, proposal: true } });
console.log('agent_turns total:', await prisma.agentTurn.count());
for (const r of rows.reverse()) {
  const t = r.createdAt.toISOString().slice(11,16);
  const tools = Array.isArray(r.toolCalls) ? r.toolCalls.map(c=>c.name||c).join(',') : '';
  console.log(`${t} ${String(r.path).padEnd(6)} ${String(r.outcome).padEnd(9)} ${String(r.ms||'').padStart(5)}ms gates=${JSON.stringify(r.gatesFired||[])} err=${r.error||'-'} tools=[${tools}] prop=${r.proposal?JSON.stringify(r.proposal).slice(0,90):'-'}`);
}
await prisma.$disconnect();
