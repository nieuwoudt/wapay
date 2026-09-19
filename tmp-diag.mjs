import prisma from './lib/prisma.js';
const rows = await prisma.providerRequest.findMany({
  where: { route: { contains: 'airtime' } }, orderBy: { requestTs: 'desc' }, take: 4,
  select: { route:true, status:true, requestTs:true, metadata:true, idemKey:true },
});
for (const r of rows) {
  console.log('---', r.route, r.status, r.requestTs.toISOString());
  const m = r.metadata && typeof r.metadata==='object' ? r.metadata : {};
  console.log(JSON.stringify(m).slice(0, 1200));
}
await prisma.$disconnect();
