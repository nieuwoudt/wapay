/**
 * WaPay for Business — the business portal (founder brief 2026-09-04).
 *
 * One page, four tabs behind a WhatsApp-OTP / password sign-in:
 *   Overview   — revenue, outstanding, customers, methods, 12-month series
 *   Customers  — the CRM: list with derived spend, profile with every link
 *   Payment links — the POS composer (line items, reference, expiry, quote)
 *                 and the link ledger with copy / WhatsApp / cancel
 *   Settings   — name, default expiry, password
 *
 * The page holds NO data and NO secrets: everything arrives from the
 * session-gated /api/business/* routes. Sending a link opens the OWNER's own
 * WhatsApp (wa.me deep link) so the message really comes from the business.
 *
 * Design: "mirror finish" — translucent layered cards with a top sheen,
 * 20px radii, tabular numerals, high contrast; light and dark.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { BUSINESS_CATEGORIES } from '../../lib/business-categories.js';
import Head from 'next/head';

const R = (c) => 'R' + (Math.round(c || 0) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const Rw = (c) => 'R' + Math.round((c || 0) / 100).toLocaleString('en-ZA');
const dt = (s) => (s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const d = (s) => (s ? new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Delivery ticks for a link WaPay sent from its own number (webhook receipts). */
const ticks = (st) => (st === 'read' ? '✓✓ read' : st === 'delivered' ? '✓✓ delivered' : st === 'sent' || st === 'accepted' ? '✓ sent' : st === 'failed' ? '✗ not delivered' : '');
/** A payment link as a QR image (data URL), rendered in the browser. */
function useQr(text) {
  const [qr, setQr] = useState('');
  useEffect(() => {
    let live = true;
    if (!text) { setQr(''); return undefined; }
    QRCode.toDataURL(text, { width: 512, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b1411', light: '#ffffff' } }).then((u) => { if (live) setQr(u); }).catch(() => { if (live) setQr(''); });
    return () => { live = false; };
  }, [text]);
  return qr;
}
async function dataUrlToBlob(dataUrl) { const r = await fetch(dataUrl); return r.blob(); }
/** Copy / share / download for a QR image; every path degrades honestly. */
function QrActions({ qr, code, url }) {
  const [msg, setMsg] = useState('');
  if (!qr) return null;
  const file = async () => new File([await dataUrlToBlob(qr)], `wapay-${code}.png`, { type: 'image/png' });
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      <button className="btn q sm" onClick={async () => { try { const blob = await dataUrlToBlob(qr); await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]); setMsg('QR copied'); } catch { setMsg(`Could not copy the image here. Download it instead.`); } }}>Copy QR</button>
      {typeof navigator !== 'undefined' && navigator.share && <button className="btn q sm" onClick={async () => { try { const fl = await file(); if (navigator.canShare && !navigator.canShare({ files: [fl] })) { await navigator.share({ title: 'WaPay payment link', text: url, url }); } else { await navigator.share({ files: [fl], title: 'WaPay payment link', text: url }); } setMsg('Shared'); } catch { /* user closed the sheet */ } }}>Share</button>}
      <a className="btn q sm" href={qr} download={`wapay-${code}.png`}>Download</a>
      {msg && <span className="note" style={{ margin: 0, alignSelf: 'center' }}>{msg}</span>}
    </div>
  );
}
/** Resize an uploaded image to a small square PNG/JPEG data URL for the logo. */
function fileToLogoDataUrl(fileObj, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(fileObj);
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        let out = c.toDataURL('image/png');
        if (out.length > 60 * 1024) out = c.toDataURL('image/jpeg', 0.86);
        if (out.length > 84 * 1024) out = c.toDataURL('image/jpeg', 0.7);
        URL.revokeObjectURL(src); resolve(out);
      } catch (e) { URL.revokeObjectURL(src); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('not an image')); };
    img.src = src;
  });
}
const monthLabel = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1] || ym;

/**
 * "120", "120.50", "R 120,50", "1,500", "1 500", "1.500,00" → integer cents;
 * null when not a money amount. The LAST '.' or ',' followed by one or two
 * digits is the decimal separator; any other '.'/',' must group thousands.
 */
function toCents(v) {
  const s = String(v ?? '').trim().replace(/^r/i, '').replace(/\s/g, '');
  if (!s) return null;
  const m = s.match(/^(\d[\d.,]*?)(?:([.,])(\d{1,2}))?$/);
  if (!m) return null;
  const [, intPart, , frac] = m;
  if (/[.,]/.test(intPart) && !/^\d{1,3}([.,]\d{3})+$/.test(intPart)) return null;
  const whole = Number(intPart.replace(/[.,]/g, ''));
  if (!Number.isInteger(whole)) return null;
  return whole * 100 + Number(((frac || '') + '00').slice(0, 2));
}

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap");
:root{color-scheme:light;
--page:#eef3ef;--bgfx:radial-gradient(90vmax 70vmax at 8% -12%,rgba(53,152,83,.26),transparent 62%),radial-gradient(80vmax 60vmax at 96% 108%,rgba(37,211,102,.16),transparent 60%),linear-gradient(180deg,#eef3ef 0%,#e7efe9 100%);
--glass:linear-gradient(180deg,rgba(255,255,255,.78),rgba(255,255,255,.56));--glass-edge:rgba(255,255,255,.75);--glass-line:rgba(9,30,18,.08);
--sheen:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.9),rgba(255,255,255,0));
--ink:#0b1411;--ink2:#3d4a43;--ink3:#7b877f;--grid:rgba(9,30,18,.08);
--accent:#359853;--accent-2:#2e8a4c;--accent-ink:#1f6a39;--accent-soft:rgba(53,152,83,.12);
--wa:#25D366;--wa-ink:#0b3d1f;--good:#1a9e4a;--warn:#c98500;--crit:#d03b3b;
--shadow:0 18px 50px -22px rgba(8,40,20,.35),0 2px 6px -2px rgba(8,40,20,.12);
--field:rgba(255,255,255,.85);--field-edge:rgba(9,30,18,.14)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--page:#0b100d;--bgfx:radial-gradient(90vmax 70vmax at 8% -12%,rgba(53,152,83,.30),transparent 62%),radial-gradient(80vmax 60vmax at 96% 108%,rgba(37,211,102,.13),transparent 60%),linear-gradient(180deg,#0b100d 0%,#0d150f 100%);
--glass:linear-gradient(180deg,rgba(28,34,31,.78),rgba(20,25,22,.62));--glass-edge:rgba(255,255,255,.14);--glass-line:rgba(255,255,255,.06);
--sheen:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.35),rgba(255,255,255,0));
--ink:#f2f6f3;--ink2:#c3ccc6;--ink3:#8a948d;--grid:rgba(255,255,255,.08);
--accent:#4fb572;--accent-2:#3d9d5e;--accent-ink:#9fe0b6;--accent-soft:rgba(79,181,114,.16);
--shadow:0 24px 60px -24px rgba(0,0,0,.7),0 2px 6px -2px rgba(0,0,0,.5);
--field:rgba(255,255,255,.06);--field-edge:rgba(255,255,255,.14)}}
*{box-sizing:border-box}
html{background:var(--page)}
/* body stays transparent: an opaque body only as tall as the content painted
   over the fixed gradient layer and left a hard edge below it (the "band"). */
html,body{margin:0;color:var(--ink);font:400 14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body{background:transparent;min-height:100vh}
/* One fixed, seamless gradient behind everything (founder 2026-09-06: the
   blurred orbs rendered as a hard two-tone band on Chrome, and the teal one
   read as a stray colour). No filter: blur, greens only, same on every tab. */
.bg{position:fixed;inset:0;z-index:-1;pointer-events:none;background:var(--bgfx)}
.wrap{max-width:1200px;margin:0 auto;padding:22px 20px 90px}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand img.logo{height:30px;width:auto;display:block;flex:none}
.brand .tag{font-size:11px;font-weight:600;color:var(--ink3);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;padding-left:12px;border-left:1px solid var(--field-edge);line-height:1.2}
.brand .bizname{font-size:14px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(40vw,320px)}
.brand img.bizlogo{width:28px;height:28px;border-radius:8px;object-fit:cover;flex:none;background:#fff}
@media(max-width:700px){.brand img.logo{height:26px}.brand .bizname{max-width:100%}}
.spacer{flex:1}
.tabs{display:flex;gap:4px;background:var(--glass);border:1px solid var(--glass-edge);border-radius:14px;padding:4px;backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);box-shadow:var(--shadow)}
.tabs button{border:0;background:transparent;color:var(--ink2);font:600 12.5px Inter,system-ui;padding:8px 14px;border-radius:10px;cursor:pointer;transition:all .15s}
.tabs button:hover{background:var(--accent-soft)}
.tabs button.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;box-shadow:0 6px 18px -8px rgba(53,152,83,.8)}
.linkish{border:0;background:none;color:var(--ink3);font-size:12.5px;cursor:pointer;text-decoration:underline;padding:4px}
@media(max-width:700px){.tabs{width:100%;order:3;overflow-x:auto;-webkit-overflow-scrolling:touch}.tabs button{flex:1;white-space:nowrap;padding:8px 10px}.wrap{padding:16px 12px 70px}}
.card{position:relative;background:var(--glass);border:1px solid var(--glass-edge);border-radius:20px;padding:18px 20px;min-width:0;
backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);box-shadow:var(--shadow)}
.card::before{content:"";position:absolute;left:14%;right:14%;top:0;height:1px;background:var(--sheen);opacity:.9}
.card h2{font-size:14px;font-weight:700;margin:0 0 2px;letter-spacing:-.01em}
.note{font-size:12px;color:var(--ink3);margin:0 0 10px}
.k{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3)}
.v{font-size:27px;font-weight:700;margin-top:4px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.vs{font-size:12px;color:var(--ink3);margin-top:3px}
.grid{display:grid;gap:14px}.kpis{grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
.two{grid-template-columns:1fr 1fr}.three{grid-template-columns:2fr 1fr}
@media(max-width:900px){.two,.three{grid-template-columns:1fr}}
.mt{margin-top:14px}
input,select,textarea{width:100%;padding:11px 13px;border:1px solid var(--field-edge);border-radius:12px;background:var(--field);color:var(--ink);font:inherit;font-size:14px;outline:none;transition:border .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input.bad{border-color:var(--crit);box-shadow:0 0 0 3px rgba(208,59,59,.15)}
@media(max-width:700px){input,select,textarea{font-size:16px}}
label.f{display:block;font-size:11.5px;font-weight:600;color:var(--ink3);margin:0 0 5px;letter-spacing:.03em}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 16px;border:0;border-radius:12px;font:600 13.5px Inter,system-ui;cursor:pointer;transition:transform .08s,box-shadow .15s,filter .15s;white-space:nowrap}
.btn:active{transform:translateY(1px)}
.btn.p{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;box-shadow:0 10px 24px -10px rgba(53,152,83,.8)}
.btn.p:hover{filter:brightness(1.05)}
.btn.wa{background:var(--wa);color:#fff;box-shadow:0 10px 24px -10px rgba(37,211,102,.8)}
.btn.g{background:var(--accent-soft);color:var(--accent-ink);border:1px solid var(--glass-line)}
.btn.q{background:transparent;color:var(--ink2);border:1px solid var(--field-edge)}
.btn.sm{padding:7px 11px;font-size:12px;border-radius:10px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.err{color:var(--crit);font-size:12.5px;margin-top:8px}
.ok{color:var(--good);font-size:12.5px;margin-top:8px}
.login{max-width:400px;margin:7vh auto 0}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--ink3);font-weight:600;padding:8px 10px 8px 0;border-bottom:1px solid var(--grid);white-space:nowrap;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase}
td{padding:9px 10px 9px 0;border-bottom:1px solid var(--grid);vertical-align:middle}
td.n,th.n{text-align:right}
tr.row:hover td{background:var(--accent-soft)}
tr.row{cursor:pointer}
.pill{display:inline-block;font-size:10.5px;font-weight:700;border-radius:99px;padding:3px 9px;letter-spacing:.02em}
.pill.g{background:rgba(26,158,74,.14);color:var(--good)}
.pill.y{background:rgba(201,133,0,.16);color:var(--warn)}
.pill.r{background:rgba(208,59,59,.14);color:var(--crit)}
.pill.n{background:var(--accent-soft);color:var(--ink2)}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{border:1px solid var(--field-edge);background:var(--field);border-radius:99px;padding:6px 11px;font-size:12px;cursor:pointer;color:var(--ink2)}
.chip:hover{border-color:var(--accent);color:var(--accent-ink)}
.stat{display:flex;gap:22px;flex-wrap:wrap}
.stat b{font-size:20px;font-weight:700;display:block;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.empty{color:var(--ink3);font-size:12.5px;padding:14px 0}
svg{display:block;width:100%}
svg text{font:600 10.5px Inter,system-ui;fill:var(--ink3)}
.avatar{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;font-weight:700;color:#fff;background:linear-gradient(135deg,#4fb572,#1f6a39);font-size:13px;flex:none}
.rowline{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--grid)}
.rowline:last-child{border-bottom:0}
.items{display:grid;grid-template-columns:1fr 70px 120px 34px;gap:8px;align-items:center}
@media(max-width:600px){.items{grid-template-columns:1fr 60px 100px 30px}}
.total{display:flex;justify-content:space-between;align-items:baseline;padding:12px 0 2px;border-top:1px dashed var(--grid);margin-top:10px}
.total>b{font-size:26px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.msg{white-space:pre-wrap;background:var(--field);border:1px solid var(--field-edge);border-radius:14px;padding:12px 14px;font-size:13px;line-height:1.5}
.linkbox{display:flex;gap:8px;align-items:center;background:var(--field);border:1px solid var(--field-edge);border-radius:12px;padding:8px 8px 8px 14px;font-variant-numeric:tabular-nums}
.linkbox code{flex:1;font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seg{display:inline-flex;gap:2px;background:var(--field);border:1px solid var(--field-edge);border-radius:11px;padding:3px}
.seg button{border:0;background:transparent;color:var(--ink2);font:600 12px Inter,system-ui;padding:6px 11px;border-radius:8px;cursor:pointer}
.seg button.on{background:var(--accent);color:#fff}
.dd{position:absolute;z-index:5;left:0;right:0;top:calc(100% + 6px);background:var(--glass);backdrop-filter:blur(18px);border:1px solid var(--glass-edge);border-radius:14px;box-shadow:var(--shadow);max-height:260px;overflow:auto;padding:6px}
.dd button{display:flex;width:100%;gap:10px;align-items:center;text-align:left;border:0;background:transparent;padding:9px 10px;border-radius:10px;cursor:pointer;color:var(--ink);font:inherit}
.dd button:hover{background:var(--accent-soft)}
`;

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  let j = {};
  try { j = await r.json(); } catch { j = {}; }
  // A 24h session that expired overnight must send the owner back to sign-in,
  // not leave every button saying "Could not …" (review 2026-09-05).
  if (r.status === 401 && !path.endsWith('/auth')) window.dispatchEvent(new Event('wapay:unauth'));
  return { ok: r.ok, status: r.status, ...j };
}
/** GET helper with the same 401 handling; resolves to null on failure. */
async function getJson(path) {
  try {
    const r = await fetch(path);
    if (r.status === 401) { window.dispatchEvent(new Event('wapay:unauth')); return null; }
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    let ta;
    try {
      ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      return document.execCommand('copy') === true;
    } catch { return false; } finally { if (ta) ta.remove(); }
  }
}

const initials = (name, msisdn) => (name ? name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() : (msisdn || '?').slice(-2));
const statusPill = (s) => (s === 'PAID' ? 'g' : s === 'PENDING' ? 'y' : 'r');

// ---------------------------------------------------------------------------
// Charts (hand-rolled SVG, no library)
// ---------------------------------------------------------------------------

function MonthlyBars({ monthly, height = 170 }) {
  if (!monthly?.length) return <div className="empty">No payments yet.</div>;
  const W = 620, H = height, L = 8, B = 22, T = 18;
  const mx = Math.max(...monthly.map((m) => m.cents)) || 1;
  const slot = (W - L) / monthly.length;
  const bw = Math.min(34, slot * 0.62);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      <defs>
        <linearGradient id="gbar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4fb572" /><stop offset="1" stopColor="#2a8449" />
        </linearGradient>
        <linearGradient id="gbar2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7cc99a" stopOpacity=".9" /><stop offset="1" stopColor="#4fb572" stopOpacity=".55" />
        </linearGradient>
      </defs>
      {monthly.map((m, i) => {
        const x = L + slot * i + (slot - bw) / 2;
        const h = Math.max(m.cents > 0 ? 3 : 0, ((H - T - B) * m.cents) / mx);
        const last = i === monthly.length - 1;
        return (
          <g key={m.month}>
            <rect x={x} y={H - B - h} width={bw} height={h} rx={8} fill={last ? 'url(#gbar)' : 'url(#gbar2)'}>
              <title>{`${monthLabel(m.month)} ${m.month.slice(0, 4)}: ${R(m.cents)} · ${m.n} payment${m.n === 1 ? '' : 's'}`}</title>
            </rect>
            <text x={x + bw / 2} y={H - 6} textAnchor="middle">{monthLabel(m.month)}</text>
            {(last || m.cents === mx) && m.cents > 0 && (
              <text x={x + bw / 2} y={H - B - h - 6} textAnchor="middle" style={{ fill: 'var(--ink)', fontWeight: 700 }}>{Rw(m.cents)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Spark({ monthly }) {
  if (!monthly?.length) return null;
  const W = 240, H = 46;
  const mx = Math.max(...monthly.map((m) => m.cents)) || 1;
  const bw = W / monthly.length - 3;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" style={{ maxWidth: 240 }}>
      {monthly.map((m, i) => {
        const h = Math.max(m.cents > 0 ? 2 : 0, ((H - 4) * m.cents) / mx);
        return <rect key={m.month} x={i * (bw + 3)} y={H - h} width={bw} height={h} rx={3} fill={i === monthly.length - 1 ? 'var(--accent)' : 'var(--accent-soft)'} stroke={i === monthly.length - 1 ? 'none' : 'var(--accent)'} strokeOpacity=".4"><title>{`${monthLabel(m.month)}: ${R(m.cents)}`}</title></rect>;
      })}
    </svg>
  );
}

function Split({ methods }) {
  const card = methods?.card?.cents || 0, wa = methods?.wapay?.cents || 0, total = card + wa;
  if (!total) return <div className="empty">No payments in this period.</div>;
  const pc = Math.round((100 * card) / total);
  return (
    <div>
      <div style={{ display: 'flex', height: 14, borderRadius: 99, overflow: 'hidden', background: 'var(--grid)' }}>
        <div style={{ width: `${pc}%`, background: 'linear-gradient(90deg,#2a8449,#4fb572)' }} title={`Card ${pc}%`} />
        <div style={{ flex: 1, background: 'linear-gradient(90deg,#25D366,#7ce0a5)' }} title={`WaPay balance ${100 - pc}%`} />
      </div>
      <div className="stat" style={{ marginTop: 12 }}>
        <div><b>{R(card)}</b><span>Card · {methods.card.count} · {pc}%</span></div>
        <div><b>{R(wa)}</b><span>WaPay balance · {methods.wapay.count} · {100 - pc}%</span></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign in / register
// ---------------------------------------------------------------------------

const CATEGORIES = BUSINESS_CATEGORIES;

function Login({ configured, onDone }) {
  const [stage, setStage] = useState('start'); // start | code | register | password
  const [msisdn, setMsisdn] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [regToken, setRegToken] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [newPassword, setNewPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { try { const s = window.localStorage.getItem('wapay_biz_msisdn'); if (s) setMsisdn(s); } catch {} }, []);
  const remember = (n) => { try { window.localStorage.setItem('wapay_biz_msisdn', n); } catch {} };
  const numberOk = /\d{9}/.test(String(msisdn).replace(/\D/g, ''));

  // "I have my code from WhatsApp" only opens the code box. It must NOT ask
  // the server for a code: a portal request mints a NEWER code (which Meta
  // drops outside the 24h window), and until 2026-09-06 the verifier compared
  // the newest code only, so the one already in the owner's chat stopped
  // working (BUGLOG #40).
  const haveCode = () => {
    setErr('');
    if (!numberOk) { setErr('Enter your full WhatsApp number.'); return; }
    setCode(''); setStage('code');
  };
  const requestCode = async () => {
    setErr('');
    if (!numberOk) { setErr('Enter your full WhatsApp number.'); return; }
    setBusy(true);
    try {
      const r = await api('/api/business/auth', { action: 'request', msisdn });
      if (!r.ok) { setErr('Could not request a code right now. Try again in a moment.'); return; }
      setStage('code');
    } catch { setErr('No connection. Check your network and try again.'); } finally { setBusy(false); }
  };
  const verify = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api('/api/business/auth', { action: 'verify', msisdn, code });
      if (!r.ok) { setErr(r.status === 429 ? 'Too many attempts from this connection. Try again in 15 minutes.' : 'That code did not work. Request a fresh one.'); setStage('start'); setCode(''); return; }
      remember(msisdn);
      if (r.registered) { onDone(); return; }
      if (r.inviteRequired) {
        setErr('Your number is verified, but new business registrations are by invitation right now. Ask WaPay to add your number, then try again.');
        setStage('start'); setCode('');
        return;
      }
      setRegToken(r.registrationToken); setStage('register');
    } catch { setErr('No connection. Try again.'); } finally { setBusy(false); }
  };
  const register = async () => {
    setErr('');
    if (name.trim().length < 2) { setErr('Give your business a name.'); return; }
    if (newPassword && newPassword.length < 10) { setErr('Password must be at least 10 characters (or leave it empty).'); return; }
    setBusy(true);
    try {
      const r = await api('/api/business/auth', { action: 'register', registrationToken: regToken, name, category, password: newPassword || undefined });
      if (!r.ok) {
        setErr(r.error === 'NAME_NOT_ALLOWED' ? 'That name is not allowed. Use your own trading name.'
          : r.error === 'VERIFY_FIRST' ? 'Your code expired. Start again.'
            : r.error === 'NOT_ALLOWED' ? 'Registration is by invitation right now. Ask WaPay to add your number.'
              : 'Could not register. Try again.');
        if (r.error === 'VERIFY_FIRST') setStage('start');
        return;
      }
      onDone();
    } catch { setErr('No connection. Try again.'); } finally { setBusy(false); }
  };
  const loginPassword = async () => {
    setErr('');
    if (!numberOk) { setErr('Enter your full number.'); return; }
    if (!password) { setErr('Enter your password.'); return; }
    setBusy(true);
    try {
      const r = await api('/api/business/auth', { action: 'password', msisdn, password });
      if (r.ok) { remember(msisdn); onDone(); return; }
      setErr(r.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : 'That did not work. Check the number and password.');
    } catch { setErr('No connection. Try again.'); } finally { setBusy(false); setPassword(''); }
  };

  return (
    <div className="login card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span className="brand"><img className="logo" src="/brand/wapay-lockup-120.png" srcSet="/brand/wapay-lockup-120.png 1x, /brand/wapay-lockup-240.png 2x" alt="WaPay" width={121} height={30} /><span className="tag">for Business</span></span>
      </div>
      {!configured ? (
        <p className="note">The portal is not configured yet. Set <b>WAPAY_BUSINESS_SESSION_SECRET</b> (or reuse <b>WAPAY_ADMIN_SESSION_SECRET</b>) in Vercel and redeploy. It fails closed until then.</p>
      ) : stage === 'start' ? (
        <>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Sign in or register</h2>
          <p className="note">Your business runs on your WaPay wallet. Enter the WhatsApp number of that wallet (for example 078 123 4567) and we send a one-time code to that WhatsApp.</p>
          <label className="f">WhatsApp number</label>
          <input inputMode="tel" autoComplete="username" placeholder="073 123 4567" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && requestCode()} />
          <button className="btn p" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={requestCode}>{busy ? 'Sending…' : 'Send my code'}</button>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
            <button className="linkish" onClick={() => { setStage('password'); setErr(''); }}>I have a password</button>
            <button className="linkish" onClick={haveCode}>I already have a code</button>
          </div>
          <p className="note" style={{ marginTop: 14 }}>The code arrives as a WhatsApp message with a <b>Copy code</b> button. Or, from that phone, WhatsApp <b>business login</b> to WaPay and the code comes straight back in the chat. No WaPay yet? Say hi to WaPay on WhatsApp first: your wallet is your business account.</p>
        </>
      ) : stage === 'code' ? (
        <>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Enter your code</h2>
          <p className="note">Six digits, one attempt per code. A wrong guess burns it. Nothing in your chat? From your phone, WhatsApp <b>business login</b> to WaPay and use the code that comes back.</p>
          <input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && verify()} autoFocus />
          <button className="btn p" style={{ width: '100%', marginTop: 12 }} disabled={busy || code.length !== 6} onClick={verify}>{busy ? 'Checking…' : 'Continue'}</button>
          <button className="linkish" style={{ marginTop: 10 }} onClick={() => { setStage('start'); setCode(''); setErr(''); }}>Different number</button>
        </>
      ) : stage === 'register' ? (
        <>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Name your business</h2>
          <p className="note">This is what your customers see on every payment link and receipt.</p>
          <label className="f">Business name</label>
          <input placeholder="I Love My Laundry" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
          <label className="f" style={{ marginTop: 10 }}>What do you do?</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          <label className="f" style={{ marginTop: 10 }}>Password for computer sign-ins (optional, 10+ characters)</label>
          <input type="password" autoComplete="new-password" placeholder="••••••••••" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <button className="btn p" style={{ width: '100%', marginTop: 14 }} disabled={busy} onClick={register}>{busy ? 'Creating…' : 'Create my business'}</button>
        </>
      ) : (
        <>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Sign in with password</h2>
          <label className="f">WhatsApp number</label>
          <input inputMode="tel" autoComplete="username" placeholder="073 123 4567" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} />
          <label className="f" style={{ marginTop: 10 }}>Password</label>
          <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && loginPassword()} />
          <button className="btn p" style={{ width: '100%', marginTop: 14 }} disabled={busy} onClick={loginPassword}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button className="linkish" style={{ marginTop: 10 }} onClick={() => { setStage('start'); setErr(''); }}>Use a one-time code instead</button>
        </>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function Overview({ onOpenCustomer, onNewLink }) {
  const [range, setRange] = useState('30');
  const [m, setM] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let cancelled = false;
    setErr(''); setM(null); // never show the previous range's numbers under the new label
    getJson(`/api/business/overview?range=${range}`).then((x) => {
      if (cancelled) return;
      if (x) setM(x); else setErr('Could not load the overview.');
    });
    return () => { cancelled = true; };
  }, [range]);
  if (err) return <div className="card"><div className="empty">{err}</div></div>;
  if (!m) return <div className="card"><div className="empty">Loading your numbers…</div></div>;
  const v = m.vitals || {};
  const LABELS = { 7: '7 days', 30: '30 days', 90: '90 days', 365: '12 months', 3650: 'all time' };
  const label = LABELS[m.rangeDays] || `${m.rangeDays} days`;
  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="seg">{['7', '30', '90', '365', 'all'].map((r) => <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === 'all' ? 'All' : r === '365' ? '1y' : r + 'd'}</button>)}</div>
        <span className="note" style={{ margin: 0 }}>updated {dt(m.generatedAt)}</span>
        <div className="spacer" />
        <button className="btn p" onClick={onNewLink}>＋ New payment link</button>
      </div>
      <div className="grid kpis">
        {[
          ['Paid, ' + label, R(v.paidCents), v.deltaPct == null ? `${v.paidCount} payments` : `${v.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(v.deltaPct)}% vs prior · ${v.paidCount} payments`],
          ['Net received', R(v.netCents), `after ${R(v.feeCents)} card costs`],
          ['Outstanding', R(v.outstandingCents), `${v.outstandingCount} open link${v.outstandingCount === 1 ? '' : 's'}`],
          ['Customers', String(v.customers ?? 0), `+${v.newCustomers ?? 0} new, ${label}`],
          ['Average ticket', v.avgTicketCents == null ? '—' : R(v.avgTicketCents), v.paidCount ? 'per paid link' : 'no paid links yet'],
          ['Links paid', v.conversionPct == null ? '—' : v.conversionPct + '%', `${v.linksCreated} created · ${v.cancelled} cancelled · ${v.expired} expired`],
        ].map(([k, val, sub]) => <div className="card" key={k}><div className="k">{k}</div><div className="v">{val}</div><div className="vs">{sub}</div></div>)}
      </div>
      <div className="grid three mt">
        <div className="card">
          <h2>Revenue by month</h2>
          <p className="note">Paid links, last 12 months.</p>
          <MonthlyBars monthly={m.monthly} />
          <div className="chips" style={{ marginTop: 10 }}>
            <span className="pill n">Last 3 months · {R(m.totals?.last3mCents)}</span>
            <span className="pill n">6 months · {R(m.totals?.last6mCents)}</span>
            <span className="pill n">12 months · {R(m.totals?.last12mCents)}</span>
          </div>
        </div>
        <div className="card">
          <h2>How customers paid</h2>
          <p className="note">Card costs come off your side; WaPay balance is free.</p>
          <Split methods={m.methods} />
        </div>
      </div>
      <div className="grid two mt">
        <div className="card">
          <h2>Outstanding links</h2>
          <p className="note">Waiting to be paid. Tap a row to open the customer; walk-in links open the link ledger.</p>
          {!m.outstanding?.length && <div className="empty">Nothing outstanding. 🎉</div>}
          {m.outstanding?.map((o) => (
            <div key={o.code} className="rowline" role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => onOpenCustomer && onOpenCustomer(o.customerId || null, o.code)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenCustomer && onOpenCustomer(o.customerId || null, o.code); } }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.customerName}{o.reference ? <span className="note" style={{ display: 'inline', marginLeft: 6 }}>· {o.reference}</span> : null}</div>
                <div className="note" style={{ margin: 0 }}>{o.code} · sent {o.sentAt ? d(o.sentAt) : 'not yet'} · expires {d(o.expiresAt)}</div>
              </div>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{R(o.amountCents)}</b>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Recent payments</h2>
          <p className="note">Newest first, {label}.</p>
          {!m.recentPayments?.length && <div className="empty">No payments yet in this period.</div>}
          {m.recentPayments?.map((p) => (
            <div key={p.code} className="rowline">
              <span className="avatar" style={{ background: p.method === 'CARD' ? 'linear-gradient(135deg,#2a8449,#4fb572)' : 'linear-gradient(135deg,#25D366,#1a9e4a)' }}>{p.method === 'CARD' ? '💳' : 'W'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{p.customerName}{p.reference ? <span className="note" style={{ display: 'inline', marginLeft: 6 }}>· {p.reference}</span> : null}</div>
                <div className="note" style={{ margin: 0 }}>{dt(p.paidAt)} · {p.method === 'CARD' ? 'card' : 'WaPay balance'}</div>
              </div>
              <b style={{ color: 'var(--good)', fontVariantNumeric: 'tabular-nums' }}>+{R(p.amountCents)}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="card mt">
        <h2>Top customers, {label}</h2>
        <p className="note">By rand paid. Tap to open the profile.</p>
        {!m.topCustomers?.length && <div className="empty">No paid links yet in this period.</div>}
        {m.topCustomers?.length > 0 && (() => {
          const mx = m.topCustomers[0].cents || 1;
          return m.topCustomers.map((c) => (
            <div key={c.customerId} className="rowline" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => onOpenCustomer && onOpenCustomer(c.customerId)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenCustomer && onOpenCustomer(c.customerId); } }}>
              <span className="avatar">{initials(c.name)}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><span style={{ fontWeight: 600 }}>{c.name}</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>{R(c.cents)} <span className="note" style={{ display: 'inline' }}>· {c.n}</span></b></div>
                <div style={{ height: 8, borderRadius: 99, background: 'var(--grid)', marginTop: 5 }}><div style={{ width: `${Math.max(3, (100 * c.cents) / mx)}%`, height: 8, borderRadius: 99, background: 'linear-gradient(90deg,#2a8449,#4fb572)' }} /></div>
              </div>
            </div>
          ));
        })()}
      </div>
      {m.truncated && <p className="note mt">Showing the most recent 5,000 paid links only; totals above are exact, per-payment detail is not.</p>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

function CustomerProfile({ id, onBack, onNewLink, onLinkAction }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({});
  const load = useCallback(() => {
    fetch(`/api/business/customer?id=${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((x) => { setP(x); setForm({ name: x.customer.name || '', email: x.customer.email || '', notes: x.customer.notes || '', tags: (x.customer.tags || []).join(', ') }); })
      .catch(() => setErr('Could not load this customer.'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="card"><div className="empty">{err}</div></div>;
  if (!p) return <div className="card"><div className="empty">Loading…</div></div>;
  const c = p.customer, s = p.stats;
  const save = async () => {
    const r = await api('/api/business/customers', { action: 'update', id, name: form.name, email: form.email, notes: form.notes, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean) });
    if (r.ok) { setEdit(false); load(); }
  };
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="btn q sm" onClick={onBack}>← All customers</button>
        <div className="spacer" />
        <button className="btn p" onClick={() => onNewLink(c)}>＋ Payment link for {c.name ? c.name.split(' ')[0] : 'this customer'}</button>
      </div>
      <div className="grid three">
        <div className="card">
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <span className="avatar" style={{ width: 52, height: 52, fontSize: 18, borderRadius: 16 }}>{initials(c.name, c.msisdn)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ fontSize: 18 }}>{c.name || 'Unnamed customer'}</h2>
              <div className="note" style={{ margin: 0 }}>{c.msisdn} · joined {d(c.createdAt)} · via {c.source === 'PAYLINK' ? 'paid a link' : c.source.toLowerCase()}{c.isWaPayUser ? ' · WaPay user' : ''}</div>
            </div>
            <button className="linkish" onClick={() => setEdit(!edit)}>{edit ? 'Cancel' : 'Edit'}</button>
          </div>
          {edit ? (
            <div style={{ marginTop: 12 }}>
              <label className="f">Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <label className="f" style={{ marginTop: 8 }}>Email</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <label className="f" style={{ marginTop: 8 }}>Tags (comma separated)</label><input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="regular, ironing" />
              <label className="f" style={{ marginTop: 8 }}>Notes</label><textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              <button className="btn p sm" style={{ marginTop: 10 }} onClick={save}>Save</button>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              {c.tags?.length > 0 && <div className="chips" style={{ marginBottom: 8 }}>{c.tags.map((t) => <span key={t} className="pill n">{t}</span>)}</div>}
              {c.email && <div className="note">{c.email}</div>}
              {c.notes && <div style={{ fontSize: 13, color: 'var(--ink2)', whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
              {!c.email && !c.notes && !c.tags?.length && <div className="note">No notes yet.</div>}
            </div>
          )}
          <div className="stat" style={{ marginTop: 16 }}>
            <div><b>{R(s.paidCents)}</b><span>Lifetime paid</span></div>
            <div><b>{s.paidCount}</b><span>Payments</span></div>
            <div><b>{s.paidCount ? R(s.avgCents) : '—'}</b><span>Average</span></div>
            <div><b style={{ color: s.openCents ? 'var(--warn)' : undefined }}>{R(s.openCents)}</b><span>Outstanding · {s.openCount}</span></div>
          </div>
          <div className="note" style={{ marginTop: 10 }}>First paid {d(s.firstPaidAt)} · last paid {d(s.lastPaidAt)} · card costs {R(s.feeCents)}{s.feesTruncated ? ' (newest 500 links)' : ''} · net {R(s.netCents)}</div>
        </div>
        <div className="card">
          <h2>Spend over time</h2>
          <p className="note">Last 12 months.</p>
          <Spark monthly={p.monthly} />
          <div style={{ marginTop: 14 }}>
            <div className="k">What they buy</div>
            {!p.topItems?.length && <div className="note" style={{ marginTop: 6 }}>No itemised links yet.</div>}
            {p.topItems?.map((it) => <div key={it.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--grid)' }}><span>{it.name} <span className="note" style={{ display: 'inline' }}>× {it.qty}</span></span><b>{R(it.cents)}</b></div>)}
          </div>
        </div>
      </div>
      <div className="card mt">
        <h2>Payment links</h2>
        <p className="note">Everything you have asked this customer to pay, newest first.</p>
        <LinksTable links={p.links} onAction={async (a, l) => { await onLinkAction(a, l); load(); }} />
      </div>
    </>
  );
}

function RowQr({ link, onClose }) {
  const qr = useQr(link.url);
  return (
    <div className="linkbox mt" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {qr && <img src={qr} alt={`QR for ${link.code}`} width={132} height={132} style={{ borderRadius: 12, background: '#fff', padding: 6 }} />}
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 600 }}>{link.reference || link.code} · {R(link.amountCents)}</div>
        <div className="note" style={{ margin: 0 }}>{link.url}</div>
        <QrActions qr={qr} code={link.code} url={link.url} />
      </div>
      <button className="linkish" onClick={onClose}>Close</button>
    </div>
  );
}

function LinksTable({ links, onAction, showCustomer = false, highlight = null }) {
  const [msg, setMsg] = useState('');
  const [qrFor, setQrFor] = useState(null);
  if (!links?.length) return <div className="empty">No links yet.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      {msg && <div className="ok" style={{ marginBottom: 6 }}>{msg}</div>}
      <table>
        <thead><tr><th>Created</th>{showCustomer && <th>Customer</th>}<th>What</th><th className="n">Amount</th><th>Status</th><th>Sent</th><th></th></tr></thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.code} style={highlight === l.code ? { background: 'var(--accent-soft)' } : undefined}>
              <td className="note" style={{ margin: 0, whiteSpace: 'nowrap' }}>{d(l.createdAt)}</td>
              {showCustomer && <td>{l.customerName || <span className="note" style={{ margin: 0 }}>Walk-in</span>}</td>}
              <td>
                <div style={{ fontWeight: 600 }}>{l.reference || l.code}</div>
                <div className="note" style={{ margin: 0 }}>{l.items?.length ? l.items.map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(', ') : l.note || l.code}</div>
              </td>
              <td className="n"><b>{R(l.amountCents)}</b>{l.status === 'PAID' && l.feeCents > 0 && <div className="note" style={{ margin: 0 }}>net {R(l.netCents)}</div>}</td>
              <td><span className={`pill ${statusPill(l.status)}`}>{l.status}</span>{l.status === 'PAID' && <div className="note" style={{ margin: 0 }}>{l.method === 'CARD' ? 'card' : 'WaPay'} · {d(l.paidAt)}</div>}</td>
              <td className="note" style={{ margin: 0 }}>{l.sentAt ? `${d(l.sentAt)} · ${l.channel === 'WHATSAPP_BUSINESS' ? 'WhatsApp' : l.channel === 'WAPAY' ? 'WaPay' : 'copied'}` : '—'}{l.channel === 'WAPAY' && ticks(l.deliveryStatus) && <div style={{ color: l.deliveryStatus === 'failed' ? 'var(--crit)' : l.deliveryStatus === 'read' ? 'var(--accent)' : 'inherit' }}>{ticks(l.deliveryStatus)}</div>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {l.status === 'PENDING' && (
                  <>
                    <button className="btn g sm" onClick={async () => { if (await copyText(l.url)) { setMsg(`Copied ${l.url}`); onAction('sent', { ...l, channel: 'COPY' }); } else setMsg('Could not copy. Open the link and copy it from the address bar.'); }}>Copy</button>{' '}
                    <button className="btn q sm" onClick={() => setQrFor(qrFor === l.code ? null : l.code)} title="QR code">QR</button>{' '}
                    <button className="btn q sm" onClick={() => { if (window.confirm(`Cancel link ${l.code} for ${R(l.amountCents)}?`)) onAction('cancel', l); }}>Cancel</button>
                  </>
                )}
                {l.status !== 'PENDING' && <a className="linkish" href={l.url} target="_blank" rel="noreferrer">view</a>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {qrFor && links.find((x) => x.code === qrFor) && <RowQr link={links.find((x) => x.code === qrFor)} onClose={() => setQrFor(null)} />}
    </div>
  );
}

function Customers({ openId, onOpen, onNewLink, onLinkAction }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [add, setAdd] = useState(false);
  const [imp, setImp] = useState(false);
  const [form, setForm] = useState({ msisdn: '', name: '' });
  const [impText, setImpText] = useState('');
  const [msg, setMsg] = useState('');
  const [msgIsError, setMsgIsError] = useState(false);
  const say = (text, isError = false) => { setMsg(text); setMsgIsError(isError); };
  const load = useCallback(async (search = q, s = sort) => {
    setErr('');
    const j = await getJson(`/api/business/customers?q=${encodeURIComponent(search)}&sort=${s}`);
    if (!j) { setErr('Could not load customers.'); return null; }
    return j;
  }, [q, sort]);
  // Debounced, and a slower older response can never overwrite a newer one.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => { load().then((j) => { if (!cancelled && j) setList(j); }); }, q ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [load, q]);
  const reload = useCallback(() => load().then((j) => { if (j) setList(j); }), [load]);
  if (openId) return <CustomerProfile id={openId} onBack={() => { onOpen(null); reload(); }} onNewLink={onNewLink} onLinkAction={onLinkAction} />;

  const create = async () => {
    say('');
    const r = await api('/api/business/customers', { action: 'create', msisdn: form.msisdn, name: form.name });
    if (!r.ok) { say(r.error === 'BAD_MSISDN' ? 'That is not a valid South African cellphone number.' : r.error === 'CUSTOMER_LIMIT' ? 'This business has reached its customer limit.' : 'Could not add the customer.', true); return; }
    say(r.created ? `Added ${r.customer.name || r.customer.msisdn}.` : `${r.customer.name || r.customer.msisdn} was already on your list.`);
    setForm({ msisdn: '', name: '' }); setAdd(false); reload();
  };
  const runImport = async () => {
    say('');
    const r = await api('/api/business/customers', { action: 'import', text: impText });
    if (!r.ok) { say('Import failed.', true); return; }
    say(`Found ${r.parsed} numbers: ${r.added} added, ${r.updated} updated, ${r.skipped} already there${r.refused ? `, ${r.refused} refused (customer limit)` : ''}.`);
    setImpText(''); setImp(false); reload();
  };
  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 220 }}><input placeholder="Search by name or number" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reload()} /></div>
          <div className="seg">{[['recent', 'Recent'], ['spend', 'Top spend'], ['outstanding', 'Owing'], ['name', 'A–Z']].map(([k, l]) => <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>)}</div>
          <button className="btn g" onClick={() => { setImp(!imp); setAdd(false); }}>Import</button>
          <button className="btn p" onClick={() => { setAdd(!add); setImp(false); }}>＋ Add customer</button>
        </div>
        {add && (
          <div className="grid two mt">
            <div><label className="f">WhatsApp number</label><input inputMode="tel" placeholder="073 123 4567" value={form.msisdn} onChange={(e) => setForm({ ...form, msisdn: e.target.value })} /></div>
            <div><label className="f">Name</label><div style={{ display: 'flex', gap: 8 }}><input placeholder="Thabo Nkosi" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && create()} /><button className="btn p" onClick={create}>Save</button></div></div>
          </div>
        )}
        {imp && (
          <div className="mt">
            <label className="f">Drop a file, or paste your contacts</label>
            <div
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={async (e) => { e.preventDefault(); const fl = e.dataTransfer?.files?.[0]; if (!fl) return; const txt = await fl.text(); setImpText((cur) => (cur ? cur + '\n' : '') + txt); }}
              style={{ border: '1px dashed var(--field-edge)', borderRadius: 14, padding: '14px 16px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <span className="note" style={{ margin: 0, flex: 1, minWidth: 220 }}><b>CSV, TXT or vCard (.vcf)</b> with name, surname and WhatsApp number in any column order: drop it here or choose it. Every row becomes a customer.</span>
              <input type="file" accept=".csv,.txt,.vcf,text/csv,text/plain,text/vcard,text/x-vcard" onChange={async (e) => { const fl = e.target.files?.[0]; e.target.value = ''; if (!fl) return; const txt = await fl.text(); setImpText((cur) => (cur ? cur + '\n' : '') + txt); }} />
            </div>
            <p className="note">Or one per line: <b>Thabo Nkosi, 073 123 4567</b>. An export from your phone, Google Contacts or Excel works as is. WhatsApp itself does not let apps read your contact list, so bring them across once; anyone who pays a link is added automatically.</p>
            <textarea rows={6} value={impText} onChange={(e) => setImpText(e.target.value)} placeholder={'Thabo Nkosi, 073 123 4567\nLerato M, 082 555 1234'} />
            <button className="btn p" style={{ marginTop: 10 }} onClick={runImport} disabled={!impText.trim()}>Import contacts</button>
          </div>
        )}
        {msg && <div className={msgIsError ? 'err' : 'ok'}>{msg}</div>}
        {err && <div className="err">{err}</div>}
      </div>
      <div className="card mt">
        <h2>Customers {list && <span className="note" style={{ display: 'inline', fontWeight: 400 }}>· {list.total}</span>}</h2>
        <p className="note">Tap anyone for their profile and full payment history.</p>
        {!list && !err && <div className="empty">Loading…</div>}
        {list && !list.customers.length && <div className="empty">No customers yet. Add one above, or send a payment link: whoever pays is added automatically.</div>}
        {list && list.customers.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Customer</th><th>Joined</th><th className="n">Paid</th><th className="n">Payments</th><th className="n">Average</th><th className="n">Outstanding</th><th>Last paid</th></tr></thead>
              <tbody>
                {list.customers.map((c) => (
                  <tr key={c.id} className="row" role="button" tabIndex={0} onClick={() => onOpen(c.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(c.id); } }}>
                    <td><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="avatar">{initials(c.name, c.msisdn)}</span><div><div style={{ fontWeight: 600 }}>{c.name || <span className="note" style={{ margin: 0 }}>Unnamed</span>}</div><div className="note" style={{ margin: 0 }}>{c.msisdn}{c.isWaPayUser ? ' · WaPay' : ''}</div></div></div></td>
                    <td className="note" style={{ margin: 0 }}>{d(c.createdAt)}</td>
                    <td className="n"><b>{R(c.paidCents)}</b></td>
                    <td className="n">{c.paidCount}</td>
                    <td className="n">{c.avgCents != null ? R(c.avgCents) : '—'}</td>
                    <td className="n" style={{ color: c.openCents ? 'var(--warn)' : 'var(--ink3)' }}>{c.openCents ? R(c.openCents) : '—'}</td>
                    <td className="note" style={{ margin: 0 }}>{c.lastPaidAt ? d(c.lastPaidAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Payment links — the POS composer
// ---------------------------------------------------------------------------

function Composer({ preset, customers, recentItems, defaultTtl, onCreated }) {
  const [customer, setCustomer] = useState(preset || null);
  const [pick, setPick] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([{ name: '', qty: 1, price: '' }]);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [ttl, setTtl] = useState(defaultTtl || 7);
  const [quote, setQuote] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCustomer(preset || null); }, [preset]);
  useEffect(() => { setTtl(defaultTtl || 7); }, [defaultTtl]);

  // A row is COMPLETE when name, quantity (1+) and price all parse; a row
  // someone started but did not finish is INCOMPLETE and blocks creation —
  // silently dropping it would bill the customer for less than was typed
  // (review 2026-09-05, HIGH). Blank rows are ignored.
  const rowState = (it) => {
    const touched = it.name.trim() || String(it.price).trim() || (String(it.qty) !== '1' && String(it.qty) !== '');
    const qtyN = Number(it.qty);
    const ok = it.name.trim() && toCents(it.price) != null && Number.isInteger(qtyN) && qtyN >= 1 && qtyN <= 999;
    return ok ? 'ok' : touched ? 'bad' : 'blank';
  };
  const validItems = items.filter((it) => rowState(it) === 'ok');
  const incomplete = items.filter((it) => rowState(it) === 'bad');
  const itemsTotal = validItems.reduce((a, it) => a + Number(it.qty) * toCents(it.price), 0);
  const totalCents = validItems.length ? itemsTotal : toCents(amount) ?? 0;
  useEffect(() => {
    if (!totalCents || totalCents < 500) { setQuote(null); return; }
    let cancelled = false;
    const t = setTimeout(() => api('/api/business/links', { action: 'quote', amountCents: totalCents }).then((r) => {
      // A late reply for an older total must never be shown under the new one.
      if (!cancelled && r.ok && r.quote?.amountCents === totalCents) setQuote(r.quote);
    }), 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [totalCents]);
  const quoteMatches = quote && quote.amountCents === totalCents;

  const matches = useMemo(() => {
    const s = pick.trim().toLowerCase(); const digits = s.replace(/\D/g, '');
    return (customers || []).filter((c) => !s || (c.name || '').toLowerCase().includes(s) || (digits.length >= 3 && c.msisdn.includes(digits))).slice(0, 8);
  }, [customers, pick]);
  // A name that is not on the list yet becomes a customer right here (founder
  // 2026-09-10: a typed name used to fall through as a walk-in), so the link is
  // filed under them and the WhatsApp send has a number to go to.
  const [newCust, setNewCust] = useState(null); // { name, msisdn }
  const [custBusy, setCustBusy] = useState(false);
  const [custErr, setCustErr] = useState('');
  const startNew = () => { const t = pick.trim(); const digits = t.replace(/\D/g, ''); setNewCust(digits.length >= 9 && /^[\s+()\d-]+$/.test(t) ? { name: '', msisdn: t } : { name: t, msisdn: '' }); setOpen(false); setCustErr(''); };
  const saveNew = async () => {
    setCustErr('');
    if (!/\d{9}/.test(String(newCust?.msisdn || '').replace(/\D/g, ''))) { setCustErr('Enter the customer\'s WhatsApp number, e.g. 073 123 4567.'); return; }
    setCustBusy(true);
    try {
      const r = await api('/api/business/customers', { action: 'create', msisdn: newCust.msisdn, name: newCust.name });
      if (!r.ok) { setCustErr(r.error === 'BAD_MSISDN' ? 'That is not a valid South African cellphone number.' : r.error === 'CUSTOMER_LIMIT' ? 'This business has reached its customer limit.' : 'Could not add the customer.'); return; }
      setCustomer(r.customer); setNewCust(null); setPick('');
    } catch { setCustErr('No connection. Try again.'); } finally { setCustBusy(false); }
  };

  const create = async () => {
    setErr('');
    if (busy) return;
    if (incomplete.length) { setErr(`Item ${items.indexOf(incomplete[0]) + 1} needs a name, a quantity of 1 or more, and a price like 150 or 150,00.`); return; }
    if (!totalCents || totalCents < 500) { setErr('The total must be at least R5.'); return; }
    setBusy(true);
    try {
      const body = {
        action: 'create',
        customerId: customer?.id || null,
        items: validItems.map((it) => ({ name: it.name.trim(), qty: Number(it.qty), unitCents: toCents(it.price) })),
        amountCents: validItems.length ? undefined : totalCents,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
        ttlDays: Number(ttl),
      };
      const r = await api('/api/business/links', body);
      if (!r.ok) {
        setErr(r.error === 'REQUEST_LIMIT' ? 'You have reached the open-links limit. Cancel or wait for some to be paid.' : r.message || 'Could not create the link.');
        return;
      }
      onCreated(r);
      setItems([{ name: '', qty: 1, price: '' }]); setAmount(''); setReference(''); setNote('');
    } catch { setErr('No connection. Try again.'); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <h2>New payment link</h2>
      <p className="note">Pick the customer, add what they bought, send. The customer pays exactly the total; card costs come off your side and paying from a WaPay balance is free.</p>
      <label className="f">Customer</label>
      <div style={{ position: 'relative' }}>
        {customer ? (
          <div className="linkbox"><span className="avatar" style={{ width: 28, height: 28, fontSize: 11, borderRadius: 9 }}>{initials(customer.name, customer.msisdn)}</span><code style={{ color: 'var(--ink)' }}>{customer.name || 'Unnamed'} · {customer.msisdn}</code><button className="btn q sm" onClick={() => { setCustomer(null); setPick(''); }}>Change</button></div>
        ) : newCust ? (
          <div className="linkbox" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input style={{ flex: '1 1 160px' }} placeholder="Name" value={newCust.name} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} maxLength={80} autoFocus={!newCust.name} />
            <input style={{ flex: '1 1 160px' }} inputMode="tel" placeholder="WhatsApp number, e.g. 073 123 4567" value={newCust.msisdn} onChange={(e) => setNewCust({ ...newCust, msisdn: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && !custBusy && saveNew()} autoFocus={!!newCust.name} />
            <button className="btn p sm" disabled={custBusy} onClick={saveNew}>{custBusy ? 'Saving…' : 'Save customer'}</button>
            <button className="btn q sm" onClick={() => { setNewCust(null); setPick(''); }}>Cancel</button>
            {custErr && <div className="err" style={{ width: '100%', marginTop: 0 }}>{custErr}</div>}
          </div>
        ) : (
          <div onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
            <input placeholder="Type a name or number (new customers are added on the spot), or leave empty for a walk-in" value={pick} role="combobox" aria-expanded={open && (matches.length > 0 || !!pick.trim())} aria-controls="customer-options"
              onChange={(e) => { setPick(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
              onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); document.getElementById('customer-options')?.querySelector('button')?.focus(); } if (e.key === 'Enter') { if (matches.length === 1) { setCustomer(matches[0]); setOpen(false); } else if (matches.length === 0 && pick.trim()) startNew(); } }} />
            {open && (matches.length > 0 || pick.trim()) && (
              <div className="dd" id="customer-options" role="listbox">{matches.map((c) => <button key={c.id} role="option" aria-selected={false} onClick={() => { setCustomer(c); setOpen(false); }}
                onKeyDown={(e) => { const sib = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.key === 'ArrowUp' ? e.currentTarget.previousElementSibling : null; if (sib) { e.preventDefault(); sib.focus(); } }}>
                <span className="avatar" style={{ width: 28, height: 28, fontSize: 11, borderRadius: 9 }}>{initials(c.name, c.msisdn)}</span><span style={{ flex: 1 }}>{c.name || 'Unnamed'}<div className="note" style={{ margin: 0 }}>{c.msisdn}</div></span>{c.paidCount > 0 && <span className="note" style={{ margin: 0 }}>{c.paidCount} paid</span>}</button>)}
                {pick.trim() && !matches.some((c) => (c.name || '').toLowerCase() === pick.trim().toLowerCase() || c.msisdn === pick.trim().replace(/\D/g, '')) && (
                  <button role="option" aria-selected={false} onClick={startNew} onKeyDown={(e) => { const sib = e.key === 'ArrowUp' ? e.currentTarget.previousElementSibling : null; if (sib) { e.preventDefault(); sib.focus(); } }}>
                    <span className="avatar" style={{ width: 28, height: 28, fontSize: 14, borderRadius: 9 }}>＋</span><span style={{ flex: 1 }}>Add “{pick.trim()}” as a new customer<div className="note" style={{ margin: 0 }}>Name and WhatsApp number, saved to your list</div></span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <label className="f" style={{ marginTop: 14 }}>Items</label>
      {recentItems?.length > 0 && (
        <div className="chips" style={{ marginBottom: 8 }}>
          {recentItems.map((ri) => <button key={ri.name} className="chip" onClick={() => setItems((cur) => { const blank = cur.findIndex((it) => !it.name.trim()); const row = { name: ri.name, qty: 1, price: (ri.unitCents / 100).toFixed(2) }; if (blank >= 0) { const n = [...cur]; n[blank] = row; return n; } return [...cur, row]; })}>{ri.name} · {R(ri.unitCents)}</button>)}
        </div>
      )}
      {items.map((it, i) => (
        <div className="items" key={i} style={{ marginBottom: 8 }}>
          <input placeholder={i === 0 ? 'Wash & fold 5kg' : 'Item'} value={it.name} aria-label={`Item ${i + 1} name`} className={rowState(it) === 'bad' && !it.name.trim() ? 'bad' : ''} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={60} />
          <input inputMode="numeric" value={it.qty} aria-label={`Item ${i + 1} quantity`} className={rowState(it) === 'bad' && !(Number(it.qty) >= 1) ? 'bad' : ''} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '').slice(0, 3) } : x)))} title="Quantity (1 or more)" />
          <input inputMode="decimal" placeholder="R 0.00" value={it.price} aria-label={`Item ${i + 1} unit price`} className={rowState(it) === 'bad' && toCents(it.price) == null ? 'bad' : ''} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} title="Unit price, e.g. 150 or 150,00" />
          <button className="btn q sm" style={{ padding: '7px 0' }} onClick={() => setItems(items.length > 1 ? items.filter((_, j) => j !== i) : [{ name: '', qty: 1, price: '' }])} title="Remove">×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn q sm" onClick={() => setItems([...items, { name: '', qty: 1, price: '' }])}>＋ Add item</button>
        {!validItems.length && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="note" style={{ margin: 0 }}>or just an amount</span><input style={{ width: 130 }} inputMode="decimal" placeholder="R 150.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}
      </div>
      <div className="grid two mt">
        <div><label className="f">Reference (ticket / order number)</label><input placeholder="T-1042" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={40} /></div>
        <div><label className="f">Link stays open for</label><select value={ttl} onChange={(e) => setTtl(e.target.value)}>{[3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} days</option>)}</select></div>
      </div>
      <label className="f" style={{ marginTop: 10 }}>Note to the customer (optional)</label>
      <input placeholder="Ready for collection from 4pm" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
      <div className="total">
        <div>
          <div className="k">Customer pays</div>
          {incomplete.length > 0 && <div className="err" style={{ marginTop: 4 }}>Finish or remove item {items.indexOf(incomplete[0]) + 1} before creating the link.</div>}
          {quoteMatches && <div className="note" style={{ margin: '4px 0 0' }}>You receive <b>{R(quote.netBalanceCents)}</b> from a WaPay balance, or <b>{R(quote.netCardCents)}</b> by card{quote.feeCents ? ` (${R(quote.feeCents)} card cost${quote.feeIncludesVat ? ' incl. VAT' : ''})` : quote.freeBelowCents ? ` (no card cost under ${R(quote.freeBelowCents)})` : ''}. The customer pays exactly the total either way.</div>}
        </div>
        <b>{totalCents ? R(totalCents) : 'R0.00'}</b>
      </div>
      <button className="btn p" style={{ width: '100%', marginTop: 12, padding: 14, fontSize: 15 }} disabled={busy || !totalCents || incomplete.length > 0} onClick={create}>{busy ? 'Creating…' : customer ? `Create link for ${customer.name ? customer.name.split(' ')[0] : customer.msisdn}` : 'Create link'}</button>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function Created({ result: initial, onDone }) {
  const [result, setResult] = useState(initial);
  useEffect(() => { setResult(initial); }, [initial]);
  const [copied, setCopied] = useState('');
  const [nudged, setNudged] = useState('');
  const l = result.link;
  const [blocked, setBlocked] = useState(false);
  const qr = useQr(l.url);
  // Walk-in link → a customer, after the fact (founder 2026-09-10).
  const [att, setAtt] = useState({ msisdn: '', name: '' });
  const [attBusy, setAttBusy] = useState(false);
  const [attErr, setAttErr] = useState('');
  const attach = async () => {
    setAttErr('');
    if (!/\d{9}/.test(att.msisdn.replace(/\D/g, ''))) { setAttErr('Enter the customer\'s WhatsApp number.'); return; }
    setAttBusy(true);
    try {
      const r = await api('/api/business/links', { action: 'attach', code: l.code, msisdn: att.msisdn, name: att.name });
      if (!r.ok) { setAttErr(r.error === 'BAD_MSISDN' ? 'That is not a valid South African cellphone number.' : r.error === 'NOT_OPEN' ? 'This link is no longer open.' : 'Could not attach the customer.'); return; }
      setResult({ ...result, link: r.link, message: r.message, waLink: r.waLink, nudge: r.nudge });
    } catch { setAttErr('No connection. Try again.'); } finally { setAttBusy(false); }
  };
  const sendWa = async () => {
    // A blocked popup must not be recorded as "sent" (shop PCs block popups).
    const w = window.open(result.waLink, '_blank', 'noopener');
    if (!w) { setBlocked(true); return; }
    await api('/api/business/links', { action: 'sent', code: l.code, channel: 'WHATSAPP_BUSINESS' });
    onDone('sent');
  };
  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="avatar" style={{ background: 'linear-gradient(135deg,#25D366,#1a9e4a)' }}>✓</span>
        <div style={{ flex: 1 }}><h2 style={{ fontSize: 16 }}>Link ready · {R(l.amountCents)}{l.customerName ? ` for ${l.customerName}` : ''}</h2><div className="note" style={{ margin: 0 }}>{l.code} · open until {d(l.expiresAt)}{l.reference ? ` · ref ${l.reference}` : ''}</div></div>
        <button className="linkish" onClick={() => onDone('close')}>Close</button>
      </div>
      <div className="linkbox mt"><code>{l.url}</code><button className="btn g sm" onClick={async () => { if (await copyText(l.url)) { setCopied('Link copied'); api('/api/business/links', { action: 'sent', code: l.code, channel: 'COPY' }); } else setCopied('Could not copy. Select the link and copy it by hand.'); }}>Copy link</button></div>
      <div className="grid two mt">
        <div>
          <label className="f">Message ready to send</label>
          <div className="msg">{result.message}</div>
          <button className="btn q sm" style={{ marginTop: 8 }} onClick={async () => { setCopied((await copyText(result.message)) ? 'Message copied' : 'Could not copy. Select the message and copy it by hand.'); }}>Copy message</button>
        </div>
        <div>
          <label className="f">Send it</label>
          {result.waLink ? (
            <>
              <button className="btn wa" style={{ width: '100%', padding: 14, fontSize: 15 }} onClick={sendWa}>Send on WhatsApp</button>
              {blocked && <div className="err">Your browser blocked the WhatsApp window. <a href={result.waLink} target="_blank" rel="noreferrer" onClick={() => api('/api/business/links', { action: 'sent', code: l.code, channel: 'WHATSAPP_BUSINESS' })}>Open WhatsApp here</a> instead.</div>}
              <p className="note" style={{ marginTop: 8 }}>Opens your own WhatsApp with the message filled in for this customer. You tap send, so it arrives from your business, not from WaPay.</p>
            </>
          ) : (
            <>
              <p className="note">Walk-in link: copy it, show the QR, or paste it into any chat. Whoever pays is added to your customers automatically.</p>
              <label className="f" style={{ marginTop: 8 }}>Or send it to a customer</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input style={{ flex: '1 1 150px' }} inputMode="tel" placeholder="WhatsApp number" value={att.msisdn} onChange={(e) => setAtt({ ...att, msisdn: e.target.value })} />
                <input style={{ flex: '1 1 120px' }} placeholder="Name (optional)" value={att.name} onChange={(e) => setAtt({ ...att, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && !attBusy && attach()} />
                <button className="btn g sm" disabled={attBusy} onClick={attach}>{attBusy ? 'Saving…' : 'Attach & send'}</button>
              </div>
              {attErr && <div className="err">{attErr}</div>}
            </>
          )}
          {result.nudge?.available && (
            <button className="btn g" style={{ width: '100%', marginTop: 8 }} disabled={nudged === 'ok'} onClick={async () => { const r = await api('/api/business/links', { action: 'nudge', code: l.code }); setNudged(r.ok ? 'ok' : r.error === 'RATE_LIMITED' ? 'Daily WaPay send limit reached.' : r.error === 'ALREADY_SENT' ? 'Already handed to WaPay for this link.' : 'Could not send from WaPay right now.'); }}>Also send from WaPay</button>
          )}
          {nudged === 'ok' && <div className="ok">Handed to WhatsApp for delivery from WaPay. The ticks in the list below update as it is sent, delivered and read.</div>}
          {nudged && nudged !== 'ok' && <div className="err">{nudged}</div>}
          <p className="note" style={{ marginTop: 10 }}>You receive {R(result.quote.netBalanceCents)} if they pay from a WaPay balance, or {R(result.quote.netCardCents)} by card. The customer always pays exactly {R(l.amountCents)}.</p>
        </div>
      </div>
      {copied && <div className={copied.startsWith('Could') ? 'err' : 'ok'}>{copied}</div>}
      {qr && (
        <div className="mt" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <img src={qr} alt={`QR code for ${l.url}`} width={148} height={148} style={{ borderRadius: 14, background: '#fff', padding: 6, flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="f">QR code for this payment</label>
            <p className="note" style={{ margin: 0 }}>Show it on the screen, print it on the ticket, or share it. Anyone who scans it lands on the pay page for exactly {R(l.amountCents)}.</p>
            <QrActions qr={qr} code={l.code} url={l.url} />
          </div>
        </div>
      )}
    </div>
  );
}

function Links({ presetCustomer, onLinkAction, focusCode }) {
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('open');
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    setErr('');
    const j = await getJson(`/api/business/links?status=${status}&limit=200`);
    if (j) setList(j); else setErr('Could not load links.');
  }, [status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getJson('/api/business/customers?sort=recent').then((j) => setCustomers(j?.customers || []));
    getJson('/api/business/settings').then((j) => setSettings(j));
  }, [result]);
  useEffect(() => { if (focusCode) setStatus('open'); }, [focusCode]);
  const act = async (a, l) => { await onLinkAction(a, l); load(); };
  return (
    <>
      {result ? <Created result={result} onDone={() => { setResult(null); load(); }} /> : (
        <Composer preset={presetCustomer} customers={customers} recentItems={settings?.business?.settings?.recentItems || []} defaultTtl={settings?.business?.settings?.defaultTtlDays} onCreated={(r) => { setResult(r); load(); }} />
      )}
      <div className="card mt">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ flex: 1 }}>Payment links {list && <span className="note" style={{ display: 'inline', fontWeight: 400 }}>· {list.total}</span>}</h2>
          <div className="seg">{[['open', 'Open'], ['paid', 'Paid'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
          <a className="btn q sm" href="/api/business/export?days=90">Export CSV (90 days)</a>
        </div>
        <p className="note">Copy re-sends the same link; cancelling closes it so it can no longer be paid.</p>
        {err && <div className="err">{err}</div>}
        {!list && !err && <div className="empty">Loading…</div>}
        {list && <LinksTable links={list.links} onAction={act} showCustomer highlight={focusCode} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Payouts (founder ask 2026-09-10): the balance, and paying it out on OTT's
// rail. Every request needs a fresh factor and mints its own intent id, so a
// double click can never pay twice.
// ---------------------------------------------------------------------------

const newIntentId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function Payouts() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [method, setMethod] = useState('PAYSHAP');
  const [amount, setAmount] = useState('');
  const [rec, setRec] = useState({ firstname: '', surname: '', id_number: '', mobile: '', account_number: '', branch_code: '', branch_name: '' });
  const [stepUp, setStepUp] = useState('');
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [intentId, setIntentId] = useState('');
  const load = useCallback(() => getJson('/api/business/payout').then((j) => { if (j) setSt(j); else setErr('Could not load payouts.'); }), []);
  useEffect(() => { load(); setIntentId(newIntentId()); }, [load]);
  const amountCents = toCents(amount) ?? 0;
  useEffect(() => {
    if (!amountCents || !st?.enabled) { setQuote(null); return undefined; }
    let live = true;
    const t = setTimeout(() => api('/api/business/payout', { action: 'quote', method, amountCents }).then((r) => { if (live) setQuote(r.ok ? r.quote : { error: r.error, minCents: r.minCents, maxCents: r.maxCents }); }), 250);
    return () => { live = false; clearTimeout(t); };
  }, [amountCents, method, st?.enabled]);
  if (err) return <div className="card"><div className="err">{err}</div></div>;
  if (!st) return <div className="card"><div className="empty">Loading…</div></div>;
  const m = st.methods.find((x) => x.method === method) || st.methods[0];
  const need = new Set(m?.requiredFields || []);
  const submit = async () => {
    setErr('');
    if (!quote || quote.error) { setErr('Enter an amount within the limits first.'); return; }
    if (!stepUp) { setErr(st.hasPassword ? 'Enter your portal password to confirm.' : 'Enter a one-time code to confirm.'); return; }
    if (!window.confirm(`Pay out ${R(amountCents)} by ${m.label} to ${rec.firstname} ${rec.surname}? Fee ${R(quote.feeCents)}, ${R(quote.totalCents)} leaves your balance.`)) return;
    setBusy(true);
    try {
      const r = await api('/api/business/payout', { action: 'request', intentId, method, amountCents, recipient: rec, ...(st.hasPassword ? { currentPassword: stepUp } : { code: stepUp }) });
      setResult(r);
      if (r.ok) { setAmount(''); setStepUp(''); setIntentId(newIntentId()); load(); }
      else if (r.error === 'STEP_UP_FAILED') setErr('That password or code did not work.');
      else if (r.error === 'KYC_REQUIRED') setErr('Pay-outs need identity verification first. Ask WaPay to send you the verification link on WhatsApp.');
      else if (r.error === 'INSUFFICIENT_FUNDS') setErr(`Not enough balance: ${R(r.totalCents || quote.totalCents)} is needed including the fee.`);
      else if (r.error === 'BAD_RECIPIENT') setErr(`Please fill in the recipient's ${String(r.field || 'details').replace('_', ' ')}.`);
      else setErr(r.error === 'DISABLED' ? 'Pay-outs are not switched on yet.' : r.error === 'NO_PROVIDER' ? 'That pay-out method is not available right now.' : `The pay-out did not go through (${r.error || 'error'}). Nothing has left your balance.`);
    } catch { setErr('No connection. Try again.'); } finally { setBusy(false); }
  };
  const hist = st.history || [];
  return (
    <>
      <div className="grid kpis">
        <div className="card"><div className="k">Available balance</div><div className="v">{R(st.balance.totalCents)}</div><div className="vs">{st.balance.cashCents ? `${R(st.balance.cashCents)} already cleared for pay-out` : 'Everything customers paid you, minus card costs'}</div></div>
        <div className="card"><div className="k">Pay-out fees</div><div className="v" style={{ fontSize: 18 }}>{st.methods.map((x) => x.label.split(' ')[0]).join(' · ')}</div><div className="vs">Flat fee per pay-out; you see it before you confirm. PayShap arrives in minutes.</div></div>
        <div className="card"><div className="k">Identity</div><div className="v" style={{ fontSize: 18 }}>{st.kyc.verified ? 'Verified' : st.kyc.required ? 'Not verified yet' : 'Not required (test)'}</div><div className="vs">{st.kyc.verified ? 'Pay-outs are open to your own bank account.' : 'Pay-outs need a once-off ID check on WhatsApp.'}</div></div>
      </div>
      {!st.enabled || !st.configured ? (
        <div className="card mt">
          <h2>Pay out your balance</h2>
          <p className="note">Three ways, all from this page: <b>PayShap</b> to your bank in minutes using your cellphone number (R6 flat), a <b>bank transfer</b> to any account (R8 flat, usually within the hour), or <b>cash at an Absa or Nedbank ATM</b> with no bank account needed (from R16). A once-off identity check applies. The rail is integrated and tested and goes live once the pay-out provider's sandbox sign-off and the compliance review are done. Until then your balance keeps working for airtime, data, electricity and WaPay payments, and every rand stays yours.</p>
        </div>
      ) : (
        <div className="card mt">
          <h2>Pay out your balance</h2>
          <p className="note">Money goes to the bank account or ATM cash you choose below. Minimum {R(st.limits.minCents)}, maximum {R(st.limits.maxCents)} per pay-out.</p>
          <div className="grid two">
            <div>
              <label className="f">How</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>{st.methods.map((x) => <option key={x.method} value={x.method} disabled={st.enabled && !x.live}>{x.label}{st.enabled && !x.live ? ' (not available now)' : ''}</option>)}</select>
              {m?.hint && <p className="note" style={{ margin: '4px 0 0' }}>{m.hint}</p>}
            </div>
            <div><label className="f">Amount</label><input inputMode="decimal" placeholder="R 500.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          </div>
          <div className="grid two mt">
            <div><label className="f">Recipient first name</label><input value={rec.firstname} onChange={(e) => setRec({ ...rec, firstname: e.target.value })} maxLength={40} /></div>
            <div><label className="f">Surname</label><input value={rec.surname} onChange={(e) => setRec({ ...rec, surname: e.target.value })} maxLength={40} /></div>
            {need.has('mobile') && <div><label className="f">Recipient cellphone</label><input inputMode="tel" placeholder="073 123 4567" value={rec.mobile} onChange={(e) => setRec({ ...rec, mobile: e.target.value })} /></div>}
            {need.has('account_number') && <div><label className="f">Bank account number</label><input inputMode="numeric" value={rec.account_number} onChange={(e) => setRec({ ...rec, account_number: e.target.value })} /></div>}
            {need.has('branch_code') && <div><label className="f">Universal branch code</label><input inputMode="numeric" placeholder="e.g. 250655" value={rec.branch_code} onChange={(e) => setRec({ ...rec, branch_code: e.target.value })} /></div>}
            {need.has('branch_code') && <div><label className="f">Bank</label><input placeholder="e.g. FNB" value={rec.branch_name} onChange={(e) => setRec({ ...rec, branch_name: e.target.value })} /></div>}
            {need.has('id_number') && <div><label className="f">Recipient SA ID number</label><input inputMode="numeric" maxLength={13} value={rec.id_number} onChange={(e) => setRec({ ...rec, id_number: e.target.value })} /></div>}
          </div>
          <div className="total">
            <div>
              <div className="k">Leaves your balance</div>
              {quote && !quote.error && <div className="note" style={{ margin: '4px 0 0' }}>{R(quote.amountCents)} to the recipient + {R(quote.feeCents)} fee</div>}
              {quote?.error === 'BAD_AMOUNT' && <div className="err" style={{ marginTop: 4 }}>Between {R(quote.minCents)} and {R(quote.maxCents)} per pay-out.</div>}
            </div>
            <b>{quote && !quote.error ? R(quote.totalCents) : 'R0.00'}</b>
          </div>
          <label className="f" style={{ marginTop: 10 }}>{st.hasPassword ? 'Your portal password' : 'One-time code (WhatsApp "business login" to WaPay)'}</label>
          <input type={st.hasPassword ? 'password' : 'text'} autoComplete={st.hasPassword ? 'current-password' : 'one-time-code'} value={stepUp} onChange={(e) => setStepUp(e.target.value)} />
          <button className="btn p" style={{ width: '100%', marginTop: 12, padding: 14, fontSize: 15 }} disabled={busy || !quote || quote.error || !st.kyc.verified && st.kyc.required} onClick={submit}>{busy ? 'Paying out…' : 'Pay out'}</button>
          {err && <div className="err">{err}</div>}
          {result?.ok && <div className="ok">{result.status === 'SETTLED' ? `Paid. Reference ${result.reference}.` : `Accepted by the bank rail, reference ${result.reference}. It shows as paid below as soon as the bank confirms.`}</div>}
        </div>
      )}
      <div className="card mt">
        <h2>Pay-out history</h2>
        {!hist.length ? <div className="empty">No pay-outs yet.</div> : (
          <div style={{ overflowX: 'auto' }}><table>
            <thead><tr><th>Date</th><th>Reference</th><th>How</th><th>To</th><th className="n">Amount</th><th className="n">Fee</th><th>Status</th></tr></thead>
            <tbody>{hist.map((h) => <tr key={h.reference}><td className="note" style={{ margin: 0, whiteSpace: 'nowrap' }}>{dt(h.createdAt)}</td><td><code>{h.reference}</code></td><td>{h.method}</td><td>{h.recipient?.name}{h.recipient?.account ? ` · ${h.recipient.account}` : h.recipient?.mobile ? ` · ${h.recipient.mobile}` : ''}</td><td className="n">{R(h.amountCents)}</td><td className="n">{R(h.feeCents)}</td><td><span className={`pill ${h.status === 'SUCCESS' ? 'g' : h.status === 'PENDING' ? 'y' : 'r'}`}>{h.status === 'SUCCESS' ? 'PAID' : h.status}</span></td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function Settings() {
  const [s, setS] = useState(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [ttl, setTtl] = useState(7);
  const [logoBusy, setLogoBusy] = useState(false);
  const [pw, setPw] = useState('');
  const [stepUp, setStepUp] = useState(''); // current password, or a fresh code
  const [msg, setMsg] = useState('');
  const [msgIsError, setMsgIsError] = useState(false);
  const say = (text, isError = false) => { setMsg(text); setMsgIsError(isError); };
  const load = useCallback(() => getJson('/api/business/settings').then((j) => { if (!j) return; setS(j); setName(j.business?.name || ''); setCategory(j.business?.category || ''); setTtl(j.business?.settings?.defaultTtlDays || 7); }), []);
  useEffect(() => { load(); }, [load]);
  if (!s) return <div className="card"><div className="empty">Loading…</div></div>;
  return (
    <div className="grid two">
      <div className="card">
        <h2>Your business</h2>
        <p className="note">Shown to customers on every link. Money lands in the WaPay wallet of {s.owner?.msisdn || 'the owner'}.</p>
        <label className="f">Logo</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          {s.business?.settings?.logo ? <img src={s.business.settings.logo} alt="" width={56} height={56} style={{ borderRadius: 14, objectFit: 'cover', flex: 'none' }} /> : <span className="avatar" style={{ width: 56, height: 56, borderRadius: 14, fontSize: 18 }}>{initials(s.business?.name, '')}</span>}
          <div style={{ flex: 1, minWidth: 220 }}>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={logoBusy} onChange={async (e) => {
              const fl = e.target.files?.[0]; e.target.value = ''; if (!fl) return;
              say(''); setLogoBusy(true);
              try {
                const dataUrl = await fileToLogoDataUrl(fl);
                const r = await api('/api/business/settings', { action: 'logo', dataUrl });
                if (r.ok) { say('Logo saved.'); window.dispatchEvent(new Event('wapay:refresh')); } else say(r.error === 'LOGO_TOO_BIG' ? 'That image is too large even after resizing. Try a simpler one.' : 'Could not save the logo.', true);
                load();
              } catch { say('That file is not an image we can read.', true); } finally { setLogoBusy(false); }
            }} />
            <p className="note" style={{ margin: '4px 0 0' }}>PNG, JPEG or WebP. It is resized to a small square and shown next to your name here and on every pay page. WhatsApp does not share business profile pictures with other apps, so upload the same one you use there.</p>
            {s.business?.settings?.logo && <button className="linkish" onClick={async () => { const r = await api('/api/business/settings', { action: 'logo', dataUrl: null }); if (r.ok) { say('Logo removed.'); window.dispatchEvent(new Event('wapay:refresh')); load(); } }}>Remove logo</button>}
          </div>
        </div>
        <label className="f">Business name</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <label className="f" style={{ marginTop: 10 }}>Category</label><select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">—</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        <label className="f" style={{ marginTop: 10 }}>Links stay open for</label><select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>{[3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} days</option>)}</select>
        <button className="btn p" style={{ marginTop: 14 }} onClick={async () => {
          say('');
          const a = await api('/api/business/settings', { action: 'profile', name, category });
          const b = await api('/api/business/settings', { action: 'defaults', defaultTtlDays: ttl });
          if (a.ok && b.ok) say('Saved.'); else say(a.error === 'NAME_NOT_ALLOWED' ? 'That name is not allowed. Use your own trading name.' : 'Could not save.', true);
          load();
        }}>Save</button>
        {msg && <div className={msgIsError ? 'err' : 'ok'}>{msg}</div>}
      </div>
      <div className="card">
        <h2>Password</h2>
        <p className="note">{s.hasPassword ? 'A password is set. Sign in from a computer without waiting for a code.' : 'No password yet. Set one so you can sign in from the shop computer without a WhatsApp code.'}</p>
        <label className="f">{s.hasPassword ? 'Current password' : 'One-time code (WhatsApp "business login" to WaPay from your phone)'}</label>
        <input type={s.hasPassword ? 'password' : 'text'} inputMode={s.hasPassword ? undefined : 'numeric'} autoComplete={s.hasPassword ? 'current-password' : 'one-time-code'} value={stepUp} onChange={(e) => setStepUp(e.target.value)} placeholder={s.hasPassword ? '' : '123456'} />
        <label className="f" style={{ marginTop: 10 }}>{s.hasPassword ? 'New password' : 'Password'} (10+ characters)</label>
        <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <p className="note" style={{ marginTop: 8 }}>Changing the password needs {s.hasPassword ? 'your current password' : 'a fresh code'}: a signed-in browser alone is never enough.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn g" disabled={pw.length < 10 || !stepUp} onClick={async () => {
            const r = await api('/api/business/settings', { action: 'set-password', password: pw, ...(s.hasPassword ? { currentPassword: stepUp } : { code: stepUp }) });
            setPw(''); setStepUp('');
            if (r.ok) say('Password saved.'); else say(r.error === 'STEP_UP_FAILED' ? (s.hasPassword ? 'Current password did not match.' : 'That code did not work. Ask for a fresh one.') : r.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : 'Could not save the password.', true);
            load();
          }}>Save password</button>
          {s.hasPassword && (
            <button className="btn q" disabled={!stepUp} onClick={async () => {
              if (!window.confirm('Remove the password? You will sign in with a one-time code only.')) return;
              const r = await api('/api/business/settings', { action: 'clear-password', currentPassword: stepUp });
              setStepUp('');
              if (r.ok) say('Password removed. Sign in with a one-time code from now on.'); else say(r.error === 'STEP_UP_FAILED' ? 'Current password did not match.' : 'Could not remove the password.', true);
              load();
            }}>Remove password</button>
          )}
        </div>
        <h2 style={{ marginTop: 22 }}>How you get paid</h2>
        <p className="note">Every paid link credits your WaPay balance instantly, and WaPay tells you on WhatsApp who paid and for what. Card costs are deducted from your side, never added to the customer.{s.freeBelowCents ? ` Links under ${R(s.freeBelowCents)} carry no card cost at all.` : ''} Move money to your bank from the <b>Payouts</b> tab: PayShap in minutes, a bank transfer, or cash at an ATM.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export default function BusinessPortal() {
  const [authed, setAuthed] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [biz, setBiz] = useState(null);
  const [tab, setTab] = useState('overview');
  const [openCustomer, setOpenCustomer] = useState(null);
  const [presetCustomer, setPresetCustomer] = useState(null);
  const [focusCode, setFocusCode] = useState(null);
  const probe = useCallback(() => {
    fetch('/api/business/auth').then((r) => r.json()).then((s) => { setAuthed(s.authed); setConfigured(s.configured); setBiz(s.business); }).catch(() => setAuthed(false));
  }, []);
  useEffect(() => { probe(); }, [probe]);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const onUnauth = () => { setAuthed(false); setBiz(null); setExpired(true); };
    window.addEventListener('wapay:unauth', onUnauth);
    const onRefresh = () => probe();
    window.addEventListener('wapay:refresh', onRefresh);
    return () => { window.removeEventListener('wapay:unauth', onUnauth); window.removeEventListener('wapay:refresh', onRefresh); };
  }, [probe]);
  const linkAction = useCallback(async (a, l) => {
    if (a === 'cancel') await api('/api/business/links', { action: 'cancel', code: l.code });
    if (a === 'sent') await api('/api/business/links', { action: 'sent', code: l.code, channel: l.channel || 'COPY' });
  }, []);
  const go = (t) => { setTab(t); if (t !== 'customers') setOpenCustomer(null); if (t !== 'links') { setPresetCustomer(null); setFocusCode(null); } };
  return (
    <div className="wrap">
      <Head>
        <title>{biz?.name ? `${biz.name} · WaPay for Business` : 'WaPay for Business'}</title>
        <meta name="robots" content="noindex,nofollow" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="48x48" href="/brand/favicon-48.png" />
        <link rel="icon" type="image/png" sizes="128x128" href="/brand/wapay-favicon-128.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/brand/apple-touch-icon.png" />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bg" />
      <header>
        <span className="brand">
          <img className="logo" src="/brand/wapay-lockup-120.png" srcSet="/brand/wapay-lockup-120.png 1x, /brand/wapay-lockup-240.png 2x" alt="WaPay" width={121} height={30} />
          <span className="tag">for Business</span>
          {biz?.logo && <img className="bizlogo" src={biz.logo} alt="" width={28} height={28} />}
          {biz?.name && <span className="bizname" title={biz.name}>{biz.name}</span>}
        </span>
        <div className="spacer" />
        {authed && (
          <>
            <div className="tabs">
              {[['overview', 'Overview'], ['customers', 'Customers'], ['links', 'Payment links'], ['payouts', 'Payouts'], ['settings', 'Settings']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>{l}</button>)}
            </div>
            <button className="linkish" onClick={async () => { await api('/api/business/auth', { action: 'logout' }); setAuthed(false); setBiz(null); }}>Sign out</button>
          </>
        )}
      </header>
      {authed === null && <div className="card"><div className="empty">…</div></div>}
      {authed === false && expired && <div className="card" style={{ maxWidth: 400, margin: '0 auto 12px' }}><div className="note" style={{ margin: 0 }}>Your session ended (they last 24 hours). Sign in again to continue.</div></div>}
      {authed === false && <Login configured={configured} onDone={() => { setExpired(false); probe(); }} />}
      {authed === true && tab === 'overview' && <Overview onOpenCustomer={(id, code) => { if (id) { setOpenCustomer(id); setTab('customers'); } else { setFocusCode(code); setTab('links'); } }} onNewLink={() => { setPresetCustomer(null); setTab('links'); }} />}
      {authed === true && tab === 'customers' && <Customers openId={openCustomer} onOpen={setOpenCustomer} onNewLink={(c) => { setPresetCustomer(c); setTab('links'); }} onLinkAction={linkAction} />}
      {authed === true && tab === 'links' && <Links presetCustomer={presetCustomer} onLinkAction={linkAction} focusCode={focusCode} />}
      {authed === true && tab === 'payouts' && <Payouts />}
      {authed === true && tab === 'settings' && <Settings />}
    </div>
  );
}
