/**
 * Mission Control's Links tab (founder 2026-10-25): where payment links are made, shared, opened and paid
 * from. The map is Leaflet (bundled, pinned 1.9.4) over OpenStreetMap's standard tiles (no key; light use as the
 * tile policy asks, with its attribution); the data is
 * GET /api/admin/link-map (lib/link-map.js). Areas come from the internet connection, never GPS.
 */
import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';

const R = (c) => 'R' + (Math.round(c || 0) / 100).toLocaleString('en-ZA', { maximumFractionDigits: 2 });
const COLOURS = { opened: '#359853', paid: '#1f6feb', shared: '#d97706', requester: '#7c3aed' };
const LABELS = { opened: 'Opened here', paid: 'Paid from here', shared: 'Shared from here (link preview)', requester: "Requester's area" };
const when = (d) => new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function LinkMap({ points, show }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !el.current) return;
      if (!map.current) {
        map.current = L.map(el.current, { scrollWheelZoom: false }).setView([-29.0, 25.0], 5);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 12,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map.current);
      }
      if (layer.current) layer.current.remove();
      layer.current = L.layerGroup().addTo(map.current);
      for (const p of points || []) {
        if (!show[p.group]) continue;
        const radius = Math.min(26, 5 + Math.sqrt(p.count) * 3);
        const place = [p.city, p.province, p.country && p.country !== 'ZA' ? p.country : null].filter(Boolean).join(', ') || 'Unknown place';
        L.circleMarker([p.lat, p.lng], { radius, color: COLOURS[p.group], fillColor: COLOURS[p.group], fillOpacity: 0.35, weight: 1.5 })
          .bindPopup(`<b>${place.replace(/[<>&]/g, '')}</b><br/>${LABELS[p.group]}: ${p.count}`)
          .addTo(layer.current);
      }
    })();
    return () => { cancelled = true; };
  }, [points, show]);
  useEffect(() => () => { if (map.current) { map.current.remove(); map.current = null; } }, []);
  return <div ref={el} style={{ height: 460, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--grid)' }} />;
}

function Timeline() {
  const [code, setCode] = useState('');
  const [out, setOut] = useState(null);
  const look = async (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return;
    const r = await fetch(`/api/admin/link-map?code=${encodeURIComponent(c)}`);
    setOut(await r.json().catch(() => ({ ok: false, error: String(r.status) })));
  };
  return (
    <>
      <form className="searchrow" onSubmit={look}>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A link code, like PRABCDEF" maxLength={8} />
        <button type="submit">Show its journey</button>
      </form>
      {out && !out.ok ? <p className="err">{out.error === 'NOT_FOUND' ? 'No link with that code.' : 'That is not a link code.'}</p> : null}
      {out?.ok ? (
        <div style={{ marginTop: 10 }}>
          <p className="note" style={{ marginTop: 0 }}>{out.link.code} · {R(out.link.amountCents)}{out.link.note ? ` for ${out.link.note}` : ''} · {out.link.status.toLowerCase()} · made {when(out.link.createdAt)}{out.link.paidAt ? ` · paid ${when(out.link.paidAt)}` : ''}</p>
          {!out.events.length ? <p className="empty">Nothing recorded for this link yet.</p> : (
            <table>
              <thead><tr><th>When</th><th>What</th><th>Where</th><th>Device</th><th>Door</th></tr></thead>
              <tbody>
                {out.events.map((ev, i) => (
                  <tr key={i}>
                    <td>{when(ev.at)}</td>
                    <td>{{ OPEN: 'opened', PREVIEW: 'link preview (shared)', CHECKOUT: 'pressed pay', CREATED: 'made', SEEN: 'requester seen' }[ev.kind] || ev.kind}</td>
                    <td>{ev.area || 'unknown'}</td>
                    <td>{[ev.device, ev.os, ev.browser || ev.app].filter(Boolean).join(' · ') || '–'}</td>
                    <td>{ev.door || 'first message'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  );
}

export default function LinkMapTab() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [show, setShow] = useState({ opened: true, paid: true, shared: true, requester: true });
  useEffect(() => {
    setD(null); setErr('');
    fetch(`/api/admin/link-map?days=${days}`).then((r) => r.json()).then((j) => (j.ok ? setD(j) : setErr(j.error || 'failed'))).catch(() => setErr('failed'));
  }, [days]);
  if (err) return <div className="card"><p className="err">{err === 'NO_TABLE_YET' ? 'The tracking table is not in the database yet.' : `The link map could not be read (${err}).`}</p></div>;
  if (!d) return <div className="card"><p className="empty">Loading the link map…</p></div>;
  const t = d.totals;
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {[7, 30, 90].map((n) => <button key={n} className={`pill ${days === n ? 'g' : ''}`} style={{ cursor: 'pointer', border: 0 }} onClick={() => setDays(n)}>Last {n} days</button>)}
        <a className="linkish" href={`/api/admin/link-map?days=${days}&format=csv`}>⬇ Export CSV</a>
      </div>
      <div className="grid kpis">
        <div className="card"><div className="k">Links made</div><div className="v">{t.made}</div><div className="vs">{t.madeOnWeb} on the web app · {t.madeForBusiness} business</div></div>
        <div className="card"><div className="k">Links opened</div><div className="v">{t.opened}</div><div className="vs">{t.opens} opens, one per device a day</div></div>
        <div className="card"><div className="k">Shared on WhatsApp</div><div className="v">{t.shared}</div><div className="vs">link previews drawn on a phone</div></div>
        <div className="card"><div className="k">Pressed pay</div><div className="v">{t.checkouts}</div><div className="vs">{t.paid} links paid</div></div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Where links travel</h2>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '4px 0 10px' }}>
          {Object.keys(COLOURS).map((g) => (
            <label key={g} style={{ fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={show[g]} onChange={() => setShow((s) => ({ ...s, [g]: !s[g] }))} />{' '}
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 99, background: COLOURS[g], marginRight: 4 }} />{LABELS[g]}
            </label>
          ))}
        </div>
        <LinkMap points={d.points} show={show} />
        <p className="note">Areas come from the internet connection, never GPS. On Wi-Fi and fibre that is the town or city; on mobile data South African networks often show their hub city (Johannesburg, Cape Town, Durban), and a VPN shows the VPN. WhatsApp hides forwards, so a link is placed where it is opened; a link made in WhatsApp shows its requester's area only once they use the web app or paste the link into a chat. {t.unknownArea ? `${t.unknownArea} opens had no area.` : ''}</p>
      </div>
      {d.abroad?.length ? (
        <div className="card" style={{ marginTop: 14, borderColor: 'var(--crit)' }}>
          <h2>Opened or paid from outside South Africa</h2>
          <p className="note" style={{ marginTop: 0 }}>Often a VPN or a traveller, but stolen cards are usually used from abroad: check these links.</p>
          <p>{d.abroad.map((a) => `${a.country}: ${a.count}`).join(' · ')}</p>
        </div>
      ) : null}
      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Provinces</h2>
          {!d.provinces.length ? <p className="empty">No South African areas recorded yet.</p> : (
            <table>
              <thead><tr><th>Province</th><th className="n">Opened</th><th className="n">Pressed pay</th><th className="n">Shared</th><th className="n">Requesters</th></tr></thead>
              <tbody>{d.provinces.map((p) => <tr key={p.province}><td>{p.province}</td><td className="n">{p.opened}</td><td className="n">{p.paid}</td><td className="n">{p.shared}</td><td className="n">{p.requesters}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>Top towns and cities (opens)</h2>
          {!d.cities.length ? <p className="empty">No cities recorded yet.</p> : (
            <table>
              <thead><tr><th>Place</th><th>Province</th><th className="n">Opens</th></tr></thead>
              <tbody>{d.cities.map((c) => <tr key={`${c.city}-${c.province}`}><td>{c.city}</td><td>{c.province}</td><td className="n">{c.opens}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>How people arrived</h2>
          <table><thead><tr><th>Door</th><th className="n">Opens</th></tr></thead><tbody>{d.doors.map((x) => <tr key={x.door}><td>{x.door}</td><td className="n">{x.opens}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h2>Devices and apps</h2>
          <table><thead><tr><th>Device</th><th className="n">Opens</th></tr></thead><tbody>{d.devices.map((x) => <tr key={x.device}><td>{x.device}</td><td className="n">{x.opens}</td></tr>)}</tbody></table>
          {d.apps.length ? <p className="note">{d.apps.map((a) => `${a.app}: ${a.count}`).join(' · ')}</p> : null}
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Recent links</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 900 }}>
            <thead><tr><th>Link</th><th className="n">Amount</th><th>Status</th><th>Made</th><th>Made in</th><th>Shared from</th><th>Opened in</th><th>Paid from</th></tr></thead>
            <tbody>
              {d.recent.map((l) => (
                <tr key={l.code}>
                  <td>{l.code}</td>
                  <td className="n">{R(l.amountCents)}</td>
                  <td>{l.status.toLowerCase()}</td>
                  <td>{when(l.createdAt)} · {l.channel}</td>
                  <td title={l.madeInBasis || ''}>{l.madeIn || '–'}</td>
                  <td>{l.sharedFrom || '–'}</td>
                  <td>{l.openedIn.length ? l.openedIn.join('; ') : l.opens ? `${l.opens} opens` : '–'}</td>
                  <td>{l.paidFrom || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>One link's journey</h2>
        <Timeline />
      </div>
    </>
  );
}
