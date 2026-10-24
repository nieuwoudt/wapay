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

import { useEffect, useState, useCallback, useRef } from 'react';
import Head from 'next/head';
import { fmtR, fmtN, simulate, preset, budgetFn, BUDGET_DEFAULT } from '../../lib/scale-model.js';
import { Bars, WeeklyFlows, TakeRate, StackBars, DailyBars, DailyLines, PathChart, ValuationPath } from '../../lib/admin-charts.js';

// Mission Control refreshes itself every ten minutes (founder 2026-10-19); the Meta read is throttled server-side to the same cadence.
const REFRESH_MS = 10 * 60 * 1000;

const R = (c) => 'R' + (Math.round(c || 0) / 100).toLocaleString('en-ZA', { maximumFractionDigits: 2 });
const Rw = (c) => 'R' + Math.round((c || 0) / 100).toLocaleString('en-ZA');
const dt = (s) => (s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap");
/* Same visual system as the business portal (founder 2026-09-06): glass cards
   on one seamless green gradient, Inter, the official lockup + an "Admin" tag. */
:root{color-scheme:light;--page:#eef3ef;--bgfx:radial-gradient(90vmax 70vmax at 8% -12%,rgba(53,152,83,.26),transparent 62%),radial-gradient(80vmax 60vmax at 96% 108%,rgba(37,211,102,.16),transparent 60%),linear-gradient(180deg,#eef3ef 0%,#e7efe9 100%);
--surface:rgba(255,255,255,.72);--edge:rgba(9,30,18,.10);--ink:#0b1411;--ink2:#3d4a43;--ink3:#7b877f;--grid:rgba(9,30,18,.10);
--accent:#359853;--accent-2:#2e8a4c;--accent-ink:#1f6a39;--accent-soft:rgba(53,152,83,.12);
--glass:linear-gradient(180deg,rgba(255,255,255,.78),rgba(255,255,255,.56));--glass-edge:rgba(255,255,255,.75);--glass-line:rgba(9,30,18,.08);
--sheen:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.9),rgba(255,255,255,0));
--field:rgba(255,255,255,.85);--field-edge:rgba(9,30,18,.14);--shadow:0 18px 50px -22px rgba(8,40,20,.35),0 2px 6px -2px rgba(8,40,20,.12);
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--good:#0ca30c;--crit:#d03b3b;--up:#006300;--down:#b3362a}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0b100d;--bgfx:radial-gradient(90vmax 70vmax at 8% -12%,rgba(53,152,83,.30),transparent 62%),radial-gradient(80vmax 60vmax at 96% 108%,rgba(37,211,102,.13),transparent 60%),linear-gradient(180deg,#0b100d 0%,#0d150f 100%);
--surface:rgba(28,34,31,.7);--edge:rgba(255,255,255,.10);--ink:#f2f6f3;--ink2:#c3ccc6;--ink3:#8a948d;--grid:rgba(255,255,255,.08);
--accent:#4fb572;--accent-2:#3d9d5e;--accent-ink:#9fe0b6;--accent-soft:rgba(79,181,114,.16);
--glass:linear-gradient(180deg,rgba(28,34,31,.78),rgba(20,25,22,.62));--glass-edge:rgba(255,255,255,.14);--glass-line:rgba(255,255,255,.06);
--sheen:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.35),rgba(255,255,255,0));
--field:rgba(255,255,255,.06);--field-edge:rgba(255,255,255,.14);--shadow:0 24px 60px -24px rgba(0,0,0,.7),0 2px 6px -2px rgba(0,0,0,.5);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--up:#0ca30c;--down:#e66767}}
*{box-sizing:border-box}
html{background:var(--page)}
html,body{margin:0;color:var(--ink);font:400 14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body{background:transparent;min-height:100vh}
.bg{position:fixed;inset:0;z-index:-1;pointer-events:none;background:var(--bgfx)}
.wrap{max-width:1180px;margin:0 auto;padding:22px 20px 90px}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand img.logo{height:30px;width:auto;display:block;flex:none}
.brand .tag{font-size:11px;font-weight:600;color:var(--ink3);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;padding-left:12px;border-left:1px solid var(--field-edge);line-height:1.2}
@media(max-width:700px){.brand img.logo{height:26px}}
.spacer{flex:1}
.tabs{display:flex;gap:4px;background:var(--glass);border:1px solid var(--glass-edge);border-radius:14px;padding:4px;backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);box-shadow:var(--shadow)}
.tabs button{border:0;background:transparent;color:var(--ink2);font:600 12.5px Inter,system-ui;padding:8px 14px;border-radius:10px;cursor:pointer;transition:all .15s}
.tabs button:hover{background:var(--accent-soft)}
.tabs button.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;box-shadow:0 6px 18px -8px rgba(53,152,83,.8)}
.linkish{border:0;background:none;color:var(--ink3);font-size:12.5px;cursor:pointer;text-decoration:underline;padding:4px}
.grid{display:grid;gap:14px}.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.two{grid-template-columns:1fr 1fr}@media(max-width:860px){.two{grid-template-columns:1fr}}
.card{position:relative;background:var(--glass);border:1px solid var(--glass-edge);border-radius:20px;padding:18px 20px;min-width:0;
backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);box-shadow:var(--shadow)}
.card::before{content:"";position:absolute;left:14%;right:14%;top:0;height:1px;background:var(--sheen);opacity:.9}
.card h2{font-size:13.5px;font-weight:700;margin:0 0 2px}
.note{font-size:11.5px;color:var(--ink3);margin:0 0 10px}
.k{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3)}
.v{font-size:25px;font-weight:650;margin-top:3px}
.vs{font-size:11.5px;color:var(--ink3);margin-top:3px}
.login{max-width:400px;margin:9vh auto 0}
.login input{width:100%;padding:11px 13px;border:1px solid var(--field-edge);border-radius:12px;background:var(--field);color:var(--ink);font:inherit;font-size:15px;margin:6px 0 12px;outline:none;transition:border .15s,box-shadow .15s}
.login input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.login button.go{width:100%;padding:12px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font:650 14px Inter,system-ui;cursor:pointer;box-shadow:0 10px 24px -10px rgba(53,152,83,.8)}
.login button.go:disabled{opacity:.6;cursor:default}
.login .msg{background:var(--field);border:1px solid var(--field-edge);border-radius:14px;padding:12px 14px;font-size:13.5px;line-height:1.5;margin-bottom:12px}
.login .links{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:10px}
.err{color:var(--crit);font-size:12.5px;margin-top:8px}
.searchrow{display:flex;gap:8px}
.searchrow input{flex:1;padding:10px 13px;border:1px solid var(--field-edge);border-radius:12px;background:var(--field);color:var(--ink);font:inherit;font-size:14px;outline:none}
.searchrow input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.searchrow button{padding:10px 16px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:650;cursor:pointer}
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
svg text{font:500 10.5px Inter,system-ui;fill:var(--ink3)}
.empty{color:var(--ink3);font-size:12.5px;padding:14px 0}
.recharts-wrapper svg{width:100%!important}
.recharts-legend-item-text{color:var(--ink2)!important}
@media(max-width:700px){
.wrap{padding:12px 12px 70px}
header{gap:10px;margin-bottom:12px}
.tabs{overflow-x:auto;flex-wrap:nowrap;max-width:100%;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{white-space:nowrap;padding:8px 11px;font-size:12px}
.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.grid{gap:10px}
.card{padding:14px 14px;border-radius:16px}
.card h2{font-size:13px}
.v{font-size:21px}
.bal{font-size:19px}
table{font-size:12px}
th,td{padding:5px 7px 5px 0}
.idrow{grid-template-columns:1fr}
.floatrow{grid-template-columns:1fr!important;gap:6px!important}
.searchrow{flex-wrap:wrap}
.login{margin-top:4vh}
}

.ops{display:flex;gap:8px;flex-wrap:wrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
`;

function BarsStatic({ series, color = 'var(--accent)', fmt = (v) => v }) {
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

function WeeklyFlowsStatic({ weekly }) {
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

function TakeRateStatic({ revenueWeekly, flowsWeekly }) {
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
        <div key={row.key} className="floatrow" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) 1fr 1fr 1.4fr', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--grid)' }}>
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
            {row.recon && row.recon.expectedCents != null && pill(row.recon.reconDriftCents == null ? null : Math.abs(row.recon.reconDriftCents) < 500, 'Recon',
              `${R(row.recon.loadedCents)} loaded in ${row.recon.loads} ${row.recon.loads === 1 ? 'load' : 'loads'} · ${R(row.recon.usageCents)} used · expected ${R(row.recon.expectedCents)}${row.recon.reconDriftCents == null ? '' : row.recon.reconDriftCents === 0 ? ' · matches' : ` · ${R(Math.abs(row.recon.reconDriftCents))} ${row.recon.reconDriftCents > 0 ? 'more at the supplier' : 'short at the supplier'}`}`)}
            {row.recon && row.recon.expectedCents == null && row.recon.loads > 0 && pill(null, 'Loads', `${R(row.recon.loadedCents)} in ${row.recon.loads}`)}
            {row.low != null && pill(!row.low, row.low ? 'LOW FLOAT' : 'Float ok', `warn under ${R(row.warnCents)}`)}
            {row.driftCents != null && pill(null, 'Drift',
              row.driftCents === 0 ? 'none' : `${R(Math.abs(row.driftCents))} ${row.driftCents > 0 ? 'supplier ahead' : 'ledger ahead'}`)}
            {row.ledgerRail && f.ledgerAvailable === false && pill(null, 'Ledger unavailable', '')}
            {row.api && !row.api.configured && pill(null, 'Awaiting credentials', '')}
            {row.api?.error && pill(false, 'Supplier check failed', row.api.error)}
          </div>
          <RecordLoad floatKey={row.key} lastLoad={row.recon?.lastLoad || null} onRecorded={() => { setF(null); fetch('/api/admin/floats').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setF(d); }).catch(() => {}); }} />
        </div>
      ))}
      <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
        Ledger = net CLEARING position from the journal (negative = WaPay owes the supplier). Float top-up transfers are not journaled yet, so a prepaid supplier's live float and ledger position legitimately differ; drift compares them where both exist. Cached ~60s.
      </p>
    </div>
  );
}

function Conversations() {
  // Mission Control C19: the shadow week in one card. Its own endpoint because
  // the agent aggregates answer a different question than the money metrics.
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  // The rail's float is a live call to the supplier with its own 8 second
  // timeout, so it is fetched SEPARATELY and the card renders without it. The
  // parked total is only half the picture a human needs (what is held against
  // what is there to pay it), but a supplier having a bad minute must not
  // take the conversation metrics down with it.
  const [float, setFloat] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/conversations?days=7')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setC(d); })
      .catch(() => { if (!cancelled) setErr('Could not load conversation metrics.'); });
    fetch('/api/admin/floats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return;
        const row = (d.floats || []).find((f) => f.key === 'OTT_PAYOUT');
        setFloat(row?.api?.availableCents ?? null);
      })
      .catch(() => { if (!cancelled) setFloat(null); });
    return () => { cancelled = true; };
  }, []);
  if (err) return <div className="empty">{err}</div>;
  if (!c) return <div className="empty">Counting turns…</div>;
  const gateNames = Object.keys(c.gates || {});
  // The gates that decide promotion, named by the API so this file carries
  // none of those words itself (the console copy policy).
  const gateWatch = gateNames.filter((g) => (c.gateWatch || []).includes(g));
  const ms = (v) => (v == null ? '—' : v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms');
  const usd = (v) => '$' + Number(v || 0).toFixed(4);
  const stat = (k, v, sub) => (
    <div key={k} style={{ padding: '7px 0' }}>
      <div style={{ fontSize: 11, color: 'var(--ink3)' }}>{k}</div>
      <div style={{ fontSize: 17, fontWeight: 700 }}>{v}</div>
      {sub ? <div style={{ fontSize: 11, color: 'var(--ink3)' }}>{sub}</div> : null}
    </div>
  );
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        {stat('Customer messages', c.conversation.inbound, 'last ' + c.windowDays + ' days')}
        {stat('WaPay replies', c.conversation.outbound, 'both sides recorded')}
        {stat('Agent turns', c.agent.turns, c.shadow.live ? c.agent.customers + ' on the pilot list' : 'pilot list empty')}
        {stat(
          'Clean days',
          c.shadow.started ? c.shadow.cleanDays + ' / ' + c.shadow.cleanDaysNeeded : 'not started',
          c.shadow.started
            ? (c.shadow.cleanDays >= c.shadow.cleanDaysNeeded
                ? 'the week is won'
                : 'opens ' + new Date(c.shadow.readyAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) + (c.shadow.moneyGateFired ? ', clock reset by a gate' : ''))
            : 'no agent turn yet',
        )}
        {stat('Agent share', c.agent.shareOfInboundPct == null ? '—' : c.agent.shareOfInboundPct + '%', 'of customer messages')}
        {stat('Latency p50 / p95', ms(c.agent.p50Ms) + ' / ' + ms(c.agent.p95Ms), 'slowest ' + ms(c.agent.maxMs))}
        {stat('Model spend', c.agent.priced ? (c.agent.costZar != null ? 'R' + c.agent.costZar.toFixed(2) : usd(c.agent.costUsd)) : 'not priced', c.agent.priced ? (c.agent.costPerTurnZar != null ? 'R' + c.agent.costPerTurnZar.toFixed(4) + ' per turn' : usd(c.agent.costPerTurnUsd) + ' per turn') : 'prices not set')}
      </div>
      <div className="ops" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {Object.entries(c.agent.outcomes || {}).map(([k, v]) => (
          <span key={k} className="pill">
            <span className="dot" style={{ background: k === 'error' || k === 'fallback' ? 'var(--crit)' : 'var(--good)' }} />
            {k} {v}
          </span>
        ))}
        {gateNames.length === 0 ? (
          <span className="pill"><span className="dot" style={{ background: 'var(--good)' }} />No gate fired</span>
        ) : gateNames.map((g) => (
          <span key={g} className="pill" style={{ borderColor: gateWatch.includes(g) ? 'var(--crit)' : undefined, color: gateWatch.includes(g) ? 'var(--crit)' : undefined }}>
            <span className="dot" style={{ background: gateWatch.includes(g) ? 'var(--crit)' : 'var(--ink3)' }} />
            {g} {c.gates[g]}
          </span>
        ))}
        {Object.entries(c.agent.errors || {}).map(([k, v]) => (
          <span key={k} className="pill" style={{ borderColor: 'var(--crit)', color: 'var(--crit)' }}>
            <span className="dot" style={{ background: 'var(--crit)' }} />
            {k} {v}
          </span>
        ))}
      </div>
      <p className="note" style={{ marginTop: 8, marginBottom: 6 }}>
        The next phase opens when the eval passes in every language AND a full week of agent turns fires none of the three gates drawn in red. The rest are informational.
      </p>
      {/* A pilot week that never starts looks exactly like a quiet one. Each
          number on the list is shown by its last four digits with whether the
          product can read it and whether it belongs to an account that has
          written to us, so an empty week is never a mystery. */}
      <div className="ops" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {(c.shadow.entries || []).length === 0 ? (
          <span className="pill"><span className="dot" style={{ background: 'var(--ink3)' }} />Pilot list empty</span>
        ) : (c.shadow.entries || []).map((e, i) => {
          const bad = !e.valid || !e.hasAccount;
          return (
            <span key={i} className="pill" style={{ borderColor: bad ? 'var(--crit)' : undefined, color: bad ? 'var(--crit)' : undefined }}>
              <span className="dot" style={{ background: bad ? 'var(--crit)' : 'var(--good)' }} />
              {'•••' + (e.tail || '????')}{' '}
              {!e.valid ? 'not a readable number' : !e.hasAccount ? 'no account has written from it' : e.turnsInWindow + ' turns'}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
          Still with the rail: {c.payouts.parked}
          {c.payouts.parked > 0 ? (
            <span style={{ fontWeight: 400, color: 'var(--ink3)' }}>
              {' · holding '}{R(c.payouts.heldCents)}{' of customer money'}
              {float != null ? ' · rail float ' + R(float) : ''}
              {float != null && c.payouts.heldCents > float ? ' ⚠️ held exceeds the float' : ''}
              {c.payouts.oldestMinutes != null ? ' · oldest ' + c.payouts.oldestMinutes + 'm' : ''}
            </span>
          ) : null}
        </div>
        {c.payouts.parked > 0 ? (
          <p className="note" style={{ marginTop: 0, marginBottom: 6 }}>
            Compare this against the supplier float on the card below: money held here has left the customer's balance but has not reached them.
          </p>
        ) : null}
        {c.payouts.rows.length === 0 ? (
          <div className="empty" style={{ padding: '6px 0' }}>Nothing parked.</div>
        ) : c.payouts.rows.map((p) => (
          <div key={p.reference || String(p.ageMinutes)} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--grid)', fontSize: 12.5 }}>
            <span style={{ color: 'var(--ink3)' }}>{p.reference || '(no reference)'}</span>
            <span>{p.method || '—'} {p.amountCents != null ? R(p.amountCents) : ''}</span>
            <span style={{ color: p.ageMinutes > 60 ? 'var(--crit)' : 'var(--ink2)' }}>{p.status} {p.ageMinutes}m</span>
            <span style={{ color: 'var(--ink3)' }}>{p.lastCheckedAt ? 'checked ' + dt(p.lastCheckedAt) : 'not checked yet'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PayoutBooks() {
  // The reconciliation the founder asked for on 2026-10-04: client funds,
  // what is held for pay-outs, what the journal says left, and whether the
  // three records of every pay-out agree. The supplier float is fetched from
  // the floats route (its own timeout) so a slow OTT never hides the books.
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [float, setFloat] = useState(undefined);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/payout-reconciliation')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setB(d); })
      .catch(() => { if (!cancelled) setErr('Could not load the pay-out books.'); });
    fetch('/api/admin/floats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return;
        const row = (d.floats || []).find((f) => f.key === 'OTT_PAYOUT');
        setFloat(row?.api?.availableCents ?? null);
      })
      .catch(() => { if (!cancelled) setFloat(null); });
    return () => { cancelled = true; };
  }, []);
  if (err) return <div className="empty">{err}</div>;
  if (!b) return <div className="empty">Reading the books…</div>;
  const funds = b.clientFunds || {};
  const p = b.payouts || {};
  const l = b.ledger || {};
  const st = (k) => (p.byStatus || {})[k] || { count: 0, amountCents: 0, feeCents: 0 };
  const stat = (k, v, sub, bad) => (
    <div key={k} style={{ padding: '7px 0' }}>
      <div style={{ fontSize: 11, color: 'var(--ink3)' }}>{k}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: bad ? 'var(--crit)' : undefined }}>{v}</div>
      {sub ? <div style={{ fontSize: 11, color: 'var(--ink3)' }}>{sub}</div> : null}
    </div>
  );
  // What the float should read if nothing but our pay-outs ever drew on it:
  // the live float plus everything the journal says left it. Compared with
  // the funded amount only when the founder has recorded one.
  const implied = float != null ? float + (l.paidOutCents || 0) + (l.railCostCents || 0) : null;
  const funded = b.supplier?.fundedCents ?? null;
  const drift = implied != null && funded != null ? implied - funded : null;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {stat('Owed to customers', R(funds.totalCents), `${R(funds.spendCents)} spend · ${R(funds.cashCents)} cash · ${R(funds.pendingCents)} pending · ${funds.wallets || 0} wallets`)}
        {stat('Held for pay-outs', R(p.activeHeldCents), `${p.activeHolds || 0} active holds · ${p.openCount || 0} open pay-outs say ${R(p.openHeldCents)}`, p.activeHeldCents !== p.openHeldCents)}
        {stat('Paid out (journal)', R(l.paidOutCents), `${l.paidOutEntries || 0} journal entries · rows say ${R(p.successAmountCents)} over ${st('SUCCESS').count}`, l.paidOutCents !== p.successAmountCents)}
        {stat('Fees earned', R(l.feeRevenueCents), 'the pay-out fee account in the journal')}
        {stat('Rail cost (our table)', R(l.railCostCents), `${l.railCostEntries || 0} entries · not OTT’s invoice`)}
        {stat('OTT pay-out float', float === undefined ? '…' : float == null ? 'unavailable' : R(float), implied != null ? `float + paid out + rail cost = ${R(implied)}` : 'see Supplier floats')}
        {funded != null ? stat('Funded (your record)', R(funded), drift == null ? 'float unavailable' : drift === 0 ? 'matches' : `${R(Math.abs(drift))} ${drift > 0 ? 'more than funded' : 'unexplained draw'}`, drift != null && drift !== 0) : null}
      </div>
      <div className="ops" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
        {['INIT', 'PENDING', 'SUCCESS', 'FAILED'].map((k) => (
          <span key={k} className="pill" style={{ color: 'var(--ink2)' }}>
            <span className="dot" style={{ background: k === 'SUCCESS' ? 'var(--good)' : k === 'FAILED' ? 'var(--crit)' : 'var(--ink3)' }} />
            {k} {st(k).count}{st(k).count ? ` · ${R(st(k).amountCents)} + ${R(st(k).feeCents)} fees` : ''}
          </span>
        ))}
      </div>
      <div className="ops" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {(b.checks || []).map((c) => (
          <span key={c.id} className="pill" style={{ borderColor: c.ok === false ? 'var(--crit)' : undefined, color: c.ok === false ? 'var(--crit)' : 'var(--ink2)' }}>
            <span className="dot" style={{ background: c.ok === null ? 'var(--ink3)' : c.ok ? 'var(--good)' : 'var(--crit)' }} />
            {c.label}{c.ok === false ? (c.id === 'held_total' || c.id === 'ledger_total' ? ` · off by ${R(c.count)}` : ` · ${c.count}`) : ''}
          </span>
        ))}
      </div>
      {(b.anomalies || []).length === 0 ? (
        <div className="empty" style={{ padding: '6px 0' }}>Every pay-out agrees with its hold and its journal entry.</div>
      ) : (b.anomalies || []).map((a, i) => (
        <div key={(a.reference || 'hold') + i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 3fr', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--grid)', fontSize: 12.5 }}>
          <span style={{ color: 'var(--ink3)' }}>{a.reference || '(hold only)'}</span>
          <span>{a.status} {a.method || ''} {a.amountCents != null ? R(a.amountCents) : ''}{a.ageMinutes != null ? ` · ${a.ageMinutes}m` : ''}</span>
          <span style={{ color: 'var(--crit)' }}>{a.problem}</span>
        </div>
      ))}
      {b.electricity ? (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--grid)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
            Prepaid electricity parked at Blu: {b.electricity.parked}
            {b.electricity.parked > 0 ? (
              <span style={{ fontWeight: 400, color: 'var(--ink3)' }}>
                {' · holding '}{R(b.electricity.parkedHeldCents)}
                {b.electricity.oldestParkedMinutes != null ? ' · oldest ' + b.electricity.oldestParkedMinutes + 'm' : ''}
                {b.electricity.lastReconcileMinutesAgo != null ? ' · last re-send ' + b.electricity.lastReconcileMinutesAgo + 'm ago' : ' · not re-sent yet'}
                {b.electricity.stale > 0 ? ' ⚠️ ' + b.electricity.stale + ' stuck mid-sale' : ''}
              </span>
            ) : null}
          </div>
          <div className="ops" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {(b.electricity.checks || []).map((c) => (
              <span key={c.id} className="pill" style={{ borderColor: c.ok === false ? 'var(--crit)' : undefined, color: c.ok === false ? 'var(--crit)' : 'var(--ink2)' }}>
                <span className="dot" style={{ background: c.ok ? 'var(--good)' : 'var(--crit)' }} />
                {c.label}{c.ok === false ? ` · ${c.count}` : ''}
              </span>
            ))}
          </div>
          {(b.electricity.anomalies || []).map((a, i) => (
            <div key={a.reference + i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 3fr', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--grid)', fontSize: 12.5 }}>
              <span style={{ color: 'var(--ink3)' }}>{a.reference}</span>
              <span>{a.status} {a.amountCents != null ? R(a.amountCents) : ''}{a.ageMinutes != null ? ` · ${a.ageMinutes}m` : ''}</span>
              <span style={{ color: 'var(--crit)' }}>{a.problem}</span>
            </div>
          ))}
        </div>
      ) : null}
      <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
        Three records per pay-out must agree: the rail’s answer (provider row), the customer’s parked money (hold) and what settled (journal). “Owed to customers” is every wallet summed: the liability the floats and the bank account must cover. The rail cost is our fee table’s figure until OTT’s statement is reconciled. Set WAPAY_OTT_PAYOUT_FUNDED_CENTS to what was wired to the pay-out float to see drift.
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
    ['Made a link', f.linked, 'created a payment link'],
    ['Funded', f.funded, 'first money in'],
    ['Transacting', f.transacting, 'first spend or send'],
    ['Repeat', f.repeat, '2+ money events in 30d'],
  ].filter(([, v]) => v != null);
  const top = stages[0]?.[1] || 1;
  const shades = ['#6bbf92', '#4dae77', '#3aa36a', '#31995e', '#1d7a3f', '#14512c'];
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
function StackBarsStatic({ rows }) {
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

function Login({ configured, passwordLogin, onDone }) {
  // The number is remembered locally so the founder types a password only
  // (founder ask 2026-08-30). Password-first when configured; the WhatsApp
  // code stays as the fallback that can never lock anyone out.
  const [msisdn, setMsisdn] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState(passwordLogin ? 'password' : 'number');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('wapay_admin_msisdn');
      if (saved) setMsisdn(saved);
    } catch {
      // private mode / blocked storage: the field simply starts empty
    }
  }, []);

  const remember = (n) => {
    try { window.localStorage.setItem('wapay_admin_msisdn', n); } catch {}
  };
  const post = (body) => fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const numberOk = /\d{9}/.test(String(msisdn).replace(/\D/g, ''));

  return (
    <div className="login card">
      <h2 style={{ fontSize: 18, marginBottom: 6 }}>Admin sign-in</h2>
      {!configured ? (
        <p className="note" style={{ marginTop: 8 }}>
          Login is not configured yet. Set <b>WAPAY_ADMIN_MSISDNS</b> and <b>WAPAY_ADMIN_SESSION_SECRET</b> in
          Vercel, then redeploy. This console fails closed until both exist.
        </p>
      ) : stage === 'password' ? (
        <>
          <p className="note">Sign in with your number and password.</p>
          <input inputMode="tel" autoComplete="username" placeholder="073 123 4567" value={msisdn}
            onChange={(e) => setMsisdn(e.target.value)} />
          <input type="password" autoComplete="current-password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('pw-go')?.click(); }} />
          <button id="pw-go" className="go" disabled={busy} onClick={async () => {
            setErr('');
            if (!numberOk) { setErr('Enter your full number.'); return; }
            if (!password) { setErr('Enter your password.'); return; }
            setBusy(true);
            try {
              const r = await post({ action: 'password', msisdn, password });
              if (r.ok) { remember(msisdn); onDone(); return; }
              const body = await r.json().catch(() => ({}));
              setErr(r.status === 429
                ? 'Too many attempts. Try again in 15 minutes.'
                : body.error === 'HASH_MALFORMED'
                  ? 'Password sign-in is misconfigured on the server (WAPAY_ADMIN_PASSWORD_HASH is not a valid hash).'
                  : 'That did not work. Check the number and password.');
            } catch {
              setErr('No connection. Check your network and try again.');
            } finally {
              setBusy(false);
              setPassword('');
            }
          }}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button className="linkish" style={{ marginTop: 10 }} onClick={() => { setStage('number'); setPassword(''); setErr(''); }}>
            Use a one-time code instead
          </button>
        </>
      ) : stage === 'number' ? (
        <>
          <p className="note">Enter the WhatsApp number on the admin list, then use a one-time code.</p>
          <input inputMode="tel" autoComplete="username" placeholder="073 123 4567" value={msisdn} onChange={(e) => setMsisdn(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('send-code')?.click(); }} />
          <button id="send-code" className="go" disabled={busy} onClick={async () => {
              setErr('');
              if (!numberOk) { setErr('Enter your full WhatsApp number.'); return; }
              setBusy(true);
              try {
                const r = await post({ action: 'request', msisdn });
                if (!r.ok) { setErr('Could not request a code right now. Try again in a moment.'); return; }
                setStage('code');
              } catch {
                // A silent failure here is what makes the screen look frozen.
                setErr('No connection. Check your network and try again.');
              } finally { setBusy(false); }
            }}>{busy ? 'Sending…' : 'Send my code'}</button>
          <div className="links">
            {passwordLogin ? <button className="linkish" onClick={() => { setStage('password'); setErr(''); }}>Use my password instead</button> : <span />}
            {/* Opens the code box only; a code already in the chat stays valid (BUGLOG #40). */}
            <button className="linkish" onClick={() => { setErr(''); if (!numberOk) { setErr('Enter your full WhatsApp number.'); return; } setCode(''); setStage('code'); }}>I already have a code</button>
          </div>
          <p className="note" style={{ marginTop: 12 }}>The code arrives as a WhatsApp message with a <b>Copy code</b> button.</p>
        </>
      ) : (
        <>
          <p className="note">Six digits, one attempt per code. A wrong guess burns it. Nothing in your chat? Ask for a code from your phone and use the one that comes back.</p>
          <input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="go" onClick={async () => {
            setErr('');
            const r = await post({ action: 'verify', msisdn, code });
            if (r.ok) { remember(msisdn); onDone(); } else { setErr(r.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : 'That code did not work. Ask for a fresh one from your phone.'); setStage('number'); setCode(''); }
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
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setErr('');
    fetch(`/api/admin/metrics?range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setM(d); })
      .catch(() => { if (!cancelled) setErr('Could not load metrics.'); });
    return () => { cancelled = true; };
  }, [range, tick]);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS); return () => clearInterval(id); }, []);
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
        <div className="tabs">{['1', '7', '30', '90', 'all'].map((r) => (
          <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === 'all' ? 'All' : r + 'd'}</button>
        ))}</div>
        <button className="linkish" onClick={() => setTick((t) => t + 1)} title="Re-read every number now">↻ Refresh</button>
        <span className="note" style={{ margin: 0 }}>generated {dt(m.generatedAt)} · live ledger data · refreshes itself every 10 minutes</span>
      </div>
      <div className="grid kpis">
        {[
          ['Accounts', v.accounts?.toLocaleString(), v.newAccounts != null ? `+${v.newAccounts} this period` : ''],
          ['Funded rate', v.fundedRatePct != null ? v.fundedRatePct + '%' : '—', `${v.funded ?? '—'} funded`],
          ['Monthly actives', v.mau ?? '—', 'money event in 30d'],
          ['GMV, period', Rw(v.gmvCents), 'in + spent + transferred'],
          ['Revenue, period', R(v.revenueCents), v.takeRatePct != null ? `take rate ${v.takeRatePct}%` : ''],
          ['Customer balances', R(v.balancesCents ?? v.floatCents), `${v.walletCount ?? '—'} wallets · ${v.walletsAbove20 ?? '—'} at or above R20 · ${v.activeHolds ?? 0} active holds`],
        ].map(([k, val, sub]) => (
          <div className="card" key={k}><div className="k">{k}</div><div className="v">{val ?? '—'}</div><div className="vs">{sub}</div></div>
        ))}
      </div>
      <div className="grid kpis" style={{ marginTop: 10 }}>
        {(() => {
          // The money tiles follow the selected period (founder 2026-10-19); the 1-day range is "today".
          const p = range === '1' ? v.today : (v.period || v.today);
          const label = range === '1' ? 'today' : range === 'all' ? 'all time' : `last ${range} days`;
          return [
            [`Money in, ${label}`, R(p?.moneyInCents), `${p?.moneyInCount ?? '—'} loads from outside · ${p?.linksPaidCount ?? '—'} links paid (${R(p?.linksPaidCents)})`],
            [`Pay-outs, ${label}`, R(p?.payoutsCents), `${p?.payoutsCount ?? '—'} paid to the rail`],
            ['Open links', n0(m.links?.open?.n ?? v.today?.openLinksCount), `${R(m.links?.open?.cents ?? v.today?.openLinksCents)} waiting for a payer`],
          ].map(([k, val, sub]) => (
            <div className="card" key={k}><div className="k">{k}</div><div className="v">{val ?? '—'}</div><div className="vs">{sub}</div></div>
          ));
        })()}
        <FloatTile balancesCents={v.balancesCents ?? v.floatCents} payouts7dCents={null} tick={tick} />
      </div>
      <LinksAndLoop links={m.links} viral={m.viral} generatedAt={m.generatedAt} />
      <LiveValuation compact tick={tick} />
      <div className="card" style={{ marginTop: 14 }}>
        <h2>The funnel</h2>
        <p className="note">All-time. Contacts include {m.funnel?.capturedPayers ?? 0} captured pay-link payer(s) who have not onboarded yet.</p>
        <Funnel f={m.funnel} />
      </div>
      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>New accounts per week, by source</h2>
          <p className="note">Organic vs pay-link capture (money-backed attribution, stamped at creation).</p>
          <StackBars rows={m.signupsBySource} colors={SRC_COLORS} />
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

      <p className="note" style={{ marginTop: 14 }}>Money-engine health, the Pay agent and pay-out reconciliation live on the Health tab; supplier floats and UniFuel on the Supplier Floats tab.</p>
    </>
  );
}


/* ---------------- Payment links as the key figure, and the viral loop (founder 2026-10-19) ---------------- */

function LinksAndLoop({ links: l, viral: vl, generatedAt }) {
  const stamp = generatedAt ? new Date(generatedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : null;
  const tiles = l ? [
    ['Payment links created', R(l.created.cents), `${n0(l.created.n)} links, all time · ${n0(l.createdInRange.n)} in this period (${R(l.createdInRange.cents)})`],
    ['Paid', R(l.paid.cents), `${n0(l.paid.n)} paid (${l.paidRatePct ?? '—'}% of links) · ${n0(l.paid.fromBalance)} from a balance, ${n0(l.paid.byCard)} by card or EFT · fees earned ${R(l.feeRealisedCents)}`],
    ['Open, waiting for a payer', R(l.open.cents), `${n0(l.open.n)} links · ${n0(l.lapsed.n)} lapsed unpaid (${R(l.lapsed.cents)})`],
    ['If every open link is paid by card', R(l.ifOpenPaidByCard.feeCents), `fee revenue · ${R(l.ifOpenPaidByCard.marginCents)} after the card rail`],
    ['If each is then paid out by PayShap', R(l.ifThenPaidOut.feeCents), `${n0(l.ifThenPaidOut.n)} × R${(PAYSHAP_FEE_RAND).toFixed(0)} fees · ${R(l.ifThenPaidOut.marginCents)} after the rail`],
  ] : [];
  const loop = vl ? [
    ['Accounts from payment links', n0(vl.accountsFromLinks), `${vl.shareOfAccountsPct ?? '—'}% of all accounts · ${n0(vl.sendersWhoBroughtAccounts)} senders brought them`],
    ['Payers captured, not yet on WaPay', n0(vl.payersCapturedNotYetOnWaPay), `${n0(vl.contactsFromLinks)} contacts started from a link`],
  ] : [];
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Payment links and the viral loop <span className="note" style={{ display: 'inline', fontWeight: 400 }}>{stamp ? `· refreshed ${stamp}, every 10 minutes` : ''}</span></h2>
      <p className="note">The key figure: the value of the links customers have created, how much of it was paid and how, what is still open, and what the open links are worth in fees if they are paid by card and then paid out. Fees at today's schedule; rail costs from the commercials of record.</p>
      {!l && <div className="empty">Link figures unavailable.</div>}
      <div className="grid kpis">
        {[...tiles, ...loop].map(([k, val, sub]) => (<div className="card" key={k}><div className="k">{k}</div><div className="v">{val}</div><div className="vs">{sub}</div></div>))}
      </div>
      {l?.daily?.length > 1 && (
        <div className="grid two" style={{ marginTop: 12 }}>
          <div>
            <div className="k">Links over time, this period</div>
            <p className="note">Cumulative value created and paid, and how many links are open at the end of each day.</p>
            <DailyLines rows={cumulativeLinks(l.daily)} series={[{ key: 'createdRand', name: 'Created, R (cumulative)', color: 'var(--s1)' }, { key: 'paidRand', name: 'Paid, R (cumulative)', color: 'var(--good)' }, { key: 'open', name: 'Open links (count)', color: 'var(--s4)' }]} />
          </div>
          <div>
            <div className="k">Fee outlook from every link made so far</div>
            <p className="note">If every link made to date is paid by card: the card fee WaPay keeps, and the pay-out fees if the money then leaves by PayShap or as cash at an Absa or Nedbank ATM.</p>
            <DailyLines rows={l.daily.map((d) => ({ date: d.date, card: Math.round(d.cardFeeCents / 100), payshap: Math.round(d.payshapFeeCents / 100), cash: Math.round(d.cashFeeCents / 100) }))} series={[{ key: 'card', name: 'Card fees, R', color: 'var(--s1)' }, { key: 'payshap', name: 'PayShap pay-out fees, R', color: 'var(--good)' }, { key: 'cash', name: 'Cash pay-out fees, R', color: 'var(--s4)' }]} />
          </div>
        </div>
      )}
    </div>
  );
}
const PAYSHAP_FEE_RAND = 8;
function cumulativeLinks(daily) {
  let c = 0, p = 0;
  return daily.map((d) => { c += d.createdCents || 0; p += d.paidCents || 0; return { date: d.date, createdRand: Math.round(c / 100), paidRand: Math.round(p / 100), open: d.open || 0 }; });
}

/* The path (founder 2026-10-19, "all time, clear"): cumulative accounts from the first one ever, today's pace carried forward, the plan's point. */
function PathChartStatic({ series, t }) {
  if (!t || !series?.length) return <div className="empty">No accounts yet.</div>;
  const W = 560, H = 190, L = 46, Rr = 14, T = 14, B = 26;
  const horizonDays = t.monthsAhead * 30;
  const actual = series;
  const n = actual.length;
  const flat = Array.from({ length: Math.ceil(horizonDays / 7) + 1 }, (_, i) => ({ d: Math.min(horizonDays, i * 7), v: t.now.accounts + t.perDay.accounts * Math.min(horizonDays, i * 7) }));
  const g = t.weeklyGrowth;
  const comp = g != null ? flat.map(({ d }, i) => { let acc = t.now.accounts, wk = t.last7.accounts; for (let w = 0; w < i; w++) { wk *= 1 + g; acc += wk; } return { d, v: acc }; }) : null;
  const maxV = Math.max(10, ...flat.map((p) => p.v), ...(comp || []).map((p) => p.v), t.plan.ahead.accounts) * 1.08;
  const y = (v) => T + (H - T - B) * (1 - v / maxV);
  const totalDays = (n - 1) + horizonDays;
  const x = (i) => L + ((W - L - Rr) * i) / Math.max(1, totalDays);
  const step = maxV > 20000 ? 10000 : maxV > 5000 ? 2000 : maxV > 2000 ? 1000 : maxV > 500 ? 200 : 100;
  const ticks = []; for (let v = 0; v <= maxV; v += step) ticks.push(v);
  const lbl = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}m` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)));
  const actualPath = actual.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.accounts).toFixed(1)}`).join('');
  const off = n - 1;
  const flatPath = flat.map((p, i) => `${i ? 'L' : 'M'}${x(off + p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const compPath = comp ? comp.map((p, i) => `${i ? 'L' : 'M'}${x(off + p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join('') : null;
  const planX = x(off + horizonDays), planY = y(t.plan.ahead.accounts);
  const last = actual[n - 1];
  const mid = actual[Math.floor(n / 2)];
  return (
    <div>
      <div className="note" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span><i style={{ display: 'inline-block', width: 18, height: 3, background: 'var(--good)', marginRight: 5, verticalAlign: 3 }} />accounts, all time</span>
        <span><i style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2px dashed var(--s1)', marginRight: 5, verticalAlign: 3 }} />today's pace</span>
        {compPath && <span><i style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2px dotted var(--s4)', marginRight: 5, verticalAlign: 3 }} />compounding</span>}
        <span><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, border: '1.5px solid var(--ink3)', marginRight: 5, verticalAlign: -1 }} />plan at {t.horizon.label}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" style={{ width: '100%', height: 'auto' }}>
        {ticks.map((v) => (<g key={v}><line x1={L} x2={W - Rr} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeDasharray="2 4" /><text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--ink3)">{lbl(v)}</text></g>))}
        <path d={flatPath} fill="none" stroke="var(--s1)" strokeWidth={1.6} strokeDasharray="5 4" />
        {compPath && <path d={compPath} fill="none" stroke="var(--s4)" strokeWidth={1.6} strokeDasharray="2 3" />}
        <path d={actualPath} fill="none" stroke="var(--good)" strokeWidth={2.4} />
        {actual.map((p, i) => <circle key={p.date} cx={x(i)} cy={y(p.accounts)} r={n > 120 ? 1.2 : 2} fill="var(--good)"><title>{`${p.date}: ${p.accounts.toLocaleString('en-ZA')} accounts (+${p.newAccounts})`}</title></circle>)}
        <text x={x(off) + 4} y={y(last.accounts) - 6} fontSize="10" fontWeight="600" fill="var(--good)">{last.accounts.toLocaleString('en-ZA')} today</text>
        <circle cx={planX} cy={planY} r={3.5} fill="none" stroke="var(--ink3)" strokeWidth={1.5}><title>{`Plan at ${t.horizon.label}: ${t.plan.ahead.accounts.toLocaleString('en-ZA')} accounts`}</title></circle>
        <text x={planX - 6} y={planY - 7} textAnchor="end" fontSize="9" fill="var(--ink3)">plan {lbl(t.plan.ahead.accounts)}</text>
        <text x={x(off + horizonDays) - 2} y={y(flat[flat.length - 1].v) - 6} textAnchor="end" fontSize="9" fill="var(--s1)">{lbl(flat[flat.length - 1].v)} at today's pace</text>
        <text x={x(0)} y={H - 8} fontSize="9" fill="var(--ink3)">{actual[0].date}</text>
        {n > 20 && <text x={x(Math.floor(n / 2))} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--ink3)">{mid.date}</text>}
        <text x={x(off)} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--ink3)">today</text>
        <text x={W - Rr} y={H - 8} textAnchor="end" fontSize="9" fill="var(--ink3)">{t.horizon.label}</text>
      </svg>
    </div>
  );
}

/* The valuation path: the plan's monthly curve, the same model on the inputs measured so far, and today's pace held flat; hover any point. */
function ValuationPathStatic({ t, v }) {
  if (!t) return null;
  const planRows = simulate(preset('plan'), budgetFn(BUDGET_DEFAULT)).rows.slice(0, 13);
  const measuredInputs = Object.fromEntries((v?.measuredUsed || []).map((u) => [u.key, u.value]));
  const modelRows = Object.keys(measuredInputs).length ? simulate({ ...preset('plan'), ...measuredInputs }, budgetFn(BUDGET_DEFAULT)).rows.slice(0, 13) : null;
  const worthOf = (r) => Math.max(r.valRev, r.valActive);
  // Today's pace held flat: the seven-day revenue rate as a month, funded-per-month as actives, the higher frame, never below the floor.
  const pace = (() => {
    const revMonthRand = (t.perDay.revenueCents * 30) / 100;
    const actives = Math.max(t.now.actives, t.perDay.funded * 30);
    return Math.max(t.frames.floorRand, revMonthRand * 12 * t.frames.multiple, actives * t.frames.perActive);
  })();
  const W = 560, H = 170, L = 52, Rr = 14, T = 12, B = 24;
  const maxV = Math.max(...planRows.map(worthOf), ...(modelRows || []).map(worthOf), pace) * 1.08;
  const y = (val) => T + (H - T - B) * (1 - val / maxV);
  const x = (i) => L + ((W - L - Rr) * i) / 12;
  const label = (m) => planRows[m - 1] ? `${t.now.label.split(' ')[1]}`.slice(0, 0) + monthLabel(m) : '';
  function monthLabel(m) { const d = new Date(Date.UTC(2026, 9 + (m - 1), 1)); return d.toLocaleString('en-ZA', { month: 'short', year: '2-digit', timeZone: 'UTC' }); }
  const path = (rows, f) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(f(r)).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxV * f));
  return (
    <div>
      <div className="note" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span><i style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2px dashed var(--ink3)', marginRight: 5, verticalAlign: 3 }} />the plan</span>
        {modelRows && <span><i style={{ display: 'inline-block', width: 18, height: 3, background: 'var(--s1)', marginRight: 5, verticalAlign: 3 }} />model on measured inputs</span>}
        <span><i style={{ display: 'inline-block', width: 18, height: 3, background: 'var(--good)', marginRight: 5, verticalAlign: 3 }} />today's pace</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" style={{ width: '100%', height: 'auto' }}>
        {ticks.map((val) => (<g key={val}><line x1={L} x2={W - Rr} y1={y(val)} y2={y(val)} stroke="var(--grid)" strokeDasharray="2 4" /><text x={L - 6} y={y(val) + 3} textAnchor="end" fontSize="9" fill="var(--ink3)">{fmtR(val)}</text></g>))}
        <path d={path(planRows, worthOf)} fill="none" stroke="var(--ink3)" strokeWidth={1.6} strokeDasharray="5 4" />
        {planRows.map((r, i) => <circle key={`p${i}`} cx={x(i)} cy={y(worthOf(r))} r={2.5} fill="var(--ink3)"><title>{`Plan, ${monthLabel(r.m)}: ${fmtR(worthOf(r))} (${Math.round(r.cumOnb).toLocaleString('en-ZA')} accounts, ${Math.round(r.mau).toLocaleString('en-ZA')} actives, ${fmtR(Math.round(r.revenue))} a month)`}</title></circle>)}
        {modelRows && <path d={path(modelRows, worthOf)} fill="none" stroke="var(--s1)" strokeWidth={2} />}
        {modelRows && modelRows.map((r, i) => <circle key={`m${i}`} cx={x(i)} cy={y(worthOf(r))} r={2.5} fill="var(--s1)"><title>{`Model on measured inputs, ${monthLabel(r.m)}: ${fmtR(worthOf(r))} (${Math.round(r.cumOnb).toLocaleString('en-ZA')} accounts, ${Math.round(r.mau).toLocaleString('en-ZA')} actives, ${fmtR(Math.round(r.revenue))} a month)`}</title></circle>)}
        <path d={planRows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pace).toFixed(1)}`).join('')} fill="none" stroke="var(--good)" strokeWidth={2.4} />
        {planRows.map((r, i) => <circle key={`t${i}`} cx={x(i)} cy={y(pace)} r={2.5} fill="var(--good)"><title>{`Today's pace, ${monthLabel(r.m)}: ${fmtR(pace)} (${i === 0 ? 'now: ' : ''}${t.now.accounts.toLocaleString('en-ZA')} accounts today, ${t.now.actives} actives, R${(t.now.revenueMonthCents / 100).toFixed(0)} a month; the floor until net revenue grows)`}</title></circle>)}
        <text x={x(0)} y={H - 7} fontSize="9" fill="var(--ink3)">{monthLabel(1)}</text>
        <text x={x(6)} y={H - 7} textAnchor="middle" fontSize="9" fill="var(--ink3)">{monthLabel(7)}</text>
        <text x={W - Rr} y={H - 7} textAnchor="end" fontSize="9" fill="var(--ink3)">{monthLabel(13)}</text>
      </svg>
    </div>
  );
}

/* The insight (founder 2026-10-19): the biggest finding, what to work on, the most promising figure, from the measured inputs and the plan. Rules, not a model. */
const WORK_ON = {
  payersPerLink: 'Get the links that exist paid: follow up every sender after a day, make "forward it" the only step, and make the payer page obvious on a phone.',
  actToFund: 'Turn link-makers into funded accounts: the first paid link is the funding event, so the work is the same as getting links paid.',
  selfLoad: 'Give people who never make a link a reason to add money: one thing they can do with a balance today.',
  onbToAct: 'Get more new accounts to make their first link: the first-link prompt is the moment; test its wording and the example.',
  payerToOnb: 'Turn payers into members: the thank-you after a payment is the invitation.',
  convToOnb: 'Fewer drop-outs between the first message and the finished account: the code and PIN steps.',
  cpConv: 'The ad is cheap per conversation; keep the budget where it is and spend the effort on what happens after the first message.',
};
function insightFrom(v, t) {
  const used = v?.measuredUsed || [];
  const stops = used.filter((u) => u.status === 'stop');
  const greats = used.filter((u) => u.status === 'great');
  const fmt = (u) => `${u.label} ${u.unit === '%' ? u.value + '%' : u.unit === 'R' ? 'R' + u.value : u.value} against a plan of ${u.unit === '%' ? u.plan + '%' : u.unit === 'R' ? 'R' + u.plan : u.plan}`;
  const worst = stops[0] || null;
  const best = greats[0] || null;
  const finding = worst
    ? `Biggest finding: ${fmt(worst)}${worst.early ? ' (an early read, the cohort is young)' : ''}.`
    : used.length ? 'No measured input is below its stop line yet.' : 'Nothing measured yet; the plan stands as the only view.';
  const work = worst ? (WORK_ON[worst.key] || 'Work on the step that input measures before anything else.') : 'Keep the pipe open and wait for the first two-week cohort.';
  const promising = best ? `Most promising: ${fmt(best)}.` : t ? `Most promising: ${t.now.accounts.toLocaleString('en-ZA')} accounts against a plan of ${t.plan.toDate.accounts} by day ${t.dayOfLaunch}.` : '';
  const gap = t ? `Accounts run at ${t.plan.toDate.accounts ? Math.round((t.now.accounts / t.plan.toDate.accounts) * 100) : '—'}% of the plan to date, funded accounts at ${t.plan.toDate.funded ? Math.round((t.now.funded / t.plan.toDate.funded) * 100) : '—'}%.` : '';
  return { finding, work, promising, gap, worst, best, stops, greats };
}
function InsightBox({ v, t }) {
  if (!v) return null;
  const i = insightFrom(v, t);
  const Chip = ({ tone, children }) => <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, border: `1px solid ${tone}`, color: tone, marginRight: 8, whiteSpace: 'nowrap' }}>{children}</span>;
  return (
    <div className="card" style={{ marginTop: 14, borderColor: i.worst ? 'var(--crit)' : 'var(--good)' }}>
      <h2>Insight: what the numbers say today</h2>
      <p style={{ margin: '6px 0' }}><Chip tone="var(--crit)">finding</Chip>{i.finding}</p>
      <p style={{ margin: '6px 0' }}><Chip tone="var(--warn, #e3b341)">work on</Chip>{i.work}</p>
      <p style={{ margin: '6px 0' }}><Chip tone="var(--good)">promising</Chip>{i.promising}</p>
      {i.gap && <p className="note" style={{ margin: '6px 0 0' }}>{i.gap} Green = at or above the great line, yellow = on plan or too early, red = below the stop line, as the matrix measures them.</p>}
      {(i.stops.length > 1 || i.greats.length > 1) && (
        <p className="note" style={{ margin: '6px 0 0' }}>
          {i.stops.length > 1 && <>Also below the stop line: {i.stops.slice(1).map((u) => u.label).join(', ')}. </>}
          {i.greats.length > 1 && <>Also above the great line: {i.greats.slice(1).map((u) => u.label).join(', ')}.</>}
        </p>
      )}
    </div>
  );
}

/* ---------------- The pay-out float tile and the live valuation matrix ---------------- */

function FloatTile({ balancesCents, tick = 0 }) {
  const [f, setF] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setErr(false);
    fetch('/api/admin/floats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setF(d); })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, [tick]);
  const row = (f?.floats || []).find((x) => /payout/i.test(String(x.key || '')) || /pay-?out/i.test(String(x.name || '')));
  const cents = row?.api?.availableCents ?? null;
  const cover = cents != null && balancesCents > 0 ? Math.round((10 * cents) / balancesCents) / 10 : null;
  const val = err ? 'unavailable' : !f ? '…' : cents != null ? R(cents) : (row?.api?.configured === false ? 'no credentials' : 'unreadable');
  const sub = row ? `${row.low ? 'LOW · ' : ''}warn under ${R(row.warnCents)}${cover != null ? ` · ${cover}× of customer balances` : ''}` : 'OTT pay-out rail';
  return (
    <div className="card" style={row?.low ? { borderColor: 'var(--crit)' } : undefined}>
      <div className="k">Pay-out float</div>
      <div className="v" style={row?.low ? { color: 'var(--crit)' } : undefined}>{val}</div>
      <div className="vs">{sub}</div>
    </div>
  );
}

const SCENARIO_LABELS = {
  plan: 'Plan (13 Sep assessment)',
  now: 'Measured inputs, plan budget',
  nowCurrentSpend: 'Measured inputs, today\'s spend',
  great: 'Great case',
  stop: 'Stop-and-fix case',
};

function useGrowth(given, tick = 0) {
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (given) return undefined;
    let cancelled = false;
    fetch('/api/admin/growth?range=30')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setFetched(d || null); })
      .catch(() => { if (!cancelled) setFetched(false); });
    return () => { cancelled = true; };
  }, [given, tick]);
  return given || fetched;
}

/* The plan, where we are, the actual inputs, and where today's pace leads (founder, 2026-10-19). */
function PlanVsNow({ v }) {
  if (v === false) return <div className="empty">Could not load the projection.</div>;
  const t = v?.trajectory;
  if (!t) return <div className="empty">Projecting…</div>;
  const worth = (row) => Math.max(row.valRev, row.valActive);
  const basis = (row) => (worth(row) <= t.frames.floorRand ? 'the pre-traction floor' : row.valRev >= row.valActive ? 'revenue frame' : 'per-active frame');
  const pct = (g) => `${g >= 0 ? '+' : ''}${Math.round(g * 100)}% a week`;
  const h = t.horizon.label;
  const cols = [
    { key: 'planToDate', title: `Plan by day ${t.dayOfLaunch}`, sub: 'month 1 pro rata', row: t.plan.toDate },
    { key: 'now', title: 'Now', sub: `day ${t.dayOfLaunch} of the launch`, row: t.now, strong: true },
    { key: 'planAhead', title: `Plan, ${h}`, sub: `model month ${t.plan.ahead.month}`, row: t.plan.ahead },
    { key: 'flat', title: `Today's pace, ${h}`, sub: 'last 7 days held flat', row: t.flat },
    { key: 'compounded', title: `Compounding, ${h}`, sub: t.compounded ? pct(t.weeklyGrowth) : `needs two full weeks (from ${t.weeklyGrowthFrom})`, row: t.compounded },
    { key: 'model', title: `Model on measured inputs, ${h}`, sub: 'plan budget', row: t.model ? t.model.ahead : null },
  ];
  const lines = [
    ['Accounts', (r) => fmtN(r.accounts)],
    ['Funded accounts', (r) => fmtN(r.funded)],
    ['30-day actives', (r) => fmtN(r.actives)],
    ['Net revenue a month', (r) => R(r.revenueMonthCents)],
    ['Valuation, revenue frame', (r) => fmtR(r.valRev)],
    ['Valuation, per active user', (r) => fmtR(r.valActive)],
  ];
  const tiles = [
    ['Valuation today', fmtR(worth(t.now)), basis(t.now)],
    [`In ${t.monthsAhead} months at today's pace`, fmtR(worth(t.flat)), basis(t.flat)],
    [`Plan, ${h}`, fmtR(worth(t.plan.ahead)), basis(t.plan.ahead)],
    t.compounded ? [`Compounding at ${pct(t.weeklyGrowth)}, ${h}`, fmtR(worth(t.compounded)), basis(t.compounded)]
      : t.model ? [`Model on measured inputs, ${h}`, fmtR(worth(t.model.ahead)), basis(t.model.ahead)] : null,
  ].filter(Boolean);
  return (
    <div>
      <div className="grid kpis">
        {tiles.map(([k, val, sub]) => (<div className="card" key={k}><div className="k">{k}</div><div className="v">{val}</div><div className="vs">{sub}</div></div>))}
      </div>
      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <table style={{ minWidth: 900 }}>
          <thead><tr><th></th>{cols.map((c) => <th key={c.key} className="n">{c.title}<div className="note" style={{ margin: 0, fontWeight: 400 }}>{c.sub}</div></th>)}</tr></thead>
          <tbody>
            {lines.map(([label, f]) => (
              <tr key={label}><td>{label}</td>{cols.map((c) => <td key={c.key} className="n" style={c.strong ? { fontWeight: 700 } : undefined}>{c.row ? f(c.row) : '—'}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
        Actual inputs, last 7 days: {fmtN(t.last7.accounts)} accounts ({t.perDay.accounts.toFixed(1)} a day), {fmtN(t.last7.funded)} funded ({t.perDay.funded.toFixed(2)} a day), {R(t.last7.revenueCents)} net revenue ({R(Math.round(t.perDay.revenueCents))} a day); 30-day actives {fmtN(t.now.actives)}; net revenue last 30 days {R(t.now.revenueMonthCents)}.
        {' '}Weekly growth: {t.weeklyGrowth != null ? `${pct(t.weeklyGrowth)} (accounts, this week over last)` : `measured once two full weeks exist (from ${t.weeklyGrowthFrom}); until then the trajectory holds today's pace flat`}.
        {' '}Valuation frames as in the plan: {t.frames.multiple}× annualised net revenue (more with faster growth) or R{fmtN(t.frames.perActive)} per 30-day active, never below the {fmtR(t.frames.floorRand)} floor. The model's measured inputs are listed under the matrix below.
      </p>
    </div>
  );
}

/* One fetch for both cards: the plan-vs-now section and the matrix (the Growth tab passes its own data). */
function LiveValuation({ g: given = null, compact = false, minSample = null, tick = 0 }) {
  const g = useGrowth(given, tick);
  const v = g === false ? false : g ? g.valuation : null;
  const t = v?.trajectory;
  return (
    <>
      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>The path: accounts, actual and at today's pace</h2>
          <p className="note">Cumulative accounts since launch (solid), today's seven-day pace carried forward (dashed), compounding once two full weeks exist (dotted), the plan's point at the horizon (ring). Log scale.</p>
          {g === false ? <div className="empty">Could not load.</div> : !t ? <div className="empty">Measuring…</div> : <PathChart series={g.pathSeries} t={t} />}
        </div>
        <div className="card">
          <h2>Valuation: plan against today's pace</h2>
          <p className="note">The plan's month-by-month valuation (dashed) against today's pace held flat (solid), the higher of the two frames, never below the floor.</p>
          {g === false ? <div className="empty">Could not load.</div> : !t ? <div className="empty">Measuring…</div> : <ValuationPath t={t} v={v} />}
        </div>
      </div>
      <InsightBox v={v} t={t} />
      <div className="card" style={{ marginTop: 14 }}>
        <h2>The plan, where we are, and where today's pace leads</h2>
        <p className="note">The plan is the 13 September assessment (model month 1 = October 2026; launch day 1 = 18 October). Now is live. The trajectory takes the last seven days as a daily rate and holds it for six months; once two full weeks exist it also compounds at the measured weekly growth. Valuations use the plan's two frames and its floor.</p>
        <PlanVsNow v={v} />
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Valuation matrix, live</h2>
        <p className="note">Plan = the 13 September assessment. Measured = the same model with every input the data has measured (sample of {minSample ?? 20} or more) in place of its plan value, under the plan budget and under today's ad spend held flat; the rest stand at plan. The line under the table says which inputs were used.</p>
        <ValuationMatrix v={v} compact={compact} />
      </div>
    </>
  );
}

function ValuationMatrix({ v, compact = false }) {
  const [month, setMonth] = useState(12);
  if (v === false) return <div className="empty">Could not load the projection.</div>;
  if (!v) return <div className="empty">Projecting…</div>;
  const keys = compact ? ['plan', 'now', 'nowCurrentSpend'] : ['plan', 'now', 'nowCurrentSpend', 'great', 'stop'];
  const idx = v.months.indexOf(month) >= 0 ? v.months.indexOf(month) : 1;
  const m = v.months[idx];
  const ms = (sc, target) => { const x = (sc.milestones || []).find((y) => y.target === target); return x && x.month ? `M${x.month}` : 'beyond M36'; };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="note" style={{ margin: 0 }}>Read at month</span>
        <div className="tabs">{v.months.map((mm) => (
          <button key={mm} className={mm === m ? 'on' : ''} onClick={() => setMonth(mm)}>M{mm} · {v.monthLabels?.[mm]}</button>
        ))}</div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: compact ? 640 : 860 }}>
          <thead><tr><th>Scenario</th><th className="n">Accounts</th><th className="n">30-day actives</th><th className="n">Net revenue / mo</th><th className="n">Valuation, revenue frame</th><th className="n">Valuation, per active</th>{!compact && <th className="n">Peak funding</th>}{!compact && <th className="n">100k · 1m accounts</th>}</tr></thead>
          <tbody>
            {keys.map((k) => {
              const sc = v.scenarios[k]; const at = sc?.at?.[idx]; if (!at) return null;
              const strong = k === 'now';
              return (
                <tr key={k} style={strong ? { fontWeight: 700 } : undefined}>
                  <td>{SCENARIO_LABELS[k]}{k === 'nowCurrentSpend' ? <div className="note" style={{ margin: 0 }}>{fmtR(v.currentMonthlySpend)} a month, flat</div> : null}</td>
                  <td className="n">{fmtN(at.accounts)}</td>
                  <td className="n">{fmtN(at.actives)}</td>
                  <td className="n">{fmtR(at.revenueMonthly)}</td>
                  <td className="n">{fmtR(at.valRev)}</td>
                  <td className="n">{fmtR(at.valActive)}</td>
                  {!compact && <td className="n">{fmtR(sc.peakFunding)}</td>}
                  {!compact && <td className="n">{ms(sc, 100000)} · {ms(sc, 1000000)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
        Measured so far and used: {(v.measuredUsed || []).length ? v.measuredUsed.map((u) => `${u.label} ${u.unit === '%' ? u.value + '%' : u.unit === 'R' ? 'R' + u.value : u.value} (plan ${u.unit === '%' ? u.plan + '%' : u.unit === 'R' ? 'R' + u.plan : u.plan}, ${u.status}${u.early ? ', early read' : ''})`).join(' · ') : 'nothing yet'}. {v.assumedCount} inputs still at their plan value.{v.earlyCount ? ` "Early read" means accounts younger than 14 days were judged, because no older cohort exists yet; the measured table below keeps the stricter rule.` : ''}
      </p>
    </div>
  );
}

/* ---------------- Growth: the Scale Model's inputs, measured ---------------- */

const GROWTH_GROUPS = { ads: 'Paid acquisition', funnel: 'Funnel', loop: 'The loop', retention: 'Retention', econ: 'Economics', val: 'Valuation' };
const Rc = (c) => (c == null ? '—' : R(c));
const n0 = (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA'));
const pc = (v) => (v == null ? '—' : `${v}%`);

function StatusChip({ status }) {
  const map = {
    great: ['great', 'var(--good)'],
    plan: ['on plan', 'var(--accent-ink)'],
    stop: ['stop and fix', 'var(--crit)'],
    unknown: ['too early', 'var(--ink3)'],
  };
  const [label, color] = map[status] || map.unknown;
  return <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, border: `1px solid ${color}`, color, whiteSpace: 'nowrap' }}>{label}</span>;
}
function OnOff({ on, onText, offText }) {
  const color = on ? 'var(--good)' : 'var(--ink3)';
  return <span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, border: `1px solid ${color}`, color }}>{on ? onText : offText}</span>;
}
function fmtMeasured(m) {
  if (m.value == null) return '—';
  if (m.unit === 'R') return m.value >= 1000 ? Rw(m.value * 100) : `R${Math.round(m.value * 100) / 100}`;
  if (m.unit === '%' || m.unit === '% p.a.') return `${Math.round(m.value * 10) / 10}%`;
  if (m.unit === '×') return `${Number(m.value).toFixed(1)}×`;
  if (m.unit === 'M') return `M${m.value}`;
  if (m.unit === 'Rm') return `R${m.value}m`;
  return String(Math.round(m.value * 100) / 100);
}

// Bars for one rand series per day (spend), lines for people per day.
function DailyBarsStatic({ rows, pick, fmt }) {
  if (!rows?.length) return <div className="empty">No days in this period yet.</div>;
  const W = 560, H = 150, L = 8, B = 20, T = 12;
  const vals = rows.map((r) => pick(r) || 0);
  const mx = Math.max(...vals) || 1;
  const bw = Math.min(18, ((W - L) / rows.length) * 0.7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      {rows.map((r, i) => {
        const v = vals[i];
        const x = L + ((W - L) * (i + 0.5)) / rows.length - bw / 2;
        const h = ((H - T - B) * v) / mx;
        return (
          <g key={r.date}>
            {v > 0 && <rect x={x} y={H - B - h} width={bw} height={h} rx={2} fill="var(--s1)"><title>{`${r.date}: ${fmt(v)}`}</title></rect>}
            {(rows.length <= 10 || i % Math.ceil(rows.length / 8) === 0) && <text x={x + bw / 2} y={H - 6} textAnchor="middle">{r.date.slice(5)}</text>}
          </g>
        );
      })}
    </svg>
  );
}
function DailyLinesStatic({ rows, series }) {
  if (!rows?.length) return <div className="empty">No days in this period yet.</div>;
  const W = 560, H = 150, L = 8, Rr = 8, B = 20, T = 12;
  const mx = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] || 0)));
  const x = (i) => L + ((W - L - Rr) * (i + 0.5)) / rows.length;
  const y = (v) => H - B - ((H - T - B) * v) / mx;
  return (
    <>
      <div className="note" style={{ display: 'flex', gap: 14 }}>
        {series.map((s) => <span key={s.key}><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: s.color, marginRight: 5, verticalAlign: -1 }} />{s.name}</span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {series.map((s) => (
          <g key={s.key}>
            <path d={rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[s.key] || 0).toFixed(1)}`).join('')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            {rows.map((r, i) => <circle key={r.date} cx={x(i)} cy={y(r[s.key] || 0)} r={2.5} fill={s.color}><title>{`${r.date} · ${s.name}: ${r[s.key] || 0}`}</title></circle>)}
          </g>
        ))}
        {rows.map((r, i) => ((rows.length <= 10 || i % Math.ceil(rows.length / 8) === 0) ? <text key={r.date} x={x(i)} y={H - 6} textAnchor="middle">{r.date.slice(5)}</text> : null))}
      </svg>
    </>
  );
}

/* The sign-up funnel (2026-10-22, lib/signup-funnel.js): one-step and classic sign-ups side by side, per day. */
const FUNNEL_COLS = [['opened', 'Opened'], ['finished', 'Finished'], ['finished10m', 'In 10 min'], ['firstLink24h', 'Link in 24 h'], ['firstPaid72h', 'Paid in 72 h'], ['genuinePaid72h', 'Paid by someone else in 72 h'], ['payout72h', 'Pay-out in 72 h']];
function SignupFunnelCard({ range }) {
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setErr('');
    fetch(`/api/admin/signup-funnel?range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) setF(d); })
      .catch(() => { if (live) setErr('Could not load the sign-up funnel.'); });
    return () => { live = false; };
  }, [range]);
  if (err || !f) return <div className="card" style={{ marginTop: 14 }}><h2>Sign-up funnel</h2><div className="empty">{err || 'Measuring…'}</div></div>;
  const rows = (f.days || []).map((d) => ({ date: d.date, oneStep: d.byPath.ONE_STEP.rates.finished, classic: d.byPath.CLASSIC.rates.finished, link: d.total.rates.firstLink24h }));
  const cell = (c, k) => (k === 'opened' ? n0(c.opened) : `${n0(c[k])}${c.rates?.[k] != null ? ` (${c.rates[k]}%)` : ''}`);
  const fl = f.flags || {};
  const sw = (x) => (x?.everyone ? 'on for everyone' : x?.listed ? `on for ${x.listed} number${x.listed === 1 ? '' : 's'}` : 'off');
  const summary = [['One-step', f.summary?.byPath?.ONE_STEP], ['Classic', f.summary?.byPath?.CLASSIC], ['All', f.summary?.total]].filter(([, c]) => c);
  const dayRows = [...(f.days || [])].reverse().flatMap((d) => ['ONE_STEP', 'CLASSIC'].filter((p) => d.byPath[p].opened > 0).map((p) => ({ d, p })));
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Sign-up funnel</h2>
      <p className="note">Accounts opened per day, by the path they were opened on: one-step (the first message opens the account) or classic (welcome, code, PIN, consent). Rates are of the accounts opened that day; a day younger than a measure's window is still filling. One-step {sw(fl.oneStep)} · deferred PIN {sw(fl.pinOnDemand)} · payer pre-registration {sw(fl.payerPreregister)}. Internal: GET /api/internal/funnel.</p>
      <DailyLines rows={rows} series={[
        { key: 'oneStep', name: 'One-step finished %', color: 'var(--s1)' },
        { key: 'classic', name: 'Classic finished %', color: 'var(--s4)' },
        { key: 'link', name: 'First link in 24 h %, all', color: 'var(--s3)' },
      ]} />
      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <table>
          <thead><tr><th>Path, this period</th>{FUNNEL_COLS.map(([k, label]) => <th key={k} className="n">{label}</th>)}</tr></thead>
          <tbody>{summary.map(([label, c]) => <tr key={label}><td>{label}</td>{FUNNEL_COLS.map(([k]) => <td key={k} className="n">{cell(c, k)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {dayRows.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table>
            <thead><tr><th>Day</th><th>Path</th>{FUNNEL_COLS.map(([k, label]) => <th key={k} className="n">{label}</th>)}</tr></thead>
            <tbody>{dayRows.map(({ d, p }) => (
              <tr key={d.date + p}><td>{d.date}</td><td>{p === 'ONE_STEP' ? 'one-step' : 'classic'}</td>{FUNNEL_COLS.map(([k]) => <td key={k} className="n">{cell(d.byPath[p], k)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Growth() {
  const [range, setRange] = useState('30');
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback((refresh) => {
    setErr('');
    setBusy(true);
    return fetch(`/api/admin/growth?range=${range}${refresh ? '&refresh=1' : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setG(d))
      .catch(() => setErr('Could not load the growth numbers.'))
      .finally(() => setBusy(false));
  }, [range]);
  useEffect(() => { load(false); }, [load]);
  useEffect(() => { const id = setInterval(() => load(true), REFRESH_MS); return () => clearInterval(id); }, [load]);
  if (err) return <div className="card"><div className="empty">{err}</div></div>;
  if (!g) return <div className="card"><div className="empty">Measuring…</div></div>;
  const k = g.kpis || {}, st = g.status || {}, lp = g.loop || {}, ms = g.messages || {};
  const measured = Object.values(g.measured || {});
  const grouped = Object.keys(GROWTH_GROUPS).map((grp) => [grp, measured.filter((m) => m.group === grp)]);
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="tabs">{['7', '30', '90', 'all'].map((r) => (
          <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === 'all' ? 'All' : r + 'd'}</button>
        ))}</div>
        <OnOff on={st.attribution} onText="Attribution live" offText="Attribution off" />
        <OnOff on={st.adsConfigured} onText={`Meta Ads API on · fetched ${st.adsLastFetchedAt ? dt(st.adsLastFetchedAt) : 'never'}`} offText="Meta Ads API off: credentials missing (META_ADS_ACCESS_TOKEN + META_AD_ACCOUNT_ID)" />
        <OnOff on={st.capiConfigured} onText={`Conversions API on · ${st.capiLeadSent ?? 0} leads · ${st.capiPurchaseSent ?? 0} purchases sent`} offText={st.capiReason === 'NOT_PRODUCTION' ? `Conversions API held: ${st.vercelEnv || 'non-production'} build, events only send from Production` : 'Conversions API off: credentials missing (META_CAPI_DATASET_ID)'} />
        <span className="spacer" />
        {st.adsConfigured && <button className="linkish" disabled={busy} onClick={() => load(true)}>{busy ? 'Refreshing…' : 'Refresh ad numbers'}</button>}
        <a className="linkish" href={g.scenarioUrl} target="_blank" rel="noreferrer">Open the Scale Model with measured inputs ↗</a>
      </div>
      <div className="grid kpis">
        {[
          ['Ad spend, period', Rc(k.spendCents), st.adsConfigured ? 'from Meta' : 'Meta Ads API not connected'],
          ['Conversations started', n0(k.conversations), 'Meta: messaging_conversation_started_7d'],
          ['Cost per conversation', Rc(k.costPerConversationCents), 'spend ÷ conversations'],
          ['Accounts from ads', n0(k.adOnboarded), `${n0(k.adContacts)} ad contacts · ${pc(k.convToAccountPct)} of conversations`],
          ['Cost per account', Rc(k.costPerAccountCents), 'onboarding complete, ad-attributed'],
          ['Funded from ads', n0(k.adFunded), `cost per funded ${Rc(k.costPerFundedCents)}`],
          ['Accounts, all sources', n0(k.accountsTotal), `${n0(k.contactsTotal)} contacts ever · ${n0(k.mau)} active in 30d`],
          ['Revenue per active', g.measured?.arpu?.value != null ? `R${g.measured.arpu.value}` : '—', `per month · ${Rc(k.revenueCents)} this period`],
        ].map(([kk, val, sub]) => (
          <div className="card" key={kk}><div className="k">{kk}</div><div className="v">{val ?? '—'}</div><div className="vs">{sub}</div></div>
        ))}
      </div>

      <LiveValuation g={g} minSample={g.minSample} />

      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Ad spend per day</h2>
          <p className="note">From ad_insights_daily, snapshotted from Meta by the daily cron or the refresh button.</p>
          <DailyBars rows={g.daily} pick={(r) => r.spendCents} fmt={R} />
        </div>
        <div className="card">
          <h2>People per day</h2>
          <p className="note">Conversations started (Meta) against accounts completed and first funded (our ledger), all sources.</p>
          <DailyLines rows={g.daily} series={[
            { key: 'conversations', name: 'Conversations', color: 'var(--s4)' },
            { key: 'onboarded', name: 'Accounts', color: 'var(--s1)' },
            { key: 'funded', name: 'Funded', color: 'var(--s3)' },
          ]} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>The funnel, by where people came from</h2>
        <p className="note">Contacts = every number that ever messaged. Accounts = OTP, PIN and consent done. Activated = created a first payment link. Funded = first money in. Active = a money event in the last 30 days.</p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Source</th><th className="n">Contacts</th><th className="n">Accounts</th><th className="n">Activated</th><th className="n">Funded</th><th className="n">Active 30d</th><th className="n">New accounts, period</th></tr></thead>
            <tbody>
              {(g.funnelBySource || []).map((f) => (
                <tr key={f.src}><td>{f.src}</td><td className="n">{n0(f.contacts)}</td><td className="n">{n0(f.onboarded)}</td><td className="n">{n0(f.activated)}</td><td className="n">{n0(f.funded)}</td><td className="n">{n0(f.active30)}</td><td className="n">{n0(f.newInWindow)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <SignupFunnelCard range={range} />

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Per ad, this period</h2>
        <p className="note">Meta's spend and conversations next to the accounts each ad actually produced (stamped from the click id on the first message).</p>
        {!(g.ads || []).length ? <div className="empty">{st.adsConfigured ? 'No ad rows in this period yet.' : 'Connect the Meta Ads API to see spend per ad; accounts per ad already count from the click id.'}</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 820 }}>
              <thead><tr><th>Ad</th><th>Campaign</th><th className="n">Spend</th><th className="n">Impr.</th><th className="n">Clicks</th><th className="n">Conversations</th><th className="n">R / conv.</th><th className="n">Accounts</th><th className="n">R / account</th><th className="n">Funded</th><th className="n">R / funded</th></tr></thead>
              <tbody>
                {g.ads.map((a) => (
                  <tr key={a.adId}>
                    <td title={a.headline || ''}>{a.name}{a.headline ? <div className="note" style={{ margin: 0 }}>{a.headline}</div> : null}</td>
                    <td>{a.campaign || '—'}</td>
                    <td className="n">{R(a.spendCents)}</td><td className="n">{n0(a.impressions)}</td><td className="n">{n0(a.clicks)}</td>
                    <td className="n">{n0(a.conversations)}</td><td className="n">{Rc(a.costPerConversationCents)}</td>
                    <td className="n">{n0(a.onboarded)}</td><td className="n">{Rc(a.costPerAccountCents)}</td>
                    <td className="n">{n0(a.funded)}</td><td className="n">{Rc(a.costPerFundedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(g.entryBreakdown || []).length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Which question brought them in</h2>
          <p className="note">Ad arrivals by the suggested question they tapped (or typed), and how far each group got. Reminders sent {n0(g.reminders?.sent)} · opted out {n0(g.reminders?.optedOut)}.</p>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Entry</th><th className="n">Contacts</th><th className="n">Accounts</th><th className="n">Activated</th><th className="n">Funded</th></tr></thead>
              <tbody>{g.entryBreakdown.map((e) => (
                <tr key={e.entry}><td>{e.label}</td><td className="n">{n0(e.contacts)}</td><td className="n">{n0(e.onboarded)}</td><td className="n">{n0(e.activated)}</td><td className="n">{n0(e.funded)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <h2>The Scale Model's inputs, measured</h2>
        <p className="note">Each input the planning model assumes, with what the data says so far. A value counts once its sample reaches {g.minSample}; until then the plan case stands and the chip reads “too early”. The link above opens the model with every measured value in place.</p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 700 }}>
            <thead><tr><th>Input</th><th className="n">Measured</th><th className="n">Sample</th><th className="n">Plan</th><th className="n">Great</th><th className="n">Stop</th><th>Status</th></tr></thead>
            <tbody>
              {grouped.map(([grp, items]) => items.length ? [
                <tr key={grp + '-h'}><td colSpan={7} className="k" style={{ paddingTop: 10 }}>{GROWTH_GROUPS[grp]}</td></tr>,
                ...items.map((m) => (
                  <tr key={m.key}>
                    <td>{m.label}{!m.measurable && <div className="note" style={{ margin: 0 }}>plan assumption, not measured here</div>}</td>
                    <td className="n"><b>{fmtMeasured(m)}</b></td>
                    <td className="n">{m.measurable ? n0(m.n) : '—'}</td>
                    <td className="n">{fmtMeasured({ ...m, value: m.plan })}</td>
                    <td className="n">{fmtMeasured({ ...m, value: m.great })}</td>
                    <td className="n">{fmtMeasured({ ...m, value: m.stop })}</td>
                    <td>{m.measurable ? <StatusChip status={m.status} /> : null}</td>
                  </tr>
                )),
              ] : null)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>The loop</h2>
          <p className="note">K = links per active × payers per link × payer-to-account. Trees credit each ad-acquired account with the accounts whose first paid link was theirs.</p>
          <table>
            <tbody>
              <tr><td>Links created, period</td><td className="n">{n0(lp.linksCreated)}</td></tr>
              <tr><td>Paid links · distinct payers</td><td className="n">{n0(lp.paidLinks)} · {n0(lp.payers)}</td></tr>
              <tr><td>Links per active per month</td><td className="n">{lp.linksPerActive != null ? lp.linksPerActive.toFixed(2) : '—'}</td></tr>
              <tr><td>Payers per link</td><td className="n">{lp.payersPerLink != null ? lp.payersPerLink.toFixed(2) : '—'}</td></tr>
              <tr><td>Captured payers → accounts, all time</td><td className="n">{n0(lp.capturedPayers)} → {n0(lp.paylinkAccounts)} ({pc(lp.payerToOnbPct)})</td></tr>
              <tr><td><b>K</b></td><td className="n"><b>{lp.K != null ? lp.K.toFixed(2) : '—'}</b></td></tr>
              <tr><td>Ad-acquired accounts · downstream level 1 · level 2</td><td className="n">{n0(lp.adAcquired)} · {n0(lp.downstream1)} · {n0(lp.downstream2)}</td></tr>
              <tr><td>Tree factor (downstream per ad-acquired)</td><td className="n">{lp.treeFactor != null ? lp.treeFactor.toFixed(2) : '—'}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Messages, the cost that scales with actives</h2>
          <p className="note">Replies WaPay sent in the period. From 1 October 2026 Meta charges service replies after 1,000 free per number per month, about R0.13 each in South Africa.</p>
          <table>
            <tbody>
              <tr><td>Replies sent, period</td><td className="n">{n0(ms.assistantTurns)}</td></tr>
              <tr><td>Replies per active per month</td><td className="n">{ms.perActive ?? '—'}</td></tr>
              <tr><td>Replies per money event</td><td className="n">{ms.perEvent != null ? ms.perEvent.toFixed(1) : '—'}</td></tr>
              <tr><td>Message cost per active per month</td><td className="n">{Rc(ms.costPerActiveCents)}</td></tr>
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>Retention, monthly funded cohorts</h2>
          <p className="note">Share of each month's newly funded accounts with a money event one, two, three and six months later.</p>
          {!(g.cohorts || []).length ? <div className="empty">No funded cohorts yet.</div> : (
            <table>
              <thead><tr><th>Funded in</th><th className="n">Size</th><th className="n">+1</th><th className="n">+2</th><th className="n">+3</th><th className="n">+6</th></tr></thead>
              <tbody>{g.cohorts.map((c) => (
                <tr key={c.month}><td>{c.month}</td><td className="n">{c.size}</td><td className="n">{pc(c.m1)}</td><td className="n">{pc(c.m2)}</td><td className="n">{pc(c.m3)}</td><td className="n">{pc(c.m6)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
      <p className="note" style={{ marginTop: 12 }}>generated {dt(g.generatedAt)} · aggregates only, no customer identifiers leave the server · funnel hops are judged on accounts opened 14 to 44 days ago so everyone had two weeks to act.</p>
    </>
  );
}

/* A person answers the customer inside their WhatsApp chat (founder 2026-10-19). One text, inside their 24-hour window, remembered by the chat. */
function ReplyBox({ accountId, name }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const send = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/admin/ops-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, text }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { setMsg('Sent. The chat remembers it as its own message.'); setText(''); }
      else if (r.status === 409) setMsg('Their 24-hour window is closed (no message from them in the last day), so a plain text cannot be delivered.');
      else setMsg(j.error ? `Not sent: ${j.error}` : 'Not sent.');
    } catch { setMsg('Not sent: network error.'); }
    setBusy(false);
  }, [accountId, text]);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="k">Reply in their WhatsApp chat</div>
      <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 1500))} rows={4} placeholder={`Hi ${(name || '').split(' ')[0] || 'there'}, this is the WaPay team…`} style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid var(--grid)', background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13 }} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <button className="searchrow-btn" style={{ padding: '8px 14px', border: 0, borderRadius: 8, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }} disabled={busy || !text.trim()} onClick={send}>{busy ? 'Sending…' : 'Send as WaPay'}</button>
        <span className="note" style={{ margin: 0 }}>{text.length}/1500 · sent from WaPay's WhatsApp, recorded in their chat</span>
        {msg && <span className="note" style={{ margin: 0, color: 'var(--ink2)' }}>{msg}</span>}
      </div>
    </div>
  );
}

function Customer({ initialQuery = '' }) {
  const [q, setQ] = useState(initialQuery || '');
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

  // A deep link (?customer=…) opens that profile once, after openCustomer exists (2026-10-20: declared before it, the tab crashed).
  const openedInitial = useRef(false);
  useEffect(() => { if (initialQuery && !openedInitial.current) { openedInitial.current = true; openCustomer(initialQuery); } }, [initialQuery, openCustomer]);

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
                    <td>{cu.displayName || <span style={{ color: 'var(--ink3)' }}>—</span>} <a href={`/admin?tab=customer&customer=${encodeURIComponent(cu.msisdn)}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open on its own page" style={{ marginLeft: 6, fontSize: 11 }}>↗</a></td>
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
              <ReplyBox accountId={c.account.id} name={c.account.displayName} />
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
              {c.payoutFreeze && (
                <p className="note" style={{ marginTop: 10, color: 'var(--red, #b42318)' }}>
                  ⏸ Pay-outs and outbound sends frozen since {dt(c.payoutFreeze.at)}{c.payoutFreeze.reason ? ` · ${c.payoutFreeze.reason}` : ''}{c.payoutFreeze.by ? ` · by ${c.payoutFreeze.by}` : ''}. Receiving still works. Lift it with POST /api/internal/payout-freeze.
                </p>
              )}
              {c.activeHolds?.length > 0 && (
                <p className="note" style={{ marginTop: 10 }}>
                  Holds: {c.activeHolds.map((h) => `${R(h.amountCents)} (${h.reason || 'no reason'})`).join(' · ')}
                </p>
              )}
            </div>
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <h2>Conversation and support <span className="note" style={{ display: 'inline', fontWeight: 400 }}>· everything they asked WaPay, and what WaPay and the team said</span></h2>
            <ConversationCard accountId={c.account.id} />
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
              <h2>Referrals</h2>
              <p className="note">The customer asks for the invite in chat; the friend taps the link and writes first. Rewards are tracked now and paid only when the switch is on.</p>
              {c.referrals ? (
                <>
                  <div style={{ display: 'flex', gap: 26, marginTop: 8, flexWrap: 'wrap' }}>
                    <div><div className="k">Invited</div><div className="bal">{c.referrals.invited || 0}</div></div>
                    <div><div className="k">Opened an account</div><div className="bal">{c.referrals.onboarded || 0}</div></div>
                    <div><div className="k">Funded</div><div className="bal">{c.referrals.funded || 0}</div></div>
                    <div><div className="k">Got paid</div><div className="bal">{c.referrals.paid || 0}</div></div>
                    <div><div className="k">Reward eligible</div><div className="bal">{R(c.referrals.rewardEligibleCents || 0)}</div><div className="vs">paid {R(c.referrals.rewardPaidCents || 0)} · {c.referrals.rewardsOn ? 'rewards on' : 'tracked only'}</div></div>
                  </div>
                  <p className="note" style={{ marginTop: 10 }}>Code {c.referrals.code || 'not asked for yet'}{c.referrals.link ? ` · ${c.referrals.link}` : ''}</p>
                </>
              ) : <div className="empty">No referral data for this customer.</div>}
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

/* ---------------- Health, Supplier Floats, the Inbox and the conversation card (founder 2026-10-19) ---------------- */

function useMetrics(range = '30', tick = 0) {
  const [m, setM] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/metrics?range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setM(d); })
      .catch(() => { if (!cancelled) setErr('Could not load metrics.'); });
    return () => { cancelled = true; };
  }, [range, tick]);
  return [m, err];
}

function Health() {
  const [tick, setTick] = useState(0);
  const [m, err] = useMetrics('30', tick);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS); return () => clearInterval(id); }, []);
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <button className="linkish" onClick={() => setTick((t) => t + 1)}>↻ Refresh</button>
        <span className="note" style={{ margin: 0 }}>{m ? `generated ${dt(m.generatedAt)}` : ''} · refreshes itself every 10 minutes</span>
      </div>
      <QualityCard tick={tick} />
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Money-engine health</h2>
        <p className="note">If any of these is red, treat every number on the Dashboard as suspect until it is fixed.</p>
        {err ? <div className="empty">{err}</div> : !m ? <div className="empty">Checking…</div> : <OpsHealth ops={m.ops} />}
      </div>
      <AuditPanel tick={tick} />
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Conversations and the Pay agent</h2>
        <p className="note">Both sides of every chat, what the agent answered behind the shadow list, what it cost, which output gates fired, and any pay-out still parked with the bank rail.</p>
        <Conversations />
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Pay-out reconciliation</h2>
        <p className="note">What WaPay owes its customers, what is held for pay-outs, what the journal says was paid out, and whether every pay-out's three records agree. Red means a customer or the float is out of pocket until someone looks.</p>
        <PayoutBooks />
      </div>
    </>
  );
}

/* Meta's view of the WhatsApp number (2026-10-20): the quality rating decides whether WaPay may start any conversation at all. */
function QualityCard({ tick = 0 }) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/whatsapp-quality').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d) => { if (!cancelled) setQ(d); }).catch(() => { if (!cancelled) setQ(false); });
    return () => { cancelled = true; };
  }, [tick]);
  const rating = q && q.qualityRating;
  const tone = rating === 'GREEN' ? 'var(--good)' : rating === 'YELLOW' ? 'var(--warn, #e3b341)' : rating ? 'var(--crit)' : 'var(--ink3)';
  return (
    <div className="card" style={{ borderColor: rating && rating !== 'GREEN' ? 'var(--crit)' : undefined }}>
      <h2>WhatsApp number, as Meta sees it</h2>
      <p className="note">The quality rating is built from blocks and reports. While it is not GREEN, WaPay sends nothing a customer did not just ask for: reminders stay off, replies only, one message per turn.</p>
      <div className="grid kpis">
        <div className="card"><div className="k">Quality rating</div><div className="v" style={{ color: tone }}>{q === false ? 'unavailable' : !q ? '…' : rating || (q.error || 'unknown')}</div><div className="vs">{q && q.messagingLimitTier ? `messaging limit ${q.messagingLimitTier}` : 'read from the Graph API, cached for a minute'}</div></div>
        <div className="card"><div className="k">Number status</div><div className="v">{q && q.status ? q.status : '…'}</div><div className="vs">{q && q.nameStatus ? `display name ${q.nameStatus}` : ''}</div></div>
        <div className="card" style={{ borderColor: q && q.delivery && q.delivery.verdict === 'STALLED' ? 'var(--crit)' : undefined }}>
          <div className="k">Delivery, last hour</div>
          <div className="v" style={{ color: q && q.delivery ? (q.delivery.verdict === 'OK' ? 'var(--good)' : q.delivery.verdict === 'DEGRADED' ? 'var(--warn, #e3b341)' : q.delivery.verdict === 'STALLED' ? 'var(--crit)' : 'var(--ink3)') : undefined }}>
            {!q ? '…' : !q.delivery || q.delivery.verdict === 'UNKNOWN' ? 'unknown' : `${q.delivery.last60.ok} delivered · ${q.delivery.last60.failed} failed`}
          </div>
          <div className="vs">{q && q.delivery && q.delivery.verdict !== 'UNKNOWN' ? (q.delivery.verdict === 'OK' ? `delivery ok · 24 h: ${q.delivery.last24h.ok} delivered, ${q.delivery.last24h.failed} failed` : `${q.delivery.verdict}${q.delivery.code ? ` · Meta code ${q.delivery.code}` : ''}${q.delivery.last24h?.firstFailAt ? ` · since ${dt(q.delivery.last24h.firstFailAt)}` : ''}`) : 'from Meta\'s delivery statuses on the webhook'}</div>
        </div>
        <div className="card" style={{ borderColor: q && q.compliance && q.compliance.verdict === 'RED' ? 'var(--crit)' : undefined }}>
          <div className="k">Meta compliance, last 24 h</div>
          <div className="v" style={{ color: q && q.compliance ? (q.compliance.verdict === 'GREEN' ? 'var(--good)' : q.compliance.verdict === 'AMBER' ? 'var(--warn, #e3b341)' : q.compliance.verdict === 'RED' ? 'var(--crit)' : 'var(--ink3)') : undefined }}>
            {!q ? '…' : q.compliance ? q.compliance.verdict : 'unknown'}
          </div>
          <div className="vs">{q && q.compliance ? (q.compliance.reasons && q.compliance.reasons.length ? q.compliance.reasons.slice(0, 3).map((r) => r.text).join(' ') : 'every rule held: no marketing, no reminders, stop honoured, one reply per message') : 'checked daily; alerts ops when anything drifts'}</div>
        </div>
        <div className="card"><div className="k">Support contact on the profile</div><div className="v" style={{ color: q && q.profile ? (q.profile.hasSupportContact ? 'var(--good)' : 'var(--crit)') : undefined }}>{q && q.profile ? (q.profile.hasSupportContact ? 'yes' : 'missing') : '…'}</div><div className="vs">{q && q.profile ? [q.profile.email, ...(q.profile.websites || [])].filter(Boolean).join(' · ') || 'the Messaging Policy asks for an e-mail or website' : ''}</div></div>
      </div>
    </div>
  );
}

/* The daily conversation audit (built alongside this tab; reads /api/admin/audit when it exists). */
function AuditPanel({ tick = 0 }) {
  const [a, setA] = useState(null);
  const [state, setState] = useState('loading');
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetch('/api/admin/audit')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) { setA(d); setState('ok'); } })
      .catch((e) => { if (!cancelled) setState(String(e?.message) === '404' ? 'absent' : 'error'); });
    return () => { cancelled = true; };
  }, [tick]);
  const sevTone = (sev) => (sev === 'P1' ? 'var(--crit)' : sev === 'P2' ? 'var(--warn, #e3b341)' : 'var(--ink3)');
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Conversation audit, daily</h2>
      <p className="note">Every new conversation is swept and reviewed against what is true today, findings are stored with their recurrence, and the bugs found, open and resolved are counted over time. The checker reads the live product registry, so a feature launch updates it.</p>
      {state === 'loading' && <div className="empty">Reading…</div>}
      {state === 'absent' && <div className="empty">The daily audit is being built; its first run will appear here.</div>}
      {state === 'error' && <div className="empty">Could not read the audit.</div>}
      {state === 'ok' && a && (
        <>
          <div className="grid kpis">
            {[
              ['Open', n0(a.counts?.open), a.latestRun ? `latest run ${dt(a.latestRun.finishedAt || a.latestRun.startedAt)}` : 'no run yet'],
              ['Recurring', n0(a.counts?.recurring), 'seen in two or more runs'],
              ['Resolved', n0(a.counts?.resolved), 'gone for two runs or marked by hand'],
              ['Latest run', a.latestRun ? `${n0(a.latestRun.findings?.P1)} · ${n0(a.latestRun.findings?.P2)} · ${n0(a.latestRun.findings?.P3)}` : '—', a.latestRun ? `P1 · P2 · P3 over ${n0(a.latestRun.accounts)} accounts, ${n0(a.latestRun.turns)} turns${a.latestRun.reviewed ? '' : ' (rules only, no model review)'}` : ''],
            ].map(([k, val, sub]) => (<div className="card" key={k}><div className="k">{k}</div><div className="v">{val ?? '—'}</div><div className="vs">{sub}</div></div>))}
          </div>
          {a.trend?.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <div className="k">Bugs found, resolved and open, per run</div>
              <DailyLines rows={a.trend} series={[{ key: 'found', name: 'Found', color: 'var(--crit)' }, { key: 'resolved', name: 'Resolved', color: 'var(--good)' }, { key: 'open', name: 'Open', color: 'var(--s1)' }]} />
            </div>
          )}
          {a.recurring?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="k">Recurring</div>
              <ul className="note" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{a.recurring.slice(0, 10).map((f) => <li key={f.fingerprint}><b style={{ color: sevTone(f.severity) }}>{f.severity}</b> {f.title} · {n0(f.occurrences)} times</li>)}</ul>
            </div>
          )}
          {a.findings?.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table>
                <thead><tr><th>Sev</th><th>Category</th><th>Finding</th><th className="n">Accounts</th><th className="n">Seen</th><th>Status</th></tr></thead>
                <tbody>{a.findings.slice(0, 60).map((f) => (
                  <tr key={f.id || f.fingerprint}><td><b style={{ color: sevTone(f.severity) }}>{f.severity}</b></td><td className="note" style={{ margin: 0 }}>{f.category}</td><td title={f.why || ''}>{f.title}</td><td className="n">{n0(f.accounts)}</td><td className="n">{n0(f.occurrences)}</td><td><span className={`pill ${f.status === 'resolved' ? 'g' : f.status === 'recurring' ? 'r' : 'y'}`}>{f.status}</span></td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {!a.findings?.length && <div className="empty">No findings stored yet.</div>}
        </>
      )}
    </div>
  );
}

/* ---------------- Pay-out requests with the fraud triage (founder 2026-10-24) ---------------- */
const LEVEL_PILL = { 1: 'g', 2: 'g', 3: 'y', 4: 'r', 5: 'r' };
const PAYOUT_OUTCOME = { SETTLED: 'paid', PENDING: 'with the bank', REVIEW: 'held for your check', FROZEN: 'refused: frozen', PAYOUT_HOLD: 'refused: paused', DAILY_CAP: 'refused: daily cap', KYC_REQUIRED: 'refused: ID check', FEE_CHANGED: 'stopped: fee changed', INSUFFICIENT_FUNDS: 'refused: balance', FLOAT_SHORT: 'refused: float empty', NOT_AUTHORISED: 'refused: no PIN' };
function PayoutRequests({ tick }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [again, setAgain] = useState(0);
  useEffect(() => {
    fetch('/api/admin/payout-requests?days=7').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(setD).catch((e) => setErr(e.message || 'failed'));
  }, [tick, again]);
  const act = async (q, decision) => {
    const what = decision === 'clear' ? `Clear ${q.phone || 'this account'} past the review for 72 hours? The cap, the ID check and the pause still apply.` : `Freeze pay-outs and sends for ${q.phone || 'this account'}? Receiving money stays open.`;
    if (!window.confirm(what)) return;
    setBusy(`${q.accountId}:${decision}`);
    try {
      const r = await fetch('/api/admin/payout-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: q.accountId, decision }) });
      if (!r.ok) setErr(`That did not work (${r.status}).`);
      setAgain((n) => n + 1);
    } finally { setBusy(''); }
  };
  if (err) return <p className="err">Pay-out requests could not be read ({err}).</p>;
  if (!d) return <p className="empty">Loading pay-out requests…</p>;
  return (
    <>
      {d.hold?.held ? <p className="pill r" style={{ fontSize: 12.5, padding: '6px 12px', marginBottom: 10 }}>⏸ Pay-outs are paused for everyone since {new Date(d.hold.since).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}. Nothing leaves until you reopen them.</p> : null}
      <p className="note" style={{ marginTop: 0 }}>Last 7 days by fraud level: {[5, 4, 3, 2, 1].map((l) => `${l}: ${d.byLevel?.[l] ?? 0}`).join(' · ')}. Level 4 and 5 wait for your check (Clear lets one account through for 72 hours); you get every request on WhatsApp and e-mail.</p>
      {!d.requests?.length ? <p className="empty">No pay-out requests in the last 7 days.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 760 }}>
            <thead><tr><th>When</th><th>Account</th><th className="n">Amount</th><th>Level</th><th>Why</th><th>Result</th><th></th></tr></thead>
            <tbody>
              {d.requests.map((q, i) => (
                <tr key={`${q.accountId}-${i}`}>
                  <td>{new Date(q.at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{q.phone || '•••'}{q.name ? ` ${q.name}` : ''}{q.frozen ? <span className="pill r" style={{ marginLeft: 6 }}>frozen</span> : null}</td>
                  <td className="n">{q.amountCents != null ? R(q.amountCents) : '–'}{q.method ? ` ${q.method}` : ''}{q.express ? ' · double fee' : ''}</td>
                  <td>{q.level ? <span className={`pill ${LEVEL_PILL[q.level] || 'y'}`}>{q.level}/5 {q.label}</span> : '–'}</td>
                  <td>{q.reasons?.length ? q.reasons.join('; ') : 'nothing unusual'}</td>
                  <td>{PAYOUT_OUTCOME[q.outcome] || q.outcome || '–'}{q.cleared ? ' (cleared)' : ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{(q.level >= 4 || q.outcome === 'REVIEW') && !q.frozen ? (
                    <>
                      <button className="linkish" disabled={!!busy} onClick={() => act(q, 'clear')}>Clear 72 h</button>{' · '}
                      <button className="linkish" disabled={!!busy} style={{ color: 'var(--crit)' }} onClick={() => act(q, 'freeze')}>Freeze</button>
                    </>
                  ) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function FloatsTab() {
  const [tick, setTick] = useState(0);
  const [m] = useMetrics('30', tick);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS); return () => clearInterval(id); }, []);
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <button className="linkish" onClick={() => setTick((t) => t + 1)}>↻ Refresh</button>
        <span className="note" style={{ margin: 0 }}>live supplier reads are cached for about a minute · refreshes itself every 10 minutes</span>
      </div>
      <div className="grid kpis">
        <FloatTile balancesCents={m?.vitals?.balancesCents ?? m?.vitals?.floatCents ?? 0} tick={tick} />
        <div className="card"><div className="k">Customer balances</div><div className="v">{m ? R(m.vitals?.balancesCents ?? m.vitals?.floatCents) : '…'}</div><div className="vs">what the pay-out float must cover</div></div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Pay-out requests</h2>
        <PayoutRequests tick={tick} />
      </div>
      <div className="card" style={{ marginTop: 14 }} key={`floats-${tick}`}>
        <h2>Supplier floats</h2>
        <p className="note">Prepaid balances at each counterparty, next to what the ledger believes. Top up before a low float fails a vend.</p>
        <Floats />
      </div>
      <div className="card" style={{ marginTop: 14 }} key={`fuel-${tick}`}>
        <h2>UniFuel / wiCode</h2>
        <p className="note">WaPay-originated fuel voucher issuance and redemptions, via the UniFuel service.</p>
        <UniFuelPanel />
      </div>
    </>
  );
}

/* Record a float load (2026-10-20): the founder's transfer to a supplier, typed in once it cleared, so the row above reconciles. */
function RecordLoad({ floatKey, lastLoad = null, onRecorded }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const cents = Math.round(Number(String(amount).replace(/[^0-9.]/g, '')) * 100);
    if (!Number.isInteger(cents) || cents <= 0) { setMsg('Type the amount in rands, like 2500.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/admin/float-load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: floatKey, amountCents: cents, loadedAt: date, reference: ref || null }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setMsg(j.error === 'BAD_KEY' ? 'This float does not take loads yet.' : j.error === 'BAD_DATE' ? 'Date must be YYYY-MM-DD.' : 'Could not record the load.'); }
      else { setMsg(j.replayed ? 'Already recorded (same day, amount and reference).' : `Recorded ${R(cents)} on ${date}.`); setAmount(''); setRef(''); if (onRecorded) onRecorded(); }
    } catch { setMsg('Could not record the load.'); }
    setBusy(false);
  };
  return (
    <div style={{ gridColumn: '1 / -1', paddingLeft: 2 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="linkish" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Record a load'}</button>
        {lastLoad && <span className="note" style={{ margin: 0 }}>last load {R(lastLoad.amountCents)} on {lastLoad.loadedAt}{lastLoad.reference ? ` · ${lastLoad.reference}` : ''}</span>}
        {msg && <span className="note" style={{ margin: 0, color: /Recorded|Already/.test(msg) ? 'var(--good)' : 'var(--crit)' }}>{msg}</span>}
      </div>
      {open && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <input inputMode="decimal" placeholder="Amount in rands" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 150, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--grid)', background: 'var(--glass)', color: 'var(--ink)' }} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--grid)', background: 'var(--glass)', color: 'var(--ink)' }} />
          <input placeholder="Bank reference (optional)" value={ref} onChange={(e) => setRef(e.target.value)} style={{ width: 200, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--grid)', background: 'var(--glass)', color: 'var(--ink)' }} />
          <button type="submit" disabled={busy} className="searchrow-btn" style={{ padding: '8px 14px', border: 0, borderRadius: 8, background: 'var(--accent)', color: '#fff', fontWeight: 650, cursor: 'pointer', fontSize: 12.5 }}>{busy ? 'Recording…' : 'Record'}</button>
        </form>
      )}
    </div>
  );
}

/* One customer's conversation: the flags an operator needs, the questions they asked, and both sides of the chat. */
function ConversationCard({ accountId, tick = 0, compact = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [onlyQuestions, setOnlyQuestions] = useState(false);
  useEffect(() => {
    if (!accountId) return undefined;
    let cancelled = false;
    setErr(''); setD(null);
    fetch(`/api/admin/customer-turns?id=${encodeURIComponent(accountId)}&limit=300`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (!cancelled) setD(j); })
      .catch(() => { if (!cancelled) setErr('Could not load the conversation.'); });
    return () => { cancelled = true; };
  }, [accountId, tick]);
  if (err) return <div className="empty">{err}</div>;
  if (!d) return <div className="empty">Loading the conversation…</div>;
  const flags = [
    d.unanswered && ['unanswered', 'var(--crit)'],
    d.closeAsk && ['asked to close the account', 'var(--crit)'],
    d.personAsked && ['a person was asked', 'var(--warn, #e3b341)'],
    d.gateTier != null && [`gate tier ${d.gateTier}`, d.gateTier >= 2 ? 'var(--crit)' : 'var(--ink3)'],
    d.opsReplies > 0 && [`${d.opsReplies} ${d.opsReplies === 1 ? 'reply' : 'replies'} from a person`, 'var(--good)'],
  ].filter(Boolean);
  const turns = onlyQuestions ? d.turns.filter((t) => t.role === 'user' && d.questions.some((q) => q.at === t.at)) : d.turns;
  const who = (t) => (t.role === 'user' ? 'Customer' : t.kind === 'ops' ? 'WaPay team' : t.role === 'assistant' ? `WaPay${t.kind ? ` (${t.kind})` : ''}` : `Event${t.kind ? ` (${t.kind})` : ''}`);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="note" style={{ margin: 0 }}>{d.counts.user} from them · {d.counts.bot} from WaPay · last message {d.lastUserAt ? dt(d.lastUserAt) : '—'}</span>
        {flags.map(([label, tone]) => <span key={label} style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, border: `1px solid ${tone}`, color: tone }}>{label}</span>)}
        <span className="spacer" />
        <button className="linkish" onClick={() => setOnlyQuestions((q) => !q)}>{onlyQuestions ? 'Show everything' : `Questions only (${d.questions.length})`}</button>
      </div>
      <div style={{ maxHeight: compact ? 360 : 560, overflowY: 'auto', marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {turns.length === 0 && <div className="empty">Nothing here yet.</div>}
        {turns.map((t) => (
          <div key={t.id || t.at + t.role} style={{ alignSelf: t.role === 'user' ? 'flex-start' : 'flex-end', maxWidth: '82%', padding: '8px 11px', borderRadius: 12, background: t.role === 'user' ? 'var(--glass)' : t.kind === 'ops' ? 'var(--accent-soft)' : 'rgba(53,152,83,.10)', border: '1px solid var(--glass-edge)' }}>
            <div className="note" style={{ margin: '0 0 3px', fontSize: 10.5 }}>{who(t)} · {dt(t.at)}</div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--ink)' }}>{t.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Inbox() {
  const [days, setDays] = useState('7');
  const [tick, setTick] = useState(0);
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    let cancelled = false;
    setErr('');
    fetch(`/api/admin/inbox?days=${days}&limit=150`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setItems(d.items || []); })
      .catch(() => { if (!cancelled) setErr('Could not load the inbox.'); });
    return () => { cancelled = true; };
  }, [days, tick]);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS); return () => clearInterval(id); }, []);
  const shown = (items || []).filter((i) => filter === 'all' || (filter === 'person' && i.needsPerson) || (filter === 'unanswered' && i.unanswered) || (filter === 'replied' && i.opsReplies > 0));
  const selected = (items || []).find((i) => i.accountId === sel) || null;
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="tabs">{['1', '7', '30'].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}d</button>)}</div>
        <div className="tabs">{[['all', 'All'], ['person', 'Needs a person'], ['unanswered', 'Unanswered'], ['replied', 'Replied by us']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <button className="linkish" onClick={() => setTick((t) => t + 1)}>↻ Refresh</button>
        <span className="note" style={{ margin: 0 }}>customers who wrote in the window, newest first · refreshes itself every 10 minutes</span>
      </div>
      {err && <div className="card"><div className="empty">{err}</div></div>}
      <div className="grid two">
        <div className="card">
          <h2>Conversations {items ? <span className="note" style={{ display: 'inline', fontWeight: 400 }}>· {shown.length} shown</span> : null}</h2>
          {!items && !err && <div className="empty">Loading…</div>}
          {items && !shown.length && <div className="empty">Nothing in this window.</div>}
          <div style={{ maxHeight: 640, overflowY: 'auto' }}>
            {shown.map((i) => (
              <div key={i.accountId} onClick={() => setSel(i.accountId)} style={{ cursor: 'pointer', padding: '9px 10px', borderRadius: 10, marginBottom: 6, background: sel === i.accountId ? 'var(--accent-soft)' : 'var(--glass)', border: '1px solid var(--glass-edge)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <b style={{ color: 'var(--ink)' }}>{i.displayName || 'Customer'}</b>
                  <span className="note" style={{ margin: 0 }}>{i.msisdn ? `…${String(i.msisdn).slice(-4)}` : ''} · {i.state === 'S5_COMPLETED' ? 'account' : 'signing up'} · {i.source}</span>
                  <span className="spacer" />
                  <span className="note" style={{ margin: 0 }}>{i.lastUserAt ? dt(i.lastUserAt) : ''}</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink2)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.lastUserText || ''}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                  {i.unanswered && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--crit)' }}>unanswered</span>}
                  {i.closeAsk && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--crit)' }}>close account</span>}
                  {i.personAsked && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--warn, #e3b341)' }}>person asked</span>}
                  {i.gateTier != null && i.gateTier >= 2 && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--crit)' }}>gate tier {i.gateTier}</span>}
                  {i.opsReplies > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--good)' }}>replied</span>}
                  {i.questions?.length > 0 && <span className="note" style={{ margin: 0, fontSize: 10.5 }}>{i.questions.length} question{i.questions.length === 1 ? '' : 's'}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          {!selected && <div className="empty">Pick a conversation to read it and reply.</div>}
          {selected && (
            <>
              <h2>{selected.displayName || 'Customer'} <span className="note" style={{ display: 'inline', fontWeight: 400 }}>· {selected.msisdn} · <a href={`/admin?tab=customer&customer=${encodeURIComponent(selected.msisdn || '')}`} target="_blank" rel="noopener noreferrer">open profile ↗</a></span></h2>
              <ConversationCard accountId={selected.accountId} tick={tick} compact />
              <ReplyBox accountId={selected.accountId} name={selected.displayName} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

const TABS = [['dashboard', 'Dashboard'], ['growth', 'Valuation Metrics'], ['inbox', 'Inbox'], ['customer', 'Customers'], ['health', 'Health'], ['floats', 'Supplier Floats']];

export default function Admin() {
  const [authed, setAuthed] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [passwordLogin, setPasswordLogin] = useState(false);
  const [tab, setTab] = useState('dashboard');
  const [initialCustomer, setInitialCustomer] = useState('');
  // Deep links (founder 2026-10-19): /admin?tab=customer&customer=27… opens one customer on its own page.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const t = q.get('tab'); if (t && TABS.some(([k]) => k === t)) setTab(t);
      const c = q.get('customer'); if (c) { setInitialCustomer(c); setTab('customer'); }
    } catch {}
  }, []);
  const probe = useCallback(() => {
    fetch('/api/admin/auth').then((r) => r.json()).then((s) => {
      setAuthed(s.authed); setConfigured(s.configured); setPasswordLogin(!!s.passwordLogin);
    }).catch(() => setAuthed(false));
  }, []);
  useEffect(() => { probe(); }, [probe]);
  return (
    <div className="wrap">
      <Head>
        <title>WaPay Admin</title>
        <meta name="robots" content="noindex,nofollow" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="48x48" href="/brand/favicon-48.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/brand/apple-touch-icon.png" />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bg" />
      <header>
        <span className="brand">
          <img className="logo" src="/brand/wapay-lockup-120.png" srcSet="/brand/wapay-lockup-120.png 1x, /brand/wapay-lockup-240.png 2x" alt="WaPay" width={121} height={30} />
          <span className="tag">Admin</span>
        </span>
        <div className="spacer" />
        {authed && (
          <>
            <div className="tabs">
              {TABS.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
            </div>
            <button className="linkish" onClick={async () => {
              await fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
              setAuthed(false);
            }}>Sign out</button>
          </>
        )}
      </header>
      {authed === null && <div className="card"><div className="empty">…</div></div>}
      {authed === false && <Login configured={configured} passwordLogin={passwordLogin} onDone={probe} />}
      {authed === true && (
        tab === 'dashboard' ? <Dashboard /> : tab === 'growth' ? <Growth /> : tab === 'inbox' ? <Inbox /> : tab === 'health' ? <Health /> : tab === 'floats' ? <FloatsTab /> : <Customer initialQuery={initialCustomer} />
      )}
    </div>
  );
}
