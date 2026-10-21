/**
 * The personal portal's browser kit (2026-10-21): the API helper (session,
 * CSRF header, redirect to log in), money formatting, the line icons, the PIN
 * field and the small building blocks every screen uses. The look follows
 * docs/briefs/personal-portal/prototype.html: brand green #359853, Inter,
 * white 16 px cards on #F4F6F8, one column centred at 420 px.
 *
 * Holds no secrets: the session cookie is HttpOnly and scoped to /api/app;
 * the CSRF token is kept in memory only. A PIN typed here is sent once, in a
 * POST body, to /api/app/auth or /api/app/pin, and never stored.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

let csrfToken = null;
let sessionCache = null;

export async function loadSession(force = false) {
  if (sessionCache && !force) return sessionCache;
  try {
    const r = await fetch('/api/app/auth', { credentials: 'same-origin', cache: 'no-store' });
    const j = await r.json();
    csrfToken = j.csrf || null;
    sessionCache = j;
    return j;
  } catch {
    return { configured: true, authed: false, offline: true };
  }
}

export function forgetSession() {
  sessionCache = null;
  csrfToken = null;
}

function toLogin() {
  if (typeof window === 'undefined') return;
  const here = window.location.pathname + window.location.search;
  forgetSession();
  window.location.replace(`/app/login?next=${encodeURIComponent(here)}`);
}

/** fetch for /api/app: JSON in and out, the CSRF header on writes, one quiet retry on a stale token. */
export async function api(path, { method = 'GET', body, retry = true } = {}) {
  if (method !== 'GET' && !csrfToken) await loadSession(true);
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-wapay-csrf': csrfToken || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: { error: 'OFFLINE', line: 'No connection. Check your data or Wi-Fi and try again.' } };
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (data && data.csrf) csrfToken = data.csrf;
  if (res.status === 401 && data.error === 'UNAUTHORIZED') { toLogin(); return { ok: false, status: 401, data }; }
  if (res.status === 403 && (data.error === 'CSRF') && retry && method !== 'GET') {
    await loadSession(true);
    return api(path, { method, body, retry: false });
  }
  return { ok: res.ok && data.ok !== false, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

export function R(cents) {
  const c = Math.round(Number(cents) || 0);
  const sign = c < 0 ? '−' : '';
  const abs = Math.abs(c);
  return `${sign}R${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
}
export function Rs(cents) {
  const c = Math.round(Number(cents) || 0);
  return c % 100 === 0 ? R(c).replace(/\.00$/, '') : R(c);
}

/** "250", "R250", "1 500", "1,500.50", "120,50" → integer cents, else null. */
export function parseRands(v) {
  const s = String(v ?? '').trim().replace(/^r/i, '').replace(/\s/g, '');
  if (!s) return null;
  const m = s.match(/^(\d[\d.,]*?)(?:([.,])(\d{1,2}))?$/);
  if (!m) return null;
  const [, intPart, , frac] = m;
  if (/[.,]/.test(intPart) && !/^\d{1,3}([.,]\d{3})+$/.test(intPart)) return null;
  const whole = Number(intPart.replace(/[.,]/g, ''));
  if (!Number.isInteger(whole)) return null;
  return whole * 100 + (frac ? Number(frac.padEnd(2, '0')) : 0);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** South African time, as the chat writes it. */
function sast(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 2 * 3600 * 1000);
}
export function shortDate(iso) {
  const x = sast(iso);
  return x ? `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}` : '';
}
export function dayDate(iso) {
  const x = sast(iso);
  return x ? `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}` : '';
}
export function dateTime(iso) {
  const x = sast(iso);
  return x ? `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}` : '';
}
export function longDate(iso) {
  const x = sast(iso);
  return x ? `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}` : '';
}

// ---------------------------------------------------------------------------
// Icons (simple line icons, currentColor)
// ---------------------------------------------------------------------------

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  pay: 'M7 4v13m0 0-3-3m3 3 3-3M17 20V7m0 0-3 3m3-3 3 3',
  activity: 'M4 6h16M4 12h16M4 18h10',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0',
  in: 'M12 4v12m0 0-5-5m5 5 5-5M5 20h14',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h13m0 0-5-5m5 5-5 5',
  bank: 'M3 10h18L12 4zM5 10v7m4.7-7v7m4.6-7v7M19 10v7M3 20h18',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  refund: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  cart: 'M3 4h2l2.4 11h10.2L20 7H6.3M9 20h.01M17 20h.01',
  ticket: 'M4 8a2 2 0 0 0 0 4v4h16v-4a2 2 0 0 0 0-4V4H4zm6-4v16',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zm9 0v13M12 7S10 3 8 4s0 3 4 3m0 0s2-4 4-3 0 3-4 3',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm3 15h2',
  signal: 'M5 18v-3m5 3v-7m5 7V8m5 10V4',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  fuel: 'M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h14M15 10h2a2 2 0 0 1 2 2v4a1 1 0 0 0 2 0V9l-3-3M8 7h4',
  store: 'M4 9 5 4h14l1 5M4 9v11h16V9M4 9h16M9 20v-6h6v6',
  dot: 'M12 12h.01',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  share: 'M12 4v11M8 8l4-4 4 4M5 13v6h14v-6',
  check: 'M5 12.5 10 17 19 7',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm-2.5-11.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14m0 3h.01',
  out: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  close: 'M6 6l12 12M18 6 6 18',
  fee: 'M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21zM10 8h4M10 12h4',
};

export function Icon({ name, size = 20, stroke = 1.8 }) {
  const d = PATHS[name] || PATHS.dot;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export function Logo({ size = 28, text = true }) {
  return (
    <span className="logo">
      {/* The Lovable W-mark: the brand of record (never a bubble). */}
      <img src="/brand/wapay-mark-256.png" width={size} height={size} alt="" />
      {text && <span>WaPay</span>}
    </span>
  );
}

export function Banner({ banner }) {
  if (!banner || !banner.show) return null;
  return <div className="banner" role="status">{banner.text}</div>;
}

export function Notice({ tone = 'info', children }) {
  if (!children) return null;
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Kv({ k, v, strong = false }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span className={strong ? 'strong' : ''}>{v}</span>
    </div>
  );
}

export function Row({ icon, title, sub, right, tone, href, onClick, muted }) {
  const inner = (
    <>
      <span className="ic"><Icon name={icon} /></span>
      <span className="m"><b>{title}</b>{sub ? <span>{sub}</span> : null}</span>
      {right != null ? <span className={`amt ${tone || ''} ${muted ? 'muted' : ''}`}>{right}</span> : null}
    </>
  );
  if (href) return <Link href={href} className="row link-row">{inner}</Link>;
  if (onClick) return <button type="button" className="row link-row" onClick={onClick}>{inner}</button>;
  return <div className="row">{inner}</div>;
}

/** One movement in the activity list: green for in, ink for out, the fee as its own line. */
export function ActivityRow({ item, long = false }) {
  const amount = item.amountCents || 0;
  const when = long ? dateTime(item.at) : dayDate(item.at);
  const sub = [when, item.sub].filter(Boolean).join(' · ');
  return (
    <>
      <Row
        icon={item.icon}
        title={item.title}
        sub={sub}
        right={`${amount > 0 ? '+' : ''}${R(amount)}`}
        tone={amount > 0 && !item.muted ? 'in' : 'out'}
        muted={item.muted || item.pending}
      />
      {item.feeCents > 0 ? <Row icon="fee" title="Fee · pay-out" sub={when} right={R(-item.feeCents)} tone="out" muted={item.pending} /> : null}
    </>
  );
}

/** The PIN, typed into one real input behind four to six boxes (a numeric keypad on phones). */
export function PinField({ value, onChange, label = 'WaPay PIN', autoComplete = 'off', autoFocus = false, id = 'pin' }) {
  const boxes = Math.min(6, Math.max(4, value.length + (value.length >= 4 && value.length < 6 ? 1 : 0)));
  return (
    <div className="field">
      <label className="lbl" htmlFor={id}>{label}</label>
      <div className="pinbox">
        <div className="pin" aria-hidden="true">
          {Array.from({ length: boxes }).map((_, i) => <i key={i} className={i < value.length ? 'f' : i === value.length ? 'c' : ''}>{i < value.length ? '•' : ''}</i>)}
        </div>
        <input
          id={id}
          className="pinin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={autoComplete}
          maxLength={6}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      </div>
    </div>
  );
}

/** A big amount, typed in rands; the screen keeps cents. */
export function AmountField({ value, onChange, label = 'Amount', autoFocus = false, id = 'amount' }) {
  return (
    <div className="field">
      <label className="lbl" htmlFor={id}>{label}</label>
      <div className="bigwrap">
        <span className="cur">R</span>
        <input id={id} className="big" inputMode="decimal" autoComplete="off" placeholder="0" value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value.replace(/[^\d.,\s]/g, '').slice(0, 12))} />
      </div>
    </div>
  );
}

export function Chips({ items, value, onPick }) {
  return (
    <div className="chips">
      {items.map((c) => (
        <button type="button" key={c.key} className={`chip ${value === c.key ? 'on' : ''}`} onClick={() => onPick(c)}>{c.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, id, hint, error, ...props }) {
  return (
    <div className="field">
      <label className="lbl" htmlFor={id}>{label}</label>
      <input id={id} className={`input ${error ? 'bad' : ''}`} {...props} />
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Pill({ tone = '', children }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Loading' }) {
  return <div className="spin" role="status" aria-label={label}><i /></div>;
}

/** Copy to the clipboard, with a fallback for browsers that refuse it. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** The Web Share sheet when there is one; otherwise copy. Returns 'shared' | 'copied' | 'failed'. */
export async function shareOrCopy({ title, text, url }) {
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title, text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(text || url)) ? 'copied' : 'failed';
}

/** Run a callback every `ms` while mounted (used to watch a top-up land). */
export function useInterval(fn, ms, on = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, on]);
}

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    if (busy) return undefined;
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  };
  return [busy, run];
}

/** The step-up refusal, in plain words. */
export function pinError(r) {
  const e = r.data?.error;
  if (e === 'WRONG_PIN') return 'That PIN is not right. Try again, or reset it from the log in screen.';
  if (e === 'PIN_LOCKED') return 'Your PIN is locked for 15 minutes after 5 wrong tries. You can reset it with your ID number from the log in screen.';
  if (e === 'PIN_RESET_NEEDED') return 'Your PIN is locked after too many wrong tries. Log out and reset it with your ID number.';
  if (e === 'LOCKED') return 'Too many wrong PINs. For your safety, wait 15 minutes and try again.';
  if (e === 'NO_PROOF_SECRET') return 'Payments cannot be confirmed right now. Nothing has moved. Please try again later.';
  if (e === 'EXPIRED') return 'That confirmation timed out. Nothing has moved. Please start again.';
  return 'Your PIN could not be checked just now. Nothing has moved. Please try again.';
}

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root{--green:#359853;--green-dark:#2b7a43;--green-soft:#ECFDF3;--ink:#111827;--grey:#6B7280;--line:#E5E7EB;--page:#F4F6F8;--card:#fff;--amber:#B45309;--amber-bg:#FFF7ED;--amber-line:#FED7AA;--red:#B91C1C;--red-bg:#FEF2F2;--red-line:#FECACA;--blue-bg:#EFF6FF;--blue:#1D4ED8;--radius:16px;--nav:64px}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#E9ECEF;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
button,input,select{font-family:inherit}
a{color:var(--green-dark)}
.frame{max-width:420px;margin:0 auto;min-height:100vh;background:var(--page);padding:18px 16px calc(var(--nav) + 32px + env(safe-area-inset-bottom));overflow-x:hidden}
.frame.nonav{padding-bottom:28px}
@media (min-width:460px){.frame{box-shadow:0 0 0 1px rgba(17,24,39,.04),0 12px 40px rgba(17,24,39,.08)}}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px}
.logo{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:18px;color:var(--ink);text-decoration:none}
.logo img{display:block;border-radius:8px;background:#fff}
.avatar{width:36px;height:36px;border-radius:50%;background:#D1FAE5;color:var(--green-dark);display:grid;place-items:center;font-weight:700;font-size:13px;text-decoration:none;flex:none}
.avatar.lg{width:64px;height:64px;font-size:22px;margin:6px auto 8px}
.back{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--grey);font-weight:600;font-size:14px;padding:6px 0;cursor:pointer;text-decoration:none}
.h1{font-size:22px;font-weight:700;margin:4px 0 4px;letter-spacing:-.2px}
.p{font-size:14px;color:var(--grey);margin:0 0 14px;line-height:1.5}
.card{background:var(--card);border-radius:var(--radius);padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.04);margin-bottom:12px}
.card.tight{padding:4px 16px}
.balance .t{font-size:13px;color:var(--grey);margin:0 0 4px}
.balance .amt{font-size:34px;font-weight:700;letter-spacing:-.5px;margin:0;font-variant-numeric:tabular-nums}
.balance .sub{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--grey);margin-top:8px;align-items:center}
.actions{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}
.act{background:var(--card);border-radius:14px;padding:12px 4px 10px;text-align:center;font-size:12px;font-weight:600;border:0;cursor:pointer;color:var(--ink);text-decoration:none;display:block;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.act .ic{width:38px;height:38px;border-radius:12px;background:var(--green-soft);color:var(--green);display:grid;place-items:center;margin:0 auto 6px}
.banner{background:var(--amber-bg);border:1px solid var(--amber-line);color:var(--amber);border-radius:12px;padding:10px 12px;font-size:13px;line-height:1.45;margin-bottom:12px}
.notice{border-radius:12px;padding:10px 12px;font-size:13.5px;line-height:1.45;margin:0 0 12px}
.notice.info{background:var(--blue-bg);color:var(--blue)}
.notice.error{background:var(--red-bg);border:1px solid var(--red-line);color:var(--red)}
.notice.warn{background:var(--amber-bg);border:1px solid var(--amber-line);color:var(--amber)}
.notice.ok{background:var(--green-soft);color:var(--green-dark)}
h3{font-size:12.5px;margin:18px 2px 8px;color:var(--grey);font-weight:600;text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between;align-items:center}
h3 a{text-transform:none;letter-spacing:0;font-size:13px;text-decoration:none}
.row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);width:100%;text-align:left;background:transparent;border-left:0;border-right:0;border-top:0;color:inherit;font:inherit;text-decoration:none}
.row:last-child{border-bottom:0}
.link-row{cursor:pointer}
.row .ic{width:38px;height:38px;border-radius:12px;background:#F3F4F6;display:grid;place-items:center;flex:none;color:#374151}
.row .m{flex:1;min-width:0}
.row .m b{display:block;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .m span{display:block;font-size:12px;color:var(--grey);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .amt{font-weight:700;font-size:14px;white-space:nowrap;font-variant-numeric:tabular-nums}
.row .amt.in{color:var(--green)}
.row .amt.out{color:var(--ink)}
.row .amt.muted{color:var(--grey)}
.row .amt.muted.out{text-decoration:none}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;border-radius:14px;border:0;background:var(--green);color:#fff;font-weight:700;font-size:15.5px;cursor:pointer;text-decoration:none;min-height:50px}
.btn:disabled{opacity:.55;cursor:default}
.btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
.btn.danger{background:#fff;color:var(--red);border:1px solid var(--red-line)}
.btn.sm{width:auto;min-height:0;padding:8px 12px;font-size:13px;border-radius:10px}
.btn + .btn{margin-top:10px}
.sticky{position:sticky;bottom:calc(var(--nav) + 12px + env(safe-area-inset-bottom));margin-top:16px;z-index:2}
.frame.nonav .sticky{bottom:12px}
.field{display:block;margin:0 0 12px}
.lbl{display:block;font-size:12.5px;color:var(--grey);font-weight:600;margin:0 0 6px}
.input{width:100%;padding:13px 14px;border-radius:12px;border:1px solid var(--line);font-size:16px;background:#fff;color:var(--ink);outline:none}
.input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(53,152,83,.15)}
.input.bad{border-color:var(--red)}
select.input{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#6B7280 50%),linear-gradient(135deg,#6B7280 50%,transparent 50%);background-position:calc(100% - 18px) 55%,calc(100% - 13px) 55%;background-size:5px 5px;background-repeat:no-repeat}
.hint{display:block;font-size:12px;color:var(--grey);margin-top:6px}
.err{display:block;font-size:12.5px;color:var(--red);margin-top:6px}
.bigwrap{display:flex;align-items:baseline;justify-content:center;gap:4px;padding:6px 0 2px;border-bottom:2px solid var(--line)}
.bigwrap:focus-within{border-color:var(--green)}
.bigwrap .cur{font-size:30px;font-weight:700;color:var(--grey)}
.big{font-size:40px;font-weight:700;text-align:left;border:0;background:transparent;width:7.5ch;max-width:75%;outline:none;color:var(--ink);font-variant-numeric:tabular-nums;padding:0}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.chip{padding:8px 12px;border-radius:999px;border:1px solid var(--line);background:#fff;font-size:13px;font-weight:600;cursor:pointer;color:var(--ink)}
.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.pill{display:inline-block;background:var(--green-soft);color:var(--green-dark);font-size:11px;font-weight:700;padding:4px 8px;border-radius:999px;white-space:nowrap;text-decoration:none}
.pill.grey{background:#F3F4F6;color:var(--grey)}
.pill.amber{background:var(--amber-bg);color:var(--amber)}
.pill.red{background:var(--red-bg);color:var(--red)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.tile{background:#fff;border-radius:14px;padding:12px 6px;text-align:center;font-size:12px;font-weight:600;color:var(--grey)}
.tile.soon{opacity:.75}
.tile.live{color:var(--ink)}
.tile .ic{display:grid;place-items:center;margin:0 auto 4px;color:var(--grey)}
.tile.live .ic{color:var(--green)}
.tile small{display:block;font-size:10.5px;font-weight:600;color:var(--amber);margin-top:2px}
.tile.live small{color:var(--green-dark)}
.nav{position:fixed;left:50%;transform:translateX(-50%);bottom:0;width:100%;max-width:420px;background:#fff;border-top:1px solid var(--line);display:flex;padding:8px 6px calc(10px + env(safe-area-inset-bottom));z-index:5}
.nav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;font-weight:600;color:var(--grey);text-decoration:none;padding:2px 0}
.nav a.on{color:var(--green)}
.kv{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv:last-child{border-bottom:0}
.kv span:first-child{color:var(--grey)}
.kv span:last-child{text-align:right;font-weight:600;word-break:break-word}
.kv .strong{font-size:16px}
.pinbox{position:relative;margin:4px 0 6px}
.pin{display:flex;gap:10px;justify-content:center}
.pin i{width:50px;height:58px;border-radius:12px;border:1px solid var(--line);background:#fff;display:grid;place-items:center;font-size:24px;font-weight:700;font-style:normal}
.pin i.f{border-color:#9CA3AF}
.pinbox:focus-within .pin i.c{border-color:var(--green);box-shadow:0 0 0 3px rgba(53,152,83,.15)}
.pinin{position:absolute;inset:0;width:100%;height:100%;opacity:0;font-size:16px;border:0;cursor:pointer}
.linkbox{display:flex;align-items:center;gap:8px;background:#F3F4F6;border-radius:12px;padding:12px;font-size:13.5px;word-break:break-all;margin:12px 0}
.note{font-size:12.5px;color:var(--grey);text-align:center;margin:12px 4px 0;line-height:1.5}
.center{text-align:center}
.mt{margin-top:12px}
.spin{display:grid;place-items:center;padding:40px 0}
.spin i{width:28px;height:28px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--green);animation:sp 0.8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.opt{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--line);border-radius:14px;background:#fff;margin:0 0 8px;cursor:pointer;width:100%;text-align:left;font:inherit;color:inherit}
.opt.on{border-color:var(--green);box-shadow:0 0 0 3px rgba(53,152,83,.12)}
.opt .m{flex:1;min-width:0}
.opt .m b{display:block;font-size:14px}
.opt .m span{display:block;font-size:12px;color:var(--grey);margin-top:2px}
.check{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.4;margin:6px 0 12px;cursor:pointer}
.check input{width:20px;height:20px;margin:0;accent-color:var(--green);flex:none}
.steps{margin:8px 0 0;padding-left:20px;font-size:13.5px;line-height:1.55}
.done-ic{width:64px;height:64px;border-radius:50%;background:var(--green-soft);color:var(--green);display:grid;place-items:center;margin:28px auto 10px}
.done-ic.wait{background:var(--amber-bg);color:var(--amber)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dev{background:#EEF2FF;color:#3730A3;border-radius:12px;padding:8px 12px;font-size:12.5px;margin-bottom:12px}
.split{display:flex;gap:8px}
.split .btn{flex:1}
.split .btn + .btn{margin-top:0}
.small{font-size:12.5px;color:var(--grey)}
`;
