/**
 * Interactive charts for Mission Control (founder, 2026-10-20: "live interactive graphs, no
 * static graphs", and the dashboard must work on a phone). Built on recharts: every chart is
 * responsive to its container, every point answers a hover or a tap with a tooltip, and the
 * legends are clickable. The props are the ones the old static SVG components took, so the
 * tabs that use them did not change. Colours come from the page's CSS variables.
 */
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceDot } from 'recharts';
import { fmtR, simulate, preset, budgetFn, BUDGET_DEFAULT } from './scale-model.js';

const rands = (cents, d = 0) => 'R' + (Number(cents || 0) / 100).toLocaleString('en-ZA', { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}m` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)));
const TIP = { contentStyle: { background: 'var(--surface, #fff)', border: '1px solid var(--glass-edge, #ddd)', borderRadius: 10, fontSize: 12, color: 'var(--ink)', boxShadow: 'var(--shadow)' }, labelStyle: { color: 'var(--ink2)', fontWeight: 600 }, itemStyle: { color: 'var(--ink)' }, cursor: { stroke: 'var(--grid)' } };
const AXIS = { tick: { fontSize: 10.5, fill: 'var(--ink3)' }, axisLine: false, tickLine: false };
const DEFAULT_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--good)'];

function Frame({ h = 190, children }) {
  return (
    <div style={{ width: '100%', height: h, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

/** Daily bars: series [{ k: 'YYYY-MM-DD', v }] */
export function Bars({ series, color = 'var(--accent)', fmt = (v) => v, h = 150 }) {
  if (!series?.length) return <div className="empty">No data yet.</div>;
  const data = series.map((s) => ({ k: String(s.k).slice(5), full: s.k, v: s.v || 0 }));
  return (
    <Frame h={h}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
        <XAxis dataKey="k" {...AXIS} interval="preserveStartEnd" minTickGap={18} />
        <YAxis {...AXIS} width={44} tickFormatter={(v) => fmt(v)} />
        <Tooltip {...TIP} formatter={(v) => [fmt(v), 'value']} labelFormatter={(l, p) => p?.[0]?.payload?.full || l} />
        <Bar dataKey="v" fill={color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </Frame>
  );
}

/** Money in / spent / transferred per week: weekly [{ wk, in, spend, transfer }] in cents */
export function WeeklyFlows({ weekly, h = 200 }) {
  if (!weekly?.length) return <div className="empty">No money movement in this period yet.</div>;
  const data = [...weekly].sort((a, b) => a.wk.localeCompare(b.wk)).slice(-14).map((w) => ({ wk: w.wk.slice(5), full: w.wk, in: w.in || 0, spend: w.spend || 0, transfer: w.transfer || 0 }));
  return (
    <Frame h={h}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
        <XAxis dataKey="wk" {...AXIS} interval="preserveStartEnd" minTickGap={18} />
        <YAxis {...AXIS} width={56} tickFormatter={(v) => rands(v)} />
        <Tooltip {...TIP} formatter={(v, name) => [rands(v, 2), name]} labelFormatter={(l, p) => `week of ${p?.[0]?.payload?.full || l}`} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="in" name="Money in" fill="var(--s1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="spend" name="Spent" fill="var(--s2)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="transfer" name="Transferred" fill="var(--s3)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </Frame>
  );
}

/** Net revenue as a % of money moved, per week */
export function TakeRate({ revenueWeekly, flowsWeekly, h = 150 }) {
  const flowByWk = new Map((flowsWeekly || []).map((f) => [f.wk, (f.in || 0) + (f.spend || 0) + (f.transfer || 0)]));
  const data = (revenueWeekly || [])
    .map((r) => ({ wk: r.wk.slice(5), full: r.wk, pct: flowByWk.get(r.wk) ? (100 * r.cents) / flowByWk.get(r.wk) : null }))
    .filter((p) => p.pct != null)
    .sort((a, b) => a.full.localeCompare(b.full))
    .slice(-14);
  if (!data.length) return <div className="empty">Not enough data yet.</div>;
  return (
    <Frame h={h}>
      <LineChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
        <XAxis dataKey="wk" {...AXIS} interval="preserveStartEnd" />
        <YAxis {...AXIS} width={40} tickFormatter={(v) => `${v.toFixed(0)}%`} domain={[0, (max) => Math.max(5, Math.ceil(max))]} />
        <Tooltip {...TIP} formatter={(v) => [`${Number(v).toFixed(2)}%`, 'take rate']} labelFormatter={(l, p) => `week of ${p?.[0]?.payload?.full || l}`} />
        <Line type="monotone" dataKey="pct" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

/** Stacked weekly bars by source: rows [{ wk, src, n }]; colors { src: cssColor } */
export function StackBars({ rows, colors = {}, h = 170 }) {
  if (!rows?.length) return <div className="empty">No data yet.</div>;
  const weeks = [...new Set(rows.map((r) => r.wk))].sort().slice(-16);
  const srcs = [...new Set(rows.map((r) => r.src))];
  const byWk = new Map(weeks.map((w) => [w, { wk: w.slice(5), full: w }]));
  for (const r of rows) if (byWk.has(r.wk)) byWk.get(r.wk)[r.src] = (byWk.get(r.wk)[r.src] || 0) + r.n;
  const data = weeks.map((w) => byWk.get(w));
  return (
    <Frame h={h}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
        <XAxis dataKey="wk" {...AXIS} interval="preserveStartEnd" minTickGap={18} />
        <YAxis {...AXIS} width={36} allowDecimals={false} />
        <Tooltip {...TIP} labelFormatter={(l, p) => `week of ${p?.[0]?.payload?.full || l}`} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {srcs.map((sc, i) => <Bar key={sc} dataKey={sc} stackId="a" fill={colors[sc] || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} isAnimationActive={false} />)}
      </BarChart>
    </Frame>
  );
}

/** One series of daily bars: rows [{ date, ... }], pick(row) → value */
export function DailyBars({ rows, pick, fmt = (v) => v, h = 150, color = 'var(--s1)' }) {
  if (!rows?.length) return <div className="empty">No days in this period yet.</div>;
  const data = rows.map((r) => ({ date: String(r.date).slice(5), full: r.date, v: pick(r) || 0 }));
  return (
    <Frame h={h}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
        <XAxis dataKey="date" {...AXIS} interval="preserveStartEnd" minTickGap={18} />
        <YAxis {...AXIS} width={44} tickFormatter={(v) => fmt(v)} />
        <Tooltip {...TIP} formatter={(v) => [fmt(v), 'value']} labelFormatter={(l, p) => p?.[0]?.payload?.full || l} />
        <Bar dataKey="v" fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </Frame>
  );
}

/** Several daily lines: rows [{ date, k1, k2 }], series [{ key, name, color }] */
export function DailyLines({ rows, series, h = 160 }) {
  if (!rows?.length) return <div className="empty">No days in this period yet.</div>;
  const data = rows.map((r) => ({ ...r, label: String(r.date).slice(5) }));
  return (
    <Frame h={h}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={18} />
        <YAxis {...AXIS} width={36} allowDecimals={false} />
        <Tooltip {...TIP} labelFormatter={(l, p) => p?.[0]?.payload?.date || l} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 5 }} isAnimationActive={false} />)}
      </LineChart>
    </Frame>
  );
}

/**
 * The path: accounts so far (solid), today's pace carried forward (dashed), compounding once two
 * full weeks exist (dotted), and the plan's point at the horizon (ring). Tap any point.
 * series [{ date, accounts, newAccounts }]; t = growth.trajectory
 */
export function PathChart({ series, t, h = 230 }) {
  if (!t || !series?.length) return <div className="empty">No accounts yet.</div>;
  const n = series.length;
  const horizonDays = t.monthsAhead * 30;
  const flat = Array.from({ length: Math.ceil(horizonDays / 7) + 1 }, (_, i) => ({ d: Math.min(horizonDays, i * 7), v: t.now.accounts + t.perDay.accounts * Math.min(horizonDays, i * 7) }));
  const g = t.weeklyGrowth;
  const comp = g != null ? flat.map(({ d }, i) => { let acc = t.now.accounts, wk = t.last7.accounts; for (let w = 0; w < i; w++) { wk *= 1 + g; acc += wk; } return { d, v: acc }; }) : null;
  const data = [
    ...series.map((p, i) => ({ i, label: p.date, actual: p.accounts, newAccounts: p.newAccounts })),
    ...flat.map((p, j) => ({ i: n - 1 + p.d, label: p.d === 0 ? 'today' : `+${p.d} days`, flat: Math.round(p.v), comp: comp ? Math.round(comp[j].v) : undefined })),
  ].sort((a, b) => a.i - b.i);
  // the point "today" carries both the last actual and the start of the projections
  const end = n - 1 + horizonDays;
  const ticks = [0, Math.floor((n - 1) / 2), n - 1, Math.round((n - 1 + end) / 2), end].filter((v, i, a) => a.indexOf(v) === i);
  const tickLabel = (i) => (i < n ? String(series[i].date).slice(5) : i === n - 1 ? 'today' : i >= end - 1 ? t.horizon.label : `+${i - (n - 1)}d`);
  const plan = t.plan?.ahead?.accounts;
  return (
    <div>
      <Frame h={h}>
        <LineChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
          <XAxis dataKey="i" type="number" domain={[0, end]} ticks={ticks} tickFormatter={tickLabel} {...AXIS} />
          <YAxis {...AXIS} width={44} tickFormatter={compact} allowDecimals={false} />
          <Tooltip {...TIP} labelFormatter={(i, p) => p?.[0]?.payload?.label || tickLabel(i)} formatter={(v, name, item) => [Number(v).toLocaleString('en-ZA') + (name === 'accounts, all time' && item?.payload?.newAccounts != null ? ` (+${item.payload.newAccounts} that day)` : ''), name]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="actual" name="accounts, all time" stroke="var(--good)" strokeWidth={2.4} dot={n <= 60 ? { r: 2.5 } : false} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
          <Line type="monotone" dataKey="flat" name="today's pace" stroke="var(--s1)" strokeWidth={1.8} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
          {comp && <Line type="monotone" dataKey="comp" name="compounding" stroke="var(--s4)" strokeWidth={1.8} strokeDasharray="2 3" dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />}
          {plan != null && <ReferenceDot x={end} y={plan} r={5} fill="none" stroke="var(--ink3)" strokeWidth={1.5} label={{ value: `plan ${compact(plan)}`, position: 'left', fontSize: 10, fill: 'var(--ink3)' }} />}
        </LineChart>
      </Frame>
    </div>
  );
}

/** The valuation path: the plan, the model on measured inputs, and today's pace held flat; tap any month. t = trajectory, v = valuation */
export function ValuationPath({ t, v, h = 210 }) {
  if (!t) return null;
  const planRows = simulate(preset('plan'), budgetFn(BUDGET_DEFAULT)).rows.slice(0, 13);
  const measuredInputs = Object.fromEntries((v?.measuredUsed || []).map((u) => [u.key, u.value]));
  const modelRows = Object.keys(measuredInputs).length ? simulate({ ...preset('plan'), ...measuredInputs }, budgetFn(BUDGET_DEFAULT)).rows.slice(0, 13) : null;
  const worthOf = (r) => Math.max(r.valRev, r.valActive);
  const pace = (() => {
    const revMonthRand = (t.perDay.revenueCents * 30) / 100;
    const actives = Math.max(t.now.actives, t.perDay.funded * 30);
    return Math.max(t.frames.floorRand, revMonthRand * 12 * t.frames.multiple, actives * t.frames.perActive);
  })();
  const monthLabel = (m) => new Date(Date.UTC(2026, 9 + (m - 1), 1)).toLocaleString('en-ZA', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const data = planRows.map((r, i) => ({ m: r.m, label: monthLabel(r.m), plan: Math.round(worthOf(r)), model: modelRows ? Math.round(worthOf(modelRows[i])) : undefined, pace: Math.round(pace), accounts: Math.round(r.cumOnb || 0) }));
  return (
    <Frame h={h}>
      <LineChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="2 4" />
        <XAxis dataKey="label" {...AXIS} interval={2} />
        <YAxis {...AXIS} width={52} tickFormatter={(x) => fmtR(x)} />
        <Tooltip {...TIP} formatter={(x, name) => [fmtR(x), name]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="plan" name="the plan" stroke="var(--ink3)" strokeWidth={1.8} strokeDasharray="5 4" dot={{ r: 2.5 }} activeDot={{ r: 5 }} isAnimationActive={false} />
        {modelRows && <Line type="monotone" dataKey="model" name="model on measured inputs" stroke="var(--s1)" strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 5 }} isAnimationActive={false} />}
        <Line type="monotone" dataKey="pace" name="today's pace" stroke="var(--good)" strokeWidth={2.4} dot={{ r: 2.5 }} activeDot={{ r: 5 }} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}
