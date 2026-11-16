// Fakes for tests of lib/request-notify.js (BUGLOG #145): each notice leg is claimed by a unique row in
// processed_messages before it is sent, and the notified flags are merged in SQL with $executeRaw.
//
// claimTable(): an in-memory processed_messages with the unique waMessageId Postgres enforces (P2002 on a
// duplicate). Every call yields to the event loop first, so two deliveries started together interleave the
// way two serverless invocations do.
// jsonbMerge(rowFor): prisma.$executeRaw as persistFlag calls it, `... || ${patch}::jsonb WHERE "idemKey" =
// ${idemKey}`, merged into rowFor(idemKey).metadata.

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

export function claimTable() {
  const rows = new Map();
  let seq = 0;
  const matches = (row, where = {}) => Object.entries(where).every(([field, want]) => (
    want && typeof want === 'object' && 'lt' in want ? row[field] < want.lt : row[field] === want
  ));
  return {
    rows,
    processedMessage: {
      create: async ({ data }) => {
        await yieldTurn();
        if (rows.has(data.waMessageId)) throw Object.assign(new Error('Unique constraint failed on the fields: (`waMessageId`)'), { code: 'P2002' });
        const row = { id: `pm${++seq}`, accountId: null, processedAt: new Date(), ...data };
        rows.set(row.waMessageId, row);
        return row;
      },
      findUnique: async ({ where }) => { await yieldTurn(); return rows.get(where.waMessageId) ?? null; },
      deleteMany: async ({ where }) => {
        await yieldTurn();
        let count = 0;
        for (const [key, row] of rows) if (matches(row, where)) { rows.delete(key); count += 1; }
        return { count };
      },
    },
  };
}

export const jsonbMerge = (rowFor) => async (_sql, patch, idemKey) => {
  await yieldTurn();
  const row = rowFor(idemKey);
  if (!row) return 0;
  row.metadata = { ...(row.metadata || {}), ...JSON.parse(patch) };
  return 1;
};
