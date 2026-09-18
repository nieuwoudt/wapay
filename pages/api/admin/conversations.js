/**
 * Mission Control: the conversation card (C19 of docs/AGENT_ARCHITECTURE_V2.md).
 *
 * What a human needs to see while the Pay agent runs behind the shadow list:
 * how many turns each brain answered, what the agent cost, how often an output
 * gate had to rewrite a reply, how slow the slowest turns were, and which
 * pay-outs are still parked with the rail. Read-only aggregates; no customer
 * text and no bearer digits ever leave the database through this route (the
 * agent_turns payloads are already masked at write time by lib/agent/turn-ledger.js,
 * and this route does not read conversation_turns text at all).
 *
 * Session-cookie or internal-key gated, like every other admin route.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { shadowListDiagnostics } from '../../../lib/shadow-list.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Model prices in US dollars per MILLION tokens: the same two env names and
// the same unit the eval runner uses (scripts/eval-agent.mjs), so a price is
// set once and read the same way in both places. Optional WAPAY_USD_ZAR adds
// a rand figure; without it the card shows dollars and never guesses a rate.
const PRICE_IN = Number(process.env.WAPAY_EVAL_PRICE_INPUT_USD_PER_M || 0);
const PRICE_OUT = Number(process.env.WAPAY_EVAL_PRICE_OUTPUT_USD_PER_M || 0);
const USD_ZAR = Number(process.env.WAPAY_USD_ZAR || 0);
const costUsd = (inTok, outTok) => (inTok * PRICE_IN + outTok * PRICE_OUT) / 1_000_000;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  const since = new Date(Date.now() - days * DAY_MS);

  try {
    const [turns, agentRows, parked, shadowListRaw] = await Promise.all([
      // Both sides of every conversation, by role: the denominator.
      prisma.conversationTurn
        .groupBy({ by: ['role'], where: { createdAt: { gte: since } }, _count: { _all: true } })
        .catch(() => []),
      // Every agent turn in the window: outcome, gates, latency, tokens.
      prisma.agentTurn
        .findMany({
          where: { createdAt: { gte: since } },
          select: { path: true, outcome: true, gatesFired: true, ms: true, inputTokens: true, outputTokens: true, model: true, error: true, accountId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5000,
        })
        .catch(() => []),
      // Pay-outs the rail has not settled: the drift a human must chase.
      prisma.providerRequest
        .findMany({
          where: { route: 'ott-payout', status: { in: ['INIT', 'PENDING'] } },
          select: { status: true, requestTs: true, metadata: true },
          orderBy: { requestTs: 'asc' },
          take: 50,
        })
        .catch(() => []),
      Promise.resolve(shadowListDiagnostics()),
    ]);

    // Does each number on the pilot list belong to an account that has
    // written to us? A week of shadow turns that never starts looks exactly
    // like a quiet week, and the difference between them is this lookup
    // (2026-09-18: the first pilot week read zero turns and nothing on the
    // card could say whether the list was wrong or the founder simply had
    // not messaged since it was set).
    const pilotWaIds = shadowListRaw.map((s) => s.waId).filter(Boolean);
    const pilotAccounts = pilotWaIds.length
      ? await prisma.account
          .findMany({ where: { waId: { in: pilotWaIds } }, select: { id: true, waId: true } })
          .catch(() => [])
      : [];

    const byRole = Object.fromEntries((turns || []).map((t) => [t.role, t._count?._all || 0]));
    const inbound = byRole.user || 0;

    const agent = (agentRows || []).filter((r) => r.path === 'agent');
    const guard = (agentRows || []).filter((r) => r.path !== 'agent');
    const latencies = agent.map((r) => r.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const tokensIn = agent.reduce((s, r) => s + (r.inputTokens || 0), 0);
    const tokensOut = agent.reduce((s, r) => s + (r.outputTokens || 0), 0);

    const outcomes = {};
    for (const r of agent) outcomes[r.outcome || 'unknown'] = (outcomes[r.outcome || 'unknown'] || 0) + 1;

    // Gates are the safety signal the promotion gate is measured on: a week of
    // shadow turns with no gate firing on money copy is what opens Phase 3.
    const gates = {};
    for (const r of agentRows || []) {
      const fired = Array.isArray(r.gatesFired) ? r.gatesFired : [];
      for (const g of fired) gates[String(g)] = (gates[String(g)] || 0) + 1;
    }

    const errors = {};
    for (const r of agent) if (r.error) errors[String(r.error)] = (errors[String(r.error)] || 0) + 1;

    const accounts = new Set(agent.map((r) => r.accountId).filter(Boolean));
    const models = [...new Set(agent.map((r) => r.model).filter(Boolean))];

    const now = Date.now();
    const parkedRows = (parked || []).map((p) => {
      const m = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
      return {
        reference: m.reference || null,
        status: p.status,
        method: m.method || null,
        amountCents: m.amountCents ?? null,
        feeCents: m.feeCents ?? null,
        ageMinutes: Math.round((now - new Date(p.requestTs).getTime()) / 60000),
        lastCheckedAt: m.lastCheckedAt || null,
      };
    });

    // What the parked pay-outs are holding of the customers' money, and what
    // the oldest one has been waiting. Both are what a human chases; the
    // supplier float they are drawn against is its own card, because reading
    // it is an HTTP call to OTT with a different failure profile.
    const heldCents = parkedRows.reduce((sum, p) => sum + (p.amountCents || 0) + (p.feeCents || 0), 0);
    const oldestMinutes = parkedRows.length ? Math.max(...parkedRows.map((p) => p.ageMinutes || 0)) : null;

    // The promotion gate, as a number rather than a judgement: how long the
    // agent has been answering real customers with no money gate firing. The
    // clock starts at the first agent turn and is RESET by the newest money
    // gate, because a week that contains a RECEIPT, PARTNER or BETTING block
    // is not a clean week (docs/AGENT_ARCHITECTURE_V2.md 13).
    const MONEY_GATES = ['RECEIPT', 'PARTNER', 'BETTING'];
    const firedMoneyGateAt = (agentRows || [])
      .filter((r) => (Array.isArray(r.gatesFired) ? r.gatesFired : []).some((g) => MONEY_GATES.includes(String(g))))
      .map((r) => new Date(r.createdAt).getTime());
    const agentTimes = agent.map((r) => new Date(r.createdAt).getTime());
    const firstAgentTurnAt = agentTimes.length ? Math.min(...agentTimes) : null;
    const lastMoneyGateAt = firedMoneyGateAt.length ? Math.max(...firedMoneyGateAt) : null;
    const cleanSince = firstAgentTurnAt === null ? null : Math.max(firstAgentTurnAt, lastMoneyGateAt || 0);
    const cleanDays = cleanSince === null ? 0 : Math.floor((now - cleanSince) / DAY_MS);

    const accountByWaId = new Map((pilotAccounts || []).map((a) => [a.waId, a.id]));
    const agentTurnsByAccount = {};
    for (const r of agentRows || []) {
      if (r.accountId) agentTurnsByAccount[r.accountId] = (agentTurnsByAccount[r.accountId] || 0) + 1;
    }
    const pilotEntries = shadowListRaw.map((entry) => {
      const accountId = entry.waId ? accountByWaId.get(entry.waId) || null : null;
      return {
        tail: entry.tail,
        // A number the product cannot read is the loudest possible reason a
        // pilot week is empty, so it is stated, not inferred.
        valid: entry.valid,
        hasAccount: Boolean(accountId),
        turnsInWindow: accountId ? agentTurnsByAccount[accountId] || 0 : 0,
      };
    });
    const shadowCount = shadowListRaw.length;

    return res.status(200).json({
      windowDays: days,
      since: since.toISOString(),
      conversation: {
        inbound,
        outbound: byRole.assistant || 0,
        events: byRole.event || 0,
      },
      agent: {
        turns: agent.length,
        guardTurns: guard.length,
        customers: accounts.size,
        shareOfInboundPct: pct(agent.length, inbound),
        outcomes,
        errors,
        models,
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        maxMs: latencies.length ? latencies[latencies.length - 1] : null,
        tokensIn,
        tokensOut,
        costUsd: PRICE_IN || PRICE_OUT ? round4(costUsd(tokensIn, tokensOut)) : null,
        costPerTurnUsd: agent.length && (PRICE_IN || PRICE_OUT) ? round4(costUsd(tokensIn, tokensOut) / agent.length) : null,
        costZar: USD_ZAR && (PRICE_IN || PRICE_OUT) ? round4(costUsd(tokensIn, tokensOut) * USD_ZAR) : null,
        costPerTurnZar: USD_ZAR && agent.length && (PRICE_IN || PRICE_OUT) ? round4((costUsd(tokensIn, tokensOut) / agent.length) * USD_ZAR) : null,
        priced: Boolean(PRICE_IN || PRICE_OUT),
      },
      gates,
      // The gates that decide promotion. The list lives here, not in the
      // console, because the console must carry none of these words as copy.
      gateWatch: ['RECEIPT', 'PARTNER', 'BETTING'],
      shadow: {
        count: shadowCount,
        live: shadowCount > 0,
        entries: pilotEntries,
        // What the promotion gate actually needs, so nobody has to derive it
        // from the numbers above: whole clean days so far, and whether the
        // clock has started at all.
        started: firstAgentTurnAt !== null,
        firstTurnAt: firstAgentTurnAt ? new Date(firstAgentTurnAt).toISOString() : null,
        moneyGateFired: firedMoneyGateAt.length > 0,
        cleanDays,
        cleanDaysNeeded: 7,
      },
      payouts: { parked: parkedRows.length, heldCents, oldestMinutes, rows: parkedRows.slice(0, 12) },
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_conversations_error', error: error?.message }));
    return res.status(500).json({ error: 'UNAVAILABLE', message: error?.message || 'failed' });
  }
}
