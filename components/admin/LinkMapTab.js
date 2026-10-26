/**
 * Mission Control's Links tab (founder 2026-10-25): where payment links are made, shared, opened and paid
 * from. The map is Leaflet (bundled, pinned 1.9.4) over OpenStreetMap's standard tiles (no key; light use as the
 * tile policy asks, with its attribution); the data is
 * GET /api/admin/link-map (lib/link-map.js). Areas come from the internet connection, never GPS.
 *
 * The pins (founder 2026-10-26): a WaPay mark wherever a link was made, shared, opened or paid from, coloured
 * by the link's status from the API's `statuses` (lib/link-map.js PIN_STATUSES): green paid, blue requested,
 * grey closed. They are HTML markers (L.divIcon), never SVG: the admin page's global `svg{width:100%}` squashed
 * Leaflet's vector pane to 0px wide, so the first map's circle markers never showed. Places that would overlap
 * at the current zoom share a spot, one pin per status side by side; clicking a shared spot zooms in.
 * Hover cards carry link codes, amounts and areas only, escaped.
 */
import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';

const R = (c) => 'R' + (Math.round(c || 0) / 100).toLocaleString('en-ZA', { maximumFractionDigits: 2 });
const when = (d) => new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const MARK = '/brand/wapay-mark-64-white.png';
const SA_BOUNDS = [[-34.9, 16.4], [-22.1, 32.9]];
const TIP_LINES = 5;
const GAP = 6;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const colourOf = (s) => (/^#[0-9a-f]{3,8}$/i.test(String(s?.colour || '')) ? s.colour : '#8a948d');
const sizeOf = (n) => (n >= 100 ? 34 : n >= 10 ? 30 : 26);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CSS = `
.lm-map.leaflet-container{font:400 12px/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
/* The admin page styles every svg width:100%, which squashes Leaflet's vector pane to 0px: undo it on this map. */
.lm-map .leaflet-pane svg{width:auto;height:auto}
.lm-icon{background:none;border:0}
.lm-pin{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;box-sizing:border-box;border-radius:50%;background:var(--c);border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.25),0 4px 10px -3px rgba(0,0,0,.45);transition:transform .12s}
.lm-icon:hover .lm-pin,.lm-icon:focus-visible .lm-pin{transform:scale(1.12)}
.lm-w{display:block;width:58%;height:58%;background:url(${MARK}) center/contain no-repeat}
.lm-n{position:absolute;top:-8px;right:-11px;min-width:19px;height:19px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:#fff;border:1.5px solid var(--c);color:#0b1411;font:700 10.5px/16px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.lm-map .leaflet-tooltip.lm-tip{padding:8px 11px;border:0;border-radius:10px;background:#fff;color:#0b1411;font:400 12px/1.5 Inter,system-ui,sans-serif;box-shadow:0 10px 28px -10px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.2)}
.lm-map .leaflet-tooltip.lm-nudged::before{display:none}
.lm-tip-h{display:flex;align-items:center;gap:6px;font-weight:700;font-size:12.5px}
.lm-tip-h span{font-weight:500;color:#5f6b64}
.lm-sw{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none}
.lm-tip-p{color:#3d4a43;margin:1px 0 6px}
.lm-tip-l{font-variant-numeric:tabular-nums}
.lm-tip-l b{font-weight:650}
.lm-tip-m{color:#7b877f;margin-top:4px}
.lm-bar{display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;margin:6px 0 10px}
.lm-legend{display:flex;gap:6px 16px;flex-wrap:wrap}
.lm-key{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;color:var(--ink)}
.lm-key input{margin:0}
.lm-key.off{opacity:.5}
.lm-key small{color:var(--ink3);font-size:11.5px}
.lm-mini{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;box-sizing:border-box;border-radius:50%;background:var(--c);border:1.5px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.3);flex:none}
.lm-mini .lm-w{width:62%;height:62%}
.lm-seg{display:inline-flex;gap:2px;padding:3px;border-radius:11px;background:var(--field);border:1px solid var(--field-edge)}
.lm-seg button{border:0;background:transparent;color:var(--ink2);font:600 12px Inter,system-ui,sans-serif;padding:6px 11px;border-radius:8px;cursor:pointer}
.lm-seg button.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
.lm-countries{display:flex;flex-wrap:wrap;gap:8px}
.lm-country{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:12px;border:1px solid var(--field-edge);background:var(--field);color:var(--ink);font:500 12.5px Inter,system-ui,sans-serif}
button.lm-country{cursor:pointer}
button.lm-country:hover{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.lm-flag{font-size:17px;line-height:1}
.lm-cc{font-weight:700;font-variant-numeric:tabular-nums}
.lm-cs{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:650;color:var(--ink2);font-variant-numeric:tabular-nums}
.lm-cs::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--c)}
`;

// A spot's row of pins, in pixels: one pin per status, sized by its links, GAP apart.
const rowWidth = (counts) => [...counts.values()].reduce((w, n) => w + sizeOf(n) + GAP, -GAP);

// Places whose rows would overlap at this zoom share a spot (the busiest place anchors it); each status keeps its own pin.
function spotsAt(map, pins, show) {
  const zoom = map.getZoom();
  const places = new Map();
  for (const p of pins) {
    if (!show[p.status]) continue;
    const key = `${p.lat}|${p.lng}`;
    const place = places.get(key) || { lat: p.lat, lng: p.lng, label: p.city || p.place, full: p.place, flag: p.flag, pins: [], total: 0 };
    place.pins.push(p);
    place.total += p.count;
    places.set(key, place);
  }
  const spots = [];
  for (const place of [...places.values()].sort((a, b) => b.total - a.total)) {
    const pt = map.project([place.lat, place.lng], zoom);
    const counts = new Map(place.pins.map((p) => [p.status, p.count]));
    const width = rowWidth(counts);
    // +10: the count badge hangs off a pin's top right corner.
    const spot = spots.find((s) => Math.abs(s.pt.x - pt.x) < (s.width + width) / 2 + 10 && Math.abs(s.pt.y - pt.y) < 40);
    if (!spot) { spots.push({ pt, lat: place.lat, lng: place.lng, places: [place], counts, width }); continue; }
    spot.places.push(place);
    for (const [status, n] of counts) spot.counts.set(status, (spot.counts.get(status) || 0) + n);
    spot.width = rowWidth(spot.counts);
  }
  return spots;
}

// One pin per status at a spot: the places with links of that status, its links counted once, the newest few described.
function spotPins(spot, statuses) {
  return statuses.filter((s) => spot.counts.has(s.status)).map((s) => {
    const places = spot.places.filter((place) => place.pins.some((p) => p.status === s.status));
    const codes = new Set();
    const lines = new Map();
    for (const place of places) {
      for (const p of place.pins) {
        if (p.status !== s.status) continue;
        for (const c of p.codes) codes.add(c);
        for (const l of p.links) {
          const line = lines.get(l.code) || { code: l.code, amountCents: l.amountCents, at: '', did: [] };
          line.did.push(places.length > 1 ? `${l.did.join(', ')} (${place.label})` : l.did.join(', '));
          if ((l.at || '') > line.at) line.at = l.at;
          lines.set(l.code, line);
        }
      }
    }
    const shown = [...lines.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, TIP_LINES);
    return { s, places, count: codes.size, size: sizeOf(codes.size), shown, more: codes.size - shown.length };
  });
}

const pinHtml = (r) => `<span class="lm-pin" style="--c:${colourOf(r.s)}"><span class="lm-w"></span>${r.count > 1 ? `<span class="lm-n">${r.count > 999 ? '999+' : r.count}</span>` : ''}</span>`;

function tipHtml(r) {
  const one = r.places.length === 1 ? r.places[0] : null;
  const names = r.places.map((p) => p.label);
  const list = names.length > 3 ? [...names.slice(0, 3), plural(names.length - 3, 'more place')] : names;
  const where = one ? `${one.flag ? `${one.flag} ` : ''}${one.full}` : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `<div class="lm-tip-h"><span class="lm-sw" style="background:${colourOf(r.s)}"></span>${esc(r.s.label)} <span>· ${esc(plural(r.count, 'link'))}</span></div>`
    + `<div class="lm-tip-p">${esc(where)}</div>`
    + r.shown.map((l) => `<div class="lm-tip-l"><b>${esc(l.code)}</b> ${esc(R(l.amountCents))} · ${esc(l.did.join('; '))}</div>`).join('')
    + (r.more > 0 ? `<div class="lm-tip-m">and ${esc(r.more)} more</div>` : '')
    + (one ? '' : '<div class="lm-tip-m">Click to zoom in and split them up</div>');
}

function LinkMap({ pins, statuses, show, focus }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const lib = useRef(null);
  const latest = useRef({});
  latest.current = { pins: pins || [], statuses: statuses || [], show };
  const [ready, setReady] = useState(false);

  const draw = () => {
    const m = map.current; const L = lib.current; const g = layer.current;
    if (!m || !L || !g) return;
    g.clearLayers();
    for (const spot of spotsAt(m, latest.current.pins, latest.current.show)) {
      const row = spotPins(spot, latest.current.statuses);
      let x = -(row.reduce((w, r) => w + r.size, 0) + GAP * (row.length - 1)) / 2;
      for (const r of row) {
        const dx = x + r.size / 2;
        x += r.size + GAP;
        const icon = L.divIcon({ className: 'lm-icon', html: pinHtml(r), iconSize: [r.size, r.size], iconAnchor: [r.size / 2 - dx, r.size / 2], tooltipAnchor: [dx, 0] });
        const marker = L.marker([spot.lat, spot.lng], { icon, riseOnHover: true, keyboard: true });
        // The card opens on the side of the pin with room (registered before bindTooltip, so it runs first).
        marker.on('mouseover click', () => {
          const below = m.latLngToContainerPoint(marker.getLatLng()).y < m.getSize().y / 2;
          Object.assign(marker.getTooltip().options, { direction: below ? 'bottom' : 'top', offset: [0, below ? r.size / 2 : -r.size / 2] });
        });
        marker.bindTooltip(tipHtml(r), { direction: 'top', offset: [0, -r.size / 2], className: 'lm-tip', opacity: 1 });
        marker.on('tooltipopen', (e) => {
          const tip = e.tooltip.getElement();
          const box = m.getContainer().getBoundingClientRect();
          const at = tip.getBoundingClientRect();
          const nudge = at.left < box.left + 6 ? box.left + 6 - at.left : at.right > box.right - 6 ? box.right - 6 - at.right : 0;
          tip.classList.toggle('lm-nudged', !!nudge);
          if (nudge) L.DomUtil.setPosition(tip, L.DomUtil.getPosition(tip).add([nudge, 0]));
        });
        if (spot.places.length > 1) marker.on('click', () => m.flyToBounds(L.latLngBounds(spot.places.map((p) => [p.lat, p.lng])), { padding: [70, 70], maxZoom: Math.min(m.getMaxZoom(), m.getZoom() + 4), duration: 0.6 }));
        g.addLayer(marker);
      }
    }
  };

  const fly = (f) => {
    const m = map.current; const L = lib.current;
    if (!m || !L) return;
    if (f.view === 'za') { m.flyToBounds(SA_BOUNDS, { duration: 0.8 }); return; }
    const all = latest.current.pins;
    const pts = (f.view === 'country' ? all.filter((p) => p.country === f.country) : all.filter((p) => latest.current.show[p.status])).map((p) => [p.lat, p.lng]);
    if (!pts.length) { if (f.view === 'world') m.flyTo([12, 20], 2, { duration: 0.8 }); return; }
    m.flyToBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: f.view === 'country' ? 6 : 5, duration: 0.8 });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !el.current || map.current) return;
      const m = L.map(el.current, { scrollWheelZoom: false, minZoom: 2, maxZoom: 12, worldCopyJump: true });
      m.fitBounds(SA_BOUNDS);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 12,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(m);
      lib.current = L;
      map.current = m;
      layer.current = L.layerGroup().addTo(m);
      m.on('zoomend', draw);
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => () => { if (map.current) { map.current.remove(); map.current = null; } }, []);
  useEffect(() => { if (ready) draw(); }, [ready, pins, statuses, show]);
  useEffect(() => { if (ready && focus.n) fly(focus); }, [ready, focus]);
  return <div ref={el} className="lm-map" style={{ height: 460, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--grid)' }} />;
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
  const [show, setShow] = useState({ paid: true, requested: true, closed: true });
  const [focus, setFocus] = useState({ view: 'za', n: 0 });
  const mapBox = useRef(null);
  const view = (next) => setFocus((f) => ({ ...next, n: f.n + 1 }));
  const goCountry = (country) => {
    view({ view: 'country', country });
    if (mapBox.current?.scrollIntoView) mapBox.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  useEffect(() => {
    setD(null); setErr('');
    fetch(`/api/admin/link-map?days=${days}`).then((r) => r.json()).then((j) => (j.ok ? setD(j) : setErr(j.error || 'failed'))).catch(() => setErr('failed'));
  }, [days]);
  if (err) return <div className="card"><p className="err">{err === 'NO_TABLE_YET' ? 'The tracking table is not in the database yet.' : `The link map could not be read (${err}).`}</p></div>;
  if (!d) return <div className="card"><p className="empty">Loading the link map…</p></div>;
  const t = d.totals;
  const statuses = d.statuses || [];
  const pinned = new Set((d.pins || []).map((p) => p.country));
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
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
        <div className="lm-bar">
          <div className="lm-legend">
            {statuses.map((s) => (
              <label key={s.status} className={`lm-key${show[s.status] ? '' : ' off'}`} title={`${s.label}: ${s.meaning}`}>
                <input type="checkbox" checked={!!show[s.status]} onChange={() => setShow((v) => ({ ...v, [s.status]: !v[s.status] }))} />
                <span className="lm-mini" style={{ '--c': colourOf(s) }} aria-hidden="true"><span className="lm-w" /></span>
                <span><b>{s.label}</b> <small>{s.meaning} · {plural(s.links, 'link')}</small></span>
              </label>
            ))}
          </div>
          <div className="lm-seg" role="group" aria-label="Map view">
            <button type="button" className={focus.view === 'za' ? 'on' : ''} onClick={() => view({ view: 'za' })}>South Africa</button>
            <button type="button" className={focus.view === 'world' ? 'on' : ''} onClick={() => view({ view: 'world' })}>Whole world</button>
          </div>
        </div>
        <div ref={mapBox}><LinkMap pins={d.pins} statuses={statuses} show={show} focus={focus} /></div>
        <p className="note" style={{ marginTop: 8 }}>A link shows at every place it touched: where it was made (or its requester's area), shared from, opened and paid from, coloured by the link. Hover a pin for its links; nearby places share a pin until you zoom in.</p>
        <p className="note">Areas come from the internet connection, never GPS. On Wi-Fi and fibre that is the town or city; on mobile data South African networks often show their hub city (Johannesburg, Cape Town, Durban), and a VPN shows the VPN. WhatsApp hides forwards, so a link is placed where it is opened; a link made in WhatsApp shows its requester's area only once they use the web app or paste the link into a chat. {t.unknownArea ? `${t.unknownArea} ${t.unknownArea === 1 ? 'open' : 'opens'} had no area.` : ''}</p>
      </div>
      {d.abroad?.length ? (
        <div className="card" style={{ marginTop: 14, borderColor: 'var(--crit)' }}>
          <h2>Opened or paid from outside South Africa</h2>
          <p className="note" style={{ marginTop: 0 }}>Often a VPN or a traveller, but stolen cards are usually used from abroad: check these links. The number is opens and pay presses from that country; the dots count its links by status, in the pin colours. Click a country to see it on the map.</p>
          <div className="lm-countries">
            {d.abroad.map((a) => {
              const Chip = pinned.has(a.country) ? 'button' : 'span';
              const byStatus = statuses.filter((s) => a.links?.[s.status]).map((s) => `${a.links[s.status]} ${s.label.toLowerCase()}`).join(', ');
              return (
                <Chip key={a.country} {...(Chip === 'button' ? { type: 'button', onClick: () => goCountry(a.country) } : {})} className="lm-country" title={`${a.name || a.country} (${a.country}): ${plural(a.count, 'open or pay press', 'opens or pay presses')}${byStatus ? `; links: ${byStatus}` : ''}`}>
                  <span className="lm-flag" aria-hidden="true">{a.flag}</span>
                  <span>{a.name || a.country}</span>
                  <span className="lm-cc">{a.count}</span>
                  {statuses.map((s) => (a.links?.[s.status] ? <span key={s.status} className="lm-cs" style={{ '--c': colourOf(s) }} aria-label={`${a.links[s.status]} ${s.label.toLowerCase()}`}>{a.links[s.status]}</span> : null))}
                </Chip>
              );
            })}
          </div>
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
