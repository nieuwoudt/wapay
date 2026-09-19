import prisma from './lib/prisma.js';
const g = await prisma.providerRequest.groupBy({ by: ['route','status'], _count: {_all:true}, _max: {requestTs:true} });
console.log('PROVIDER REQUESTS (route / status / n / last):');
for (const r of g.sort((a,b)=>a.route.localeCompare(b.route))) {
  console.log(`  ${r.route.padEnd(18)} ${String(r.status).padEnd(12)} ${String(r._count._all).padStart(3)}  ${r._max.requestTs?.toISOString().slice(0,10)}`);
}
const je = await prisma.journalEntry.groupBy({ by: ['source'], _count: {_all:true}, _max:{createdAt:true} });
console.log('\nJOURNAL ENTRIES (source / n / last):');
for (const r of je) console.log(`  ${String(r.source).padEnd(22)} ${String(r._count._all).padStart(3)}  ${r._max.createdAt?.toISOString().slice(0,10)}`);
const pg = await prisma.pendingGift.groupBy({ by:['status'], _count:{_all:true} }).catch(()=>[]);
console.log('\nGIFTS:', JSON.stringify(pg.map(x=>({s:x.status,n:x._count._all}))));
const pr = await prisma.paymentRequest.groupBy({ by:['status'], _count:{_all:true} }).catch(()=>[]);
console.log('PAY LINKS:', JSON.stringify(pr.map(x=>({s:x.status,n:x._count._all}))));
await prisma.$disconnect();
