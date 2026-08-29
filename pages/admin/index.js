/**
 * WaPay Mission Control — the admin console (founder green-light 2026-08-28).
 *
 * One page, three states: login (WhatsApp OTP) → dashboard (live metrics
 * from /api/admin/metrics) + customer lookup (/api/admin/customer).
 * Design north star: the "WaPay Mission Control" mockup artifact; this page
 * renders the same identity against real ledger data.
 *
 * The page itself contains NO data and NO secrets — everything sensitive
 * arrives via the session-gated APIs after OTP login.
 */

import { useEffect, useState, useCallback } from 'react';
import Head from 'next/head';

const R = (c) => 'R' + (Math.round(c || 0) / 100).toLocaleString('en-ZA', { maximumFractionDigits: 2 });
const Rw = (c) => 'R' + Math.round((c || 0) / 100).toLocaleString('en-ZA');
const dt = (s) => (s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--edge:rgba(11,11,11,.10);--ink:#0b0b0b;
--ink2:#52514e;--ink3:#898781;--grid:#e1e0d9;--accent:#1d7a3f;--accent-ink:#14512c;--accent-soft:#e7f1ea;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--good:#0ca30c;--crit:#d03b3b;--up:#006300;--down:#b3362a}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;
--edge:rgba(255,255,255,.10);--ink:#fff;--ink2:#c3c2b7;--ink3:#898781;--grid:#2c2c2a;--accent:#55b47f;
--accent-ink:#8ed3ac;--accent-soft:#1b2b21;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--up:#0ca30c;--down:#e66767}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:400 14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 20px 80px}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.brand b{color:var(--accent);font-weight:750}.brand{font-size:18px;font-weight:750}
.spacer{flex:1}
.tabs{display:flex;gap:4px;background:var(--surface);border:1px solid var(--edge);border-radius:10px;padding:3px}
.tabs button{border:0;background:transparent;color:var(--ink2);font:600 12.5px system-ui;padding:6px 13px;border-radius:8px;cursor:pointer}
.tabs button.on{background:var(--accent);color:#fff}
.linkish{border:0;background:none;color:var(--ink3);font-size:12px;cursor:pointer;text-decoration:underline}
.grid{display:grid;gap:14px}.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.two{grid-template-columns:1fr 1fr}@media(max-width:860px){.two{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--edge);border-radius:12px;padding:16px 18px;min-width:0}
.card h2{font-size:13.5px;font-weight:700;margin:0 0 2px}
.note{font-size:11.5px;color:var(--ink3);margin:0 0 10px}
.k{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3)}
.v{font-size:25px;font-weight:650;margin-top:3px}
.vs{font-size:11.5px;color:var(--ink3);margin-top:3px}
.login{max-width:360px;margin:9vh auto 0}
.login input{width:100%;padding:11px 12px;border:1px solid var(--edge);border-radius:9px;background:var(--page);color:var(--ink);font-size:15px;margin:6px 0 12px}
.login button.go{width:100%;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:650 14px system-ui;cursor:pointer}
.err{color:var(--crit);font-size:12.5px;margin-top:8px}
.searchrow{display:flex;gap:8px}
.searchrow input{flex:1;padding:10px 12px;border:1px solid var(--edge);border-radius:9px;background:var(--page);color:var(--ink);font-size:14px}
.searchrow button{padding:10px 16px;border:0;border-radius:9px;background:var(--accent);color:#fff;font-weight:650;cursor:pointer}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--ink3);font-weight:600;padding:5px 10px 5px 0;border-bottom:1px solid var(--grid);white-space:nowrap}
td{padding:5px 10px 5px 0;border-bottom:1px solid var(--grid)}
td.n,th.n{text-align:right}
.pill{display:inline-block;font-size:10.5px;font-weight:650;border-radius:99px;padding:2px 8px}
.pill.g{background:color-mix(in srgb,var(--good) 12%,transparent);color:var(--up)}
.pill.y{background:color-mix(in srgb,var(--s4) 14%,transparent);color:var(--ink2)}
.pill.r{background:color-mix(in srgb,var(--crit) 12%,transparent);color:var(--crit)}
.idrow{display:grid;grid-template-columns:auto 1fr;gap:3px 16px;font-size:12.5px}
.idrow .l{color:var(--ink3)}
.bal{font-size:22px;font-weight:650}
svg{display:block;width:100%}
svg text{font:500 10.5px system-ui;fill:var(--ink3)}
.empty{color:var(--ink3);font-size:12.5px;padding:14px 0}

.ops{display:flex;gap:8px;flex-wrap:wrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
`;

function Bars({ series, color = 'var(--accent)', fmt = (v) => v }) {
  if (!series?.length) return <div className="empty">No data yet.</div>;
  const W = 560, H = 150, L = 8, B = 20, T = 14;
  const mx = Math.max(...series.map((s) => s.v)) || 1;
  const bw = Math.min(24, ((W - L) / series.length) * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      {series.map((s, i) => {
        const x = L + ((W - L) * (i + 0.5)) / series.length - bw / 2;
        const h = ((H - T - B) * s.v) / mx;
        return (
          <g key={s.k}>
            <path d={`M${x} ${H - B} L${x} ${H - B - h + 4} Q${x} ${H - B - h} ${x + 4} ${H - B - h} L${x + bw - 4} ${H - B - h} Q${x + bw} ${H - B - h} ${x + bw} ${H - B - h + 4} L${x + bw} ${H - B} Z`} fill={color}>
              <title>{`${s.k}: ${fmt(s.v)}`}</title>
            </path>
            {(series.length <= 8 || i % 2 === 0) && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle">{s.k.slice(5)}</text>
            )}
            {i === series.length - 1 && (
              <text x={x + bw / 2} y={H - B - h - 5} textAnchor="middle" style={{ fontWeight: 650, fill: 'var(--ink)' }}>{fmt(s.v)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function HBars({ rows, fmt = Rw }) {
  if (!rows?.length) return <div className="empty">No data yet.</div>;
  const mx = Math.max(...rows.map((r) => r.v)) || 1;
  return (
    <div>
      {rows.map((r) => (
        <div key={r.k} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 90px', gap: 10, alignItems: 'center', margin: '7px 0' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink2)', textAlign: 'right' }}>{r.k}</span>
          <div><div style={{ width: `${Math.max(3, (100 * r.v) / mx)}%`, height: 16, background: r.c || 'var(--accent)', borderRadius: '0 4px 4px 0' }} /></div>
          <b style={{ fontSize: 12.5 }}>{fmt(r.v)}</b>
        </div>
      ))}
    </div>
  );
}

function WeeklyFlows({ weekly }) {
  // Money in / spent / transferred, per week. Grouped bars, one group per week.
  if (!weekly?.length) return <div className="empty">No money movement in this period yet.</div>;
  const wks = [...weekly].sort((a, b) => a.wk.localeCompare(b.wk)).slice(-14);
  const W = 620, H = 190, L = 46, B = 26, T = 14;
  const mx = Math.max(...wks.flatMap((w) => [w.in, w.spend, w.transfer])) || 1;
  const series = [['in', 'Money in', 'var(--s1)'], ['spend', 'Spent', 'var(--s2)'], ['transfer', 'Transferred', 'var(--s3)']];
  const slot = (W - L - 10) / wks.length;
  const bw = Math.min(9, (slot - 6) / 3);
  const y = (v) => T + (H - T - B) * (1 - v / mx);
  return (
    <>
      <div className="note" style={{ display: 'flex', gap: 14 }}>
        {series.map(([k, label, c]) => (
          <span key={k}><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: c, marginRight: 5, verticalAlign: -1 }} />{label}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {[0, mx / 2, mx].map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - 10} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end">{'R' + Math.round(v / 100).toLocaleString('en-ZA')}</text>
          </g>
        ))}
        {wks.map((w, i) => (
          <g key={w.wk}>
            {series.map(([k, label, c], si) => {
              const v = w[k] || 0;
              const x = L + slot * i + 3 + si * (bw + 2);
              const h = Math.max(0, (H - T - B) * (v / mx));
              return h > 0 ? <rect key={k} x={x} y={H - B - h} width={bw} height={h} rx={2} fill={c}><title>{`${w.wk} · ${label}: R${(v / 100).toFixed(2)}`}</title></rect> : null;
            })}
            {(wks.length <= 8 || i % 2 === 0) && <text x={L + slot * i + slot / 2} y={H - 8} textAnchor="middle">{w.wk.slice(5)}</text>}
          </g>
        ))}
      </svg>
    </>
  );
}

function TakeRate({ revenueWeekly, flowsWeekly }) {
  // Net revenue as a % of the money that moved, per week. One series, so no
  // legend: the heading names it.
  const flowByWk = new Map((flowsWeekly || []).map((f) => [f.wk, (f.in || 0) + (f.spend || 0) + (f.transfer || 0)]));
  const pts = (revenueWeekly || [])
    .map((r) => ({ wk: r.wk, pct: flowByWk.get(r.wk) ? (100 * r.cents) / flowByWk.get(r.wk) : null }))
    .filter((p) => p.pct != null)
    .sort((a, b) => a.wk.localeCompare(b.wk))
    .slice(-14);
  if (!pts.length) return <div className="empty">Not enough data yet.</div>;
  const W = 300, H = 130, L = 34, B = 22, T = 12;
  const mx = Math.max(5, Math.ceil(Math.max(...pts.map((p) => p.pct))));
  const x = (i) => L + (W - L - 24) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / mx);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.pct).toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      {[0, mx / 2, mx].map((v, i) => (
        <g key={i}>
          <line x1={L} x2={W - 24} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
          <text x={L - 6} y={y(v) + 4} textAnchor="end">{v.toFixed(0)}%</text>
        </g>
      ))}
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => <circle key={p.wk} cx={x(i)} cy={y(p.pct)} r="3.5" fill="var(--accent)"><title>{`${p.wk}: ${p.pct.toFixed(2)}%`}</title></circle>)}
      <text x={x(pts.length - 1)} y={y(last.pct) - 8} textAnchor="end" style={{ fontWeight: 650, fill: 'var(--ink)' }}>{last.pct.toFixed(1)}%</text>
    </svg>
  );
}

function OpsHealth({ ops }) {
  if (!ops) return <div className="empty">Health checks unavailable.</div>;
  const pill = (ok, label, detail) => (
    <span key={label} className="pill" style={{ borderColor: ok === false ? 'var(--crit)' : undefined, color: ok === false ? 'var(--crit)' : 'var(--ink2)' }}>
      <span className="dot" style={{ background: ok === null ? 'var(--ink3)' : ok ? 'var(--good)' : 'var(--crit)' }} />
      {label}{detail ? ` · ${detail}` : ''}
    </span>
  );
  const drift = ops.walletDriftCents;
  return (
    <div className="ops">
      {pill(ops.trialBalanced, 'Trial balance', ops.trialBalanced === false ? `off by ${R(Math.abs(ops.trialDifferenceCents))}` : 'balanced')}
      {pill(drift === null ? null : drift === 0, 'Wallets = journal', drift === null ? 'unknown' : drift === 0 ? `R0.00 drift · ${ops.walletsChecked} checked` : `${R(drift)} drift`)}
      {pill(ops.stuckHolds === 0 || ops.stuckHolds === null, 'Stuck holds', ops.stuckHolds === null ? 'unknown' : String(ops.stuckHolds))}
      {pill(true, 'Active holds', String(ops.activeHolds ?? 0))}
    </div>
  );
}

function Floats() {
  // Own endpoint + own fetch: supplier HTTP calls have a different latency
  // and failure profile than the DB aggregates behind /api/admin/metrics.
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/floats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setF(d); })
      .catch(() => { if (!cancelled) setErr('Could not load supplier floats.'); });
    return () => { cancelled = true; };
  }, []);
  if (err) return <div className="empty">{err}</div>;
  if (!f) return <div className="empty">Asking suppliers…</div>;
  const pill = (ok, label, detail) => (
    <span key={label} className="pill" style={{ borderColor: ok === false ? 'var(--crit)' : undefined, color: ok === false ? 'var(--crit)' : 'var(--ink2)' }}>
      <span className="dot" style={{ background: ok === null ? 'var(--ink3)' : ok ? 'var(--good)' : 'var(--crit)' }} />
      {label}{detail ? ` · ${detail}` : ''}
    </span>
  );
  const apiLabel = (row) => {
    if (!row.api) return null;
    if (!row.api.configured) return 'credentials not set';
    if (row.api.error) return `unavailable (${row.api.error})`;
    return null;
  };
  return (
    <div>
      {(f.floats || []).map((row) => (
        <div key={row.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) 1fr 1fr 1.4fr', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--grid)' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{row.name}</div>
            <div style={{ fontSize: 11, color: 'var(--ink3)' }}>{row.note}</div>
          </div>
          <div style={{ fontSize: 12.5 }}>
            <span style={{ color: 'var(--ink3)' }}>supplier </span>
            <b>{row.api?.availableCents != null ? R(row.api.availableCents) : apiLabel(row) || 'no API'}</b>
          </div>
          <div style={{ fontSize: 12.5 }}>
            <span style={{ color: 'var(--ink3)' }}>ledger </span>
            <b>{row.ledgerCents != null ? R(row.ledgerCents) : '—'}</b>
          </div>
          <div className="ops" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {row.low != null && pill(!row.low, row.low ? 'LOW FLOAT' : 'Float ok', `warn under ${R(row.warnCents)}`)}
            {row.driftCents != null && pill(null, 'Drift',
              row.driftCents === 0 ? 'none' : `${R(Math.abs(row.driftCents))} ${row.driftCents > 0 ? 'supplier ahead' : 'ledger ahead'}`)}
            {row.ledgerRail && f.ledgerAvailable === false && pill(null, 'Ledger unavailable', '')}
            {row.api && !row.api.configured && pill(null, 'Awaiting credentials', '')}
            {row.api?.error && pill(false, 'Supplier check failed', row.api.error)}
          </div>
        </div>
      ))}
      <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
        Ledger = net CLEARING position from the journal (negative = WaPay owes the supplier). Float top-up transfers are not journaled yet, so a prepaid supplier's live float and ledger position legitimately differ; drift compares them where both exist. Cached ~60s.
      </p>
    </div>
  );
}

function UniFuelPanel() {
  const [u, setU] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/unifuel')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setU(d); })
      .catch(() => { if (!cancelled) setErr('Could not load UniFuel stats.'); });
    return () => { cancelled = true; };
  }, []);
  if (err) return <div className="empty">{err}</div>;
  if (!u) return <div className="empty">Asking UniFuel…</div>;
  if (!u.configured) return <div className="empty">UniFuel link not configured yet (UNIFUEL_API_BASE_URL + UNIFUEL_PARTNER_SECRET).</div>;
  const s = u.stats;
  return (
    <div>
      {(u.stats?.testMode || u.catalog?.testMode) && (
        <p className="note" style={{ color: 'var(--crit)', fontWeight: 600 }}>
          Yoyo TEST environment — these wiCodes do not redeem at real stations.
        </p>
      )}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12.5 }}>
        <div><span style={{ color: 'var(--ink3)' }}>wiCodes issued </span><b>{s ? s.issuance.count : '—'}</b></div>
        <div><span style={{ color: 'var(--ink3)' }}>issued value </span><b>{s ? R(s.issuance.cents) : '—'}</b></div>
        <div><span style={{ color: 'var(--ink3)' }}>redemptions </span><b>{s ? s.redemptions.count : '—'}</b></div>
        <div><span style={{ color: 'var(--ink3)' }}>redeemed value </span><b>{s ? R(s.redemptions.cents) : '—'}</b></div>
      </div>
      {u.stats?.truncated && (
        <p className="note" style={{ marginTop: 8 }}>
          Showing the most recent 1000 orders only — older issuance is not counted here.
        </p>
      )}
      {u.catalog?.products?.length > 0 && (
        <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
          Live catalogue: {u.catalog.products
            .map((p) => `${p.name}${Number.isInteger(p.minCents) && Number.isInteger(p.maxCents) ? ` (${Rw(p.minCents)}–${Rw(p.maxCents)})` : ''}`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

function Funnel({ f }) {
  if (!f || f.accounts == null) return <div className="empty">No data yet.</div>;
  const stages = [
    ['Contacts', f.contacts, 'accounts + captured pay-link payers'],
    ['Accounts', f.accounts, 'onboarded'],
    ['Funded', f.funded, 'first money in'],
    ['Transacting', f.transacting, 'first spend or send'],
    ['Repeat', f.repeat, '2+ money events in 30d'],
  ].filter(([, v]) => v != null);
  const top = stages[0]?.[1] || 1;
  const shades = ['#6bbf92', '#4dae77', '#31995e', '#1d7a3f', '#14512c'];
  return (
    <div>
      {stages.map(([k, v, note], i) => (
        <div key={k}>
          {i > 0 && stages[i - 1][1] > 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink3)', margin: '0 0 2px 160px' }}>
              ↳ {Math.round((100 * v) / stages[i - 1][1])}% of {stages[i - 1][0].toLowerCase()}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 130px', gap: 10, alignItems: 'center', margin: '5px 0' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink2)', textAlign: 'right' }}>{k}</span>
            <div><div style={{ width: `${Math.max(3, (100 * v) / top)}%`, height: 20, background: shades[i], borderRadius: '0 4px 4px 0' }} title={note} /></div>
            <span style={{ fontSize: 12.5 }}><b>{v.toLocaleString()}</b> <span style={{ color: 'var(--ink3)' }}>· {Math.round((100 * v) / top)}%</span></span>
          </div>
        </div>
      ))}
    </div>
  );
}

const SRC_COLORS = { organic: 'var(--s1)', paylink: 'var(--s2)', referral: 'var(--s3)' };
function StackBars({ rows }) {
  // rows: [{wk, src, n}] → stacked weekly bars by acquisition source.
  if (!rows?.length) return <div className="empty">No data yet.</div>;
  const weeks = [...new Set(rows.map((r) => r.wk))].sort().slice(-16);
  const srcs = [...new Set(rows.map((r) => r.src))];
  const byWk = new Map(weeks.map((w) => [w, {}]));
  for (const r of rows) if (byWk.has(r.wk)) byWk.get(r.wk)[r.src] = (byWk.get(r.wk)[r.src] || 0) + r.n;
  const W = 560, H = 160, L = 8, B = 20, T = 14;
  const mx = Math.max(...weeks.map((w) => Object.values(byWk.get(w)).reduce((a, b) => a + b, 0))) || 1;
  const bw = Math.min(24, ((W - L) / weeks.length) * 0.6);
  return (
    <>
      <div className="note" style={{ display: 'flex', gap: 14 }}>
        {srcs.map((sc) => (
          <span key={sc}><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: SRC_COLORS[sc] || 'var(--s4)', marginRight: 5, verticalAlign: -1 }} />{sc}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {weeks.map((w, i) => {
          const x = L + ((W - L) * (i + 0.5)) / weeks.length - bw / 2;
          let base = 0;
          const total = Object.values(byWk.get(w)).reduce((a, b) => a + b, 0);
          return (
            <g key={w}>
              {srcs.map((sc) => {
                const v = byWk.get(w)[sc] || 0;
                if (!v) return null;
                const h = ((H - T - B) * v) / mx;
                const y0 = H - B - base - h;
                base += h + 2;
                return <rect key={sc} x={x} y={y0} width={bw} height={h} rx={2} fill={SRC_COLORS[sc] || 'var(--s4)'}><title>{`${w} · ${sc}: ${v}`}</title></rect>;
              })}
              {total > 0 && <text x={x + bw / 2} y={H - B - base - 4} textAnchor="middle" style={{ fontWeight: 650, fill: 'var(--ink)' }}>{total}</text>}
              {(weeks.length <= 8 || i % 2 === 0) && <text x={x + bw / 2} y={H - 6} textAnchor="middle">{w.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
    </>
  );
}

function Cohorts({ c }) {
  if (!c?.sizes?.length) return <div className="empty">No cohorts yet.</div>;
  const sizes = c.sizes.slice(-8);
  const act = new Map();
  for (const a of c.activity || []) act.set(`${a.cohort}|${a.offsetWk}`, a.n);
  const maxWk = 8;
  const shade = (p) => p == null ? 'transparent' : p >= 60 ? '#1d7a3f' : p >= 40 ? '#31995e' : p >= 25 ? '#5fb185' : p >= 10 ? '#8cc8a6' : '#b5dcc6';
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ minWidth: 420 }}>
        <thead><tr><th>Cohort</th><th className="n">Size</th>{Array.from({ length: maxWk }, (_, i) => <th key={i} className="n">{i === 0 ? 'wk 0' : '+' + i}</th>)}</tr></thead>
        <tbody>
          {sizes.map((r) => (
            <tr key={r.wk}>
              <td>{r.wk}</td><td className="n">{r.n}</td>
              {Array.from({ length: maxWk }, (_, i) => {
                const n = act.get(`${r.wk}|${i}`);
                const p = n != null && r.n > 0 ? Math.round((100 * n) / r.n) : null;
                return (
                  <td key={i} className="n" style={{ background: p != null ? shade(p) : undefined, color: p != null && p >= 40 ? '#fff' : undefined, borderRadius: 4 }}>
                    {p != null ? p + '%' : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Login({ configured, onDone }) {
  const [msisdn, setMsisdn] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('number');
  const [err, setErr] = useState('');
  const post = (body) => fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (
    <div className="login card">
      <h2 style={{ fontSize: 16 }}>🔐 Admin sign-in</h2>
      {!configured ? (
        <p className="note" style={{ marginTop: 8 }}>
          Login is not configured yet. Set <b>WAPAY_ADMIN_MSISDNS</b> and <b>WAPAY_ADMIN_SESSION_SECRET</b> in
          Vercel, then redeploy. This console fails closed until both exist.
        </p>
      ) : stage === 'number' ? (
        <>
          <p className="note">Your WhatsApp number. A one-time code arrives in your WaPay chat.</p>
          <input inputMode="tel" placeholder="073 123 4567" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} />
          <button className="go" onClick={async () => {
            setErr('');
            if (!/\d{9}/.test(String(msisdn).replace(/\D/g, ''))) { setErr('Enter your full WhatsApp number.'); return; }
            try {
              const r = await post({ action: 'request', msisdn });
              if (!r.ok) { setErr('Could not request a code right now. Try again in a moment.'); return; }
            } catch {
              // A silent failure here is what makes the screen look frozen.
              setErr('No connection. Check your network and try again.');
              return;
            }
            setStage('code');
          }}>Send my code</button>
        </>
      ) : (
        <>
          <p className="note">Enter the 6-digit code. One attempt per code; a wrong guess burns it.</p>
          <p className="note" style={{ marginTop: -4 }}>
            No code? WhatsApp only delivers to an open chat. Send <b>“admin login”</b> to the
            WaPay number from your phone and the code comes straight back.
          </p>
          <input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="go" onClick={async () => {
            setErr('');
            const r = await post({ action: 'verify', msisdn, code });
            if (r.ok) onDone(); else { setErr('That code did not work. Request a fresh one.'); setStage('number'); setCode(''); }
          }}>Sign in</button>
          <button className="linkish" style={{ marginTop: 10 }} onClick={() => { setStage('number'); setCode(''); }}>Different number</button>
        </>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function Dashboard() {
  const [range, setRange] = useState('30');
  const [m, setM] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let cancelled = false;
    setErr('');
    fetch(`/api/admin/metrics?range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setM(d); })
      .catch(() => { if (!cancelled) setErr('Could not load metrics.'); });
    return () => { cancelled = true; };
  }, [range]);
  if (err) {
    // The floats and UniFuel panels have their own endpoints — a metrics
    // failure must not blank them too (review 2026-08-29).
    return (
      <>
        <div className="card"><div className="empty">{err}</div></div>
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Supplier floats</h2>
          <Floats />
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <h2>UniFuel / wiCode</h2>
          <UniFuelPanel />
        </div>
      </>
    );
  }
  if (!m) return <div className="card"><div className="empty">Loading live numbers…</div></div>;
  const v = m.vitals || {};
  const revRows = Object.entries(m.revenue?.byLine || {}).sort((a, b) => b[1] - a[1])
    .map(([k, cents], i) => ({ k, v: cents, c: `var(--s${Math.min(i + 1, 4)})` }));
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <div className="tabs">{['7', '30', '90', 'all'].map((r) => (
          <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === 'all' ? 'All' : r + 'd'}</button>
        ))}</div>
        <span className="note" style={{ margin: 0 }}>generated {dt(m.generatedAt)} · live ledger data</span>
      </div>
      <div className="grid kpis">
        {[
          ['Accounts', v.accounts?.toLocaleString(), v.newAccounts != null ? `+${v.newAccounts} this period` : ''],
          ['Funded rate', v.fundedRatePct != null ? v.fundedRatePct + '%' : '—', `${v.funded ?? '—'} funded`],
          ['Monthly actives', v.mau ?? '—', 'money event in 30d'],
          ['GMV, period', Rw(v.gmvCents), 'in + spent + transferred'],
          ['Revenue, period', R(v.revenueCents), v.takeRatePct != null ? `take rate ${v.takeRatePct}%` : ''],
          ['Wallet float', R(v.floatCents), `${v.walletCount ?? '—'} wallets · ${v.activeHolds ?? 0} active holds`],
        ].map(([k, val, sub]) => (
          <div className="card" key={k}><div className="k">{k}</div><div className="v">{val ?? '—'}</div><div className="vs">{sub}</div></div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>The funnel</h2>
        <p className="note">All-time. Contacts include {m.funnel?.capturedPayers ?? 0} captured pay-link payer(s) who have not onboarded yet.</p>
        <Funnel f={m.funnel} />
      </div>
      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>New accounts per week, by source</h2>
          <p className="note">Organic vs pay-link capture (money-backed attribution, stamped at creation).</p>
          <StackBars rows={m.signupsBySource} />
        </div>
        <div className="card">
          <h2>Revenue by line, this period</h2>
          <p className="note">Credit postings into REVENUE:* accounts.</p>
          <HBars rows={revRows} fmt={R} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Retention — weekly signup cohorts</h2>
        <p className="note">% of each cohort with a money event, by weeks since signup.</p>
        <Cohorts c={m.cohorts} />
      </div>
      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>What's being sold</h2>
          <p className="note">Rand and transaction count per category, this period. Straight from the journal, so it can never disagree with GMV.</p>
          <HBars
            rows={(m.selling || []).map((c, i) => ({ k: `${c.category} (${c.count})`, v: c.cents, c: `var(--s${Math.min(i + 1, 4)})` }))}
            fmt={R}
          />
          {!(m.selling || []).length && <div className="empty">Nothing sold in this period yet.</div>}
        </div>
        <div className="card">
          <h2>Take rate</h2>
          <p className="note">Net revenue as a share of the money that moved, per week.</p>
          <TakeRate revenueWeekly={m.revenue?.weekly} flowsWeekly={m.flows?.weekly} />
          <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
            This period: <b style={{ color: 'var(--ink)' }}>{m.vitals?.takeRatePct != null ? m.vitals.takeRatePct + '%' : '—'}</b>
            {' · '}{R(m.vitals?.revenueCents)} on {Rw(m.vitals?.gmvCents)} GMV
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Money movement per week</h2>
        <p className="note">In = loads and voucher redemptions. Spent = airtime, data, electricity, vouchers. Transferred = requests paid person to person.</p>
        <WeeklyFlows weekly={m.flows?.weekly} />
        <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
          Period totals: in {R(m.flows?.in)} · spent {R(m.flows?.spend)} · transferred {R(m.flows?.transfer)}
        </p>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Money-engine health</h2>
        <p className="note">If any of these is red, treat every number above as suspect until it is fixed.</p>
        <OpsHealth ops={m.ops} />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Supplier floats</h2>
        <p className="note">Prepaid balances at each counterparty, next to what the ledger believes. Top up before a low float fails a vend.</p>
        <Floats />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>UniFuel / wiCode</h2>
        <p className="note">WaPay-originated fuel voucher issuance and redemptions, via the UniFuel service.</p>
        <UniFuelPanel />
      </div>
    </>
  );
}

function Customer() {
  const [q, setQ] = useState('');
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [kycOn, setKycOn] = useState(false);
  const [kycMsg, setKycMsg] = useState('');
  useEffect(() => {
    fetch('/api/admin/kyc').then((r) => (r.ok ? r.json() : { configured: false }))
      .then((j) => setKycOn(!!j.configured)).catch(() => setKycOn(false));
  }, []);
  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState('');
  const loadList = useCallback(async (search = '') => {
    setListErr('');
    try {
      const r = await fetch(`/api/admin/customers?limit=50&q=${encodeURIComponent(search)}`);
      if (!r.ok) { setListErr('Could not load the customer list.'); return; }
      setList(await r.json());
    } catch { setListErr('Could not load the customer list.'); }
  }, []);
  useEffect(() => { loadList(''); }, [loadList]);

  const openCustomer = useCallback(async (msisdn) => {
    setBusy(true); setErr(''); setC(null); setKycMsg('');
    const r = await fetch(`/api/admin/customer?q=${encodeURIComponent(msisdn)}`);
    setBusy(false);
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || 'Lookup failed.'); return; }
    setC(await r.json());
    if (typeof document !== 'undefined') {
      setTimeout(() => document.getElementById('customer-profile')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  }, []);

  const look = useCallback(async () => {
    // The search box drives BOTH: it filters the list and, when the number is
    // complete enough to identify one person, opens that profile.
    loadList(q);
    if (!q.trim()) { setC(null); setErr(''); return; }
    await openCustomer(q);
  }, [q, loadList, openCustomer]);
  const kycAction = useCallback(async (action) => {
    setKycMsg('…');
    const r = await fetch('/api/admin/kyc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, msisdn: c?.account?.msisdn }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setKycMsg(j.error || 'Failed.'); return; }
    setKycMsg(action === 'start' ? (j.delivered ? 'Link sent to their WhatsApp.' : 'Session created; WhatsApp delivery failed, retry later.') : `Status: ${j.kycStatus}`);
    const rr = await fetch(`/api/admin/customer?q=${encodeURIComponent(c.account.msisdn)}`);
    if (rr.ok) setC(await rr.json());
  }, [c]);
  const spend = c?.wallets?.find((w) => w.balanceType === 'SPEND');
  const kycPill = c?.kyc?.status === 'VERIFIED' ? 'g' : c?.kyc?.status === 'PENDING' ? 'y' : 'r';
  return (
    <>
      <div className="card">
        <h2>Customer lookup</h2>
        <p className="note">Any form of the number works: 073…, 2773…, +27 73….</p>
        <div className="searchrow">
          <input placeholder="Phone number" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && look()} />
          <button onClick={look} disabled={busy}>{busy ? '…' : 'Look up'}</button>
        </div>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>All customers {list ? <span className="note" style={{ display: 'inline', fontWeight: 400 }}>· {list.total} total{list.total > list.customers.length ? `, showing ${list.customers.length}` : ''}</span> : ''}</h2>
        <p className="note">Newest first. Click anyone to open their full profile above.</p>
        {listErr && <div className="err">{listErr}</div>}
        {!list && !listErr && <div className="empty">Loading customers…</div>}
        {list && !list.customers.length && <div className="empty">No customers match that search.</div>}
        {list && list.customers.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th>Name</th><th>Number</th><th className="n">Balance</th><th>KYC</th><th>Source</th><th>Joined</th><th>Last activity</th>
              </tr></thead>
              <tbody>
                {list.customers.map((cu) => (
                  <tr key={cu.id} onClick={() => openCustomer(cu.msisdn)} style={{ cursor: 'pointer' }} title="Open this customer">
                    <td>{cu.displayName || <span style={{ color: 'var(--ink3)' }}>—</span>}</td>
                    <td>{cu.msisdn}</td>
                    <td className="n">{R(cu.availableCents)}</td>
                    <td><span className={`pill ${cu.kycStatus === 'VERIFIED' ? 'g' : cu.kycStatus === 'NOT_VERIFIED' ? 'r' : 'y'}`}>{cu.kycStatus.replace('_', ' ')}</span></td>
                    <td className="note" style={{ margin: 0 }}>{cu.acquisitionSource}</td>
                    <td className="note" style={{ margin: 0 }}>{new Date(cu.createdAt).toLocaleDateString('en-ZA')}</td>
                    <td className="note" style={{ margin: 0 }}>{cu.lastActivityAt ? new Date(cu.lastActivityAt).toLocaleDateString('en-ZA') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {c && (
        <>
          <div className="grid two" id="customer-profile" style={{ marginTop: 14 }}>
            <div className="card">
              <h2>{c.account.displayName || 'Customer'} <span className="note" style={{ display: 'inline' }}>· {c.account.msisdn}</span></h2>
              <div className="idrow" style={{ marginTop: 8 }}>
                <span className="l">WhatsApp</span><span>{c.account.waId}</span>
                <span className="l">Status</span><span>{c.account.status} · {c.account.onboardingState}</span>
                <span className="l">Language</span><span>{c.account.language}</span>
                <span className="l">Deposit pref</span><span>{c.account.depositMethod || '—'}</span>
                <span className="l">Joined</span><span>{dt(c.account.createdAt)}</span>
                <span className="l">In-flow state</span><span>{c.account.conversationState || 'idle'}</span>
                <span className="l">KYC</span>
                <span><span className={`pill ${kycPill}`}>{c.kyc.status}</span> <span className="note" style={{ display: 'inline' }}>via {c.kyc.provider}</span></span>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="searchrow-btn" style={{ padding: '8px 14px', border: 0, borderRadius: 8, background: kycOn ? 'var(--accent)' : 'var(--grid)', color: kycOn ? '#fff' : 'var(--ink3)', fontWeight: 650, cursor: kycOn ? 'pointer' : 'not-allowed', fontSize: 12.5 }}
                  disabled={!kycOn} onClick={() => kycAction('start')}>
                  {c.kyc.status === 'NOT_VERIFIED' ? 'Send verification link' : 'Re-send verification link'}
                </button>
                {c.kyc.status !== 'NOT_VERIFIED' && (
                  <button className="linkish" disabled={!kycOn} onClick={() => kycAction('refresh')}>Refresh status</button>
                )}
                {!kycOn && <span className="note" style={{ margin: 0 }}>Didit not configured yet (3 envs).</span>}
                {kycMsg && <span className="note" style={{ margin: 0, color: 'var(--ink2)' }}>{kycMsg}</span>}
              </div>
            </div>
            <div className="card">
              <h2>Balances</h2>
              <div style={{ display: 'flex', gap: 26, marginTop: 8, flexWrap: 'wrap' }}>
                {(c.wallets && c.wallets.length ? c.wallets : [{ balanceType: 'SPEND', availableCents: 0, pendingCents: 0 }]).map((w) => (
                  <div key={w.balanceType}>
                    <div className="k">{w.balanceType} available</div><div className="bal">{R(w.availableCents)}</div>
                    <div className="vs">pending {R(w.pendingCents)}</div>
                  </div>
                ))}
                <div><div className="k">Active holds</div><div className="bal">{c.activeHolds?.length || 0}</div></div>
              </div>
              {c.activeHolds?.length > 0 && (
                <p className="note" style={{ marginTop: 10 }}>
                  Holds: {c.activeHolds.map((h) => `${R(h.amountCents)} (${h.reason || 'no reason'})`).join(' · ')}
                </p>
              )}
            </div>
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <h2>Everything they've bought &amp; moved</h2>
            <p className="note">Last 40 wallet postings, newest first — the double-entry truth.</p>
            <div style={{ overflowX: 'auto' }}>
              <table><thead><tr><th>When</th><th>What</th><th className="n">In</th><th className="n">Out</th><th>Ref</th></tr></thead>
                <tbody>{c.journal.map((j, i) => (
                  <tr key={i}><td>{dt(j.when)}</td><td>{j.source}</td>
                    <td className="n" style={{ color: 'var(--up)' }}>{j.creditCents ? R(j.creditCents) : ''}</td>
                    <td className="n" style={{ color: 'var(--down)' }}>{j.debitCents ? R(j.debitCents) : ''}</td>
                    <td className="note" style={{ margin: 0 }}>{j.ref || ''}</td></tr>
                ))}{!c.journal.length && <tr><td colSpan={5} className="empty">No money movement yet.</td></tr>}</tbody></table>
            </div>
          </div>
          <div className="grid two" style={{ marginTop: 14 }}>
            <div className="card">
              <h2>Vouchers</h2>
              <p className="note">PINs are bearer secrets and are never shown here — resend is customer-side, wallet-PIN-gated.</p>
              <div style={{ overflowX: 'auto' }}>
                <table><thead><tr><th>When</th><th>Dir</th><th className="n">Value</th><th>To / SN</th><th>Status</th></tr></thead>
                  <tbody>
                    {c.vouchers.sent.map((g, i) => (
                      <tr key={'s' + i}><td>{dt(g.createdAt)}</td><td>sent</td><td className="n">{R(g.amountCents)}</td>
                        <td>{g.recipientMsisdn} · SN {g.voucherSerial || '—'}</td>
                        <td><span className={`pill ${g.status === 'DELIVERED' ? 'g' : g.status === 'CANCELLED' ? 'r' : 'y'}`}>{g.status}</span></td></tr>
                    ))}
                    {c.vouchers.received.map((g, i) => (
                      <tr key={'r' + i}><td>{dt(g.createdAt)}</td><td>received</td><td className="n">{R(g.amountCents)}</td>
                        <td>SN {g.voucherSerial || '—'}</td>
                        <td><span className={`pill ${g.status === 'DELIVERED' ? 'g' : 'y'}`}>{g.status}</span></td></tr>
                    ))}
                    {!c.vouchers.sent.length && !c.vouchers.received.length && <tr><td colSpan={5} className="empty">No vouchers yet.</td></tr>}
                  </tbody></table>
              </div>
            </div>
            <div className="card">
              <h2>Payment requests &amp; deposits</h2>
              <div style={{ overflowX: 'auto' }}>
                <table><thead><tr><th>When</th><th>What</th><th className="n">Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {c.requests.map((r) => (
                      <tr key={r.id}><td>{dt(r.createdAt)}</td><td>request {r.id}</td><td className="n">{R(r.amountCents)}</td>
                        <td><span className={`pill ${r.status === 'PAID' ? 'g' : r.status === 'PENDING' ? 'y' : 'r'}`}>{r.status}</span></td></tr>
                    ))}
                    {c.deposits.map((d, i) => (
                      <tr key={'d' + i}><td>{dt(d.when)}</td><td>card deposit {d.providerRef || ''}</td>
                        <td className="n">{d.amountCents ? R(d.amountCents) : '—'}</td>
                        <td><span className={`pill ${d.status === 'SUCCESS' ? 'g' : d.status === 'FAILED' ? 'r' : 'y'}`}>{d.status}</span></td></tr>
                    ))}
                    {!c.requests.length && !c.deposits.length && <tr><td colSpan={4} className="empty">Nothing yet.</td></tr>}
                  </tbody></table>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function Admin() {
  const [authed, setAuthed] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [tab, setTab] = useState('dashboard');
  const probe = useCallback(() => {
    fetch('/api/admin/auth').then((r) => r.json()).then((s) => { setAuthed(s.authed); setConfigured(s.configured); })
      .catch(() => setAuthed(false));
  }, []);
  useEffect(() => { probe(); }, [probe]);
  return (
    <div className="wrap">
      <Head><title>WaPay Mission Control</title><meta name="robots" content="noindex,nofollow" /></Head>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header>
        <span className="brand"><b>WaPay</b> Mission Control</span>
        <div className="spacer" />
        {authed && (
          <>
            <div className="tabs">
              <button className={tab === 'dashboard' ? 'on' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
              <button className={tab === 'customer' ? 'on' : ''} onClick={() => setTab('customer')}>Customers</button>
            </div>
            <button className="linkish" onClick={async () => {
              await fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
              setAuthed(false);
            }}>Sign out</button>
          </>
        )}
      </header>
      {authed === null && <div className="card"><div className="empty">…</div></div>}
      {authed === false && <Login configured={configured} onDone={probe} />}
      {authed === true && (tab === 'dashboard' ? <Dashboard /> : <Customer />)}
    </div>
  );
}
