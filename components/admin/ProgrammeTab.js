/**
 * Mission Control's Programme tab (founder 2026-11-13): every workstream,
 * thread and open item in one place.
 *
 *   Management  what needs the founder, what waits on others, what to watch,
 *               one line per workstream, what shipped lately
 *   Build       every item per workstream with its owner and evidence
 *   Threads     each working session, where it left off, a link to open it
 *   Security    the findings of the last sweep and their state
 *   System      the architecture components, subsystems and documents
 *
 * The content is the snapshot a session published (GET /api/admin/programme);
 * nothing here is computed from customer data, and the page holds no content
 * of its own. Styling uses Mission Control's own classes.
 */
import { useEffect, useState } from 'react';

const VIEWS = [['mgmt', 'Management'], ['build', 'Build'], ['threads', 'Threads'], ['security', 'Security'], ['system', 'System']];
const PRIO = { P0: 0, P1: 1, P2: 2, P3: 3 };
const STATUS_LABEL = { OPEN: 'open', IN_PROGRESS: 'in progress', BLOCKED: 'blocked', DECISION: 'your decision', WATCH: 'watch', PARKED: 'parked', DONE: 'done' };
const STATE_COLOR = { green: 'var(--good)', amber: 'var(--s4)', red: 'var(--crit)', parked: 'var(--ink3)', good: 'var(--good)', warn: 'var(--s4)', crit: 'var(--crit)', info: 'var(--ink3)' };
const SEV_CLASS = { CRITICAL: 'r', HIGH: 'r', MEDIUM: 'y', LOW: 'g', INFO: 'g' };

// A link from the board is followed only to Claude: the snapshot is data, and data never chooses where a click in the console goes.
const safeHref = (u) => (/^(https:\/\/claude\.ai\/|claude:\/\/)[^\s"<>]+$/.test(String(u || '')) ? String(u) : null);
const when = (s) => (s ? new Date(s).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const byPriority = (a, b) => (PRIO[a.priority] - PRIO[b.priority]) || String(a.due || '9999').localeCompare(String(b.due || '9999')) || String(a.id).localeCompare(String(b.id));
const ownerText = (o, threads) => {
  const s = String(o || '');
  if (s === 'founder') return 'you';
  if (s === 'main') return 'main session';
  if (s.startsWith('supplier:')) return s.slice(9);
  if (s.startsWith('thread:')) return threads[s.slice(7)]?.title || 'a session';
  return s;
};

function Prio({ p }) {
  return <span className={`pill ${p === 'P0' ? 'r' : p === 'P1' ? 'y' : 'g'}`} style={{ marginRight: 8 }}>{p}</span>;
}

function Item({ it, threads, showOwner = true }) {
  const overdue = it.due && it.status !== 'DONE' && new Date(`${it.due}T23:59:59`) < new Date();
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--grid)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Prio p={it.priority} />
        <span style={{ fontWeight: 600, fontSize: 13, flex: '1 1 260px', minWidth: 0 }}>{it.title}</span>
        <span className="vs" style={{ margin: 0, whiteSpace: 'nowrap' }}>
          {STATUS_LABEL[it.status] || it.status}{showOwner ? ` · ${ownerText(it.owner, threads)}` : ''}
          {it.due ? <span style={{ color: overdue ? 'var(--crit)' : undefined }}>{` · due ${it.due}`}</span> : null}
        </span>
      </div>
      {it.detail ? <div className="note" style={{ margin: '3px 0 0', fontSize: 12 }}>{it.detail}</div> : null}
      {it.blockedOn ? <div className="note" style={{ margin: '2px 0 0' }}>Waits on: {it.blockedOn}</div> : null}
      {it.evidence ? <div className="note" style={{ margin: '2px 0 0', opacity: 0.8 }}>{it.id} · {it.evidence}</div> : <div className="note" style={{ margin: '2px 0 0', opacity: 0.8 }}>{it.id}</div>}
    </div>
  );
}

function ItemList({ items, threads, empty, showOwner, first = 8 }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <div className="empty">{empty}</div>;
  const shown = all ? items : items.slice(0, first);
  return (
    <>
      {shown.map((it) => <Item key={it.id} it={it} threads={threads} showOwner={showOwner} />)}
      {items.length > first ? <button className="linkish" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button> : null}
    </>
  );
}

export default function ProgrammeTab() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('mgmt');
  const [ws, setWs] = useState('all');
  const [openOnly, setOpenOnly] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/programme')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (!cancelled) { setD(j); setErr(''); } })
      .catch(() => { if (!cancelled) setErr('Could not load the programme board.'); });
    return () => { cancelled = true; };
  }, [tick]);

  if (err) return <div className="card"><div className="empty">{err}</div></div>;
  if (!d) return <div className="card"><div className="empty">Loading the board…</div></div>;
  if (!d.stored) {
    return (
      <div className="card">
        <h2>Programme board</h2>
        <p className="note">No board has been published yet. A session publishes it with scripts/programme-board.mjs after updating the master file; it then appears here without a deploy.</p>
      </div>
    );
  }

  const b = d.board || {};
  const threads = Object.fromEntries((b.threads || []).map((t) => [t.id, t]));
  const wsById = Object.fromEntries((b.workstreams || []).map((w) => [w.id, w]));
  const items = b.items || [];
  const open = items.filter((i) => i.status !== 'DONE');
  const mine = open.filter((i) => i.owner === 'founder' && i.status !== 'WATCH' && i.status !== 'PARKED').sort(byPriority);
  const others = open.filter((i) => String(i.owner).startsWith('supplier:')).sort(byPriority);
  const watch = open.filter((i) => i.status === 'WATCH').sort(byPriority);
  const countFor = (id) => ({ open: open.filter((i) => i.ws === id).length, p0: open.filter((i) => i.ws === id && i.priority === 'P0').length });
  const findings = b.security?.findings || [];

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="tabs">
          {VIEWS.map(([k, label]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{label}</button>)}
        </div>
        <button className="linkish" onClick={() => setTick((t) => t + 1)}>↻ Refresh</button>
        <span className="note" style={{ margin: 0 }}>
          as of {when(b.asOf)}{b.build ? ` · build ${b.build}` : ''} · published {when(d.storedAt)}{d.by ? ` by ${d.by}` : ''}
          {safeHref(b.boardUrl) ? <> · <a href={safeHref(b.boardUrl)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-ink)' }}>full board</a></> : null}
        </span>
      </div>

      {view === 'mgmt' && (
        <>
          {(b.pulse || []).length ? (
            <div className="card">
              <h2>Production right now</h2>
              <div className="ops" style={{ marginTop: 8 }}>
                {b.pulse.map((p) => (
                  <span key={p.label} title={p.note || ''} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--grid)' }}>
                    <span className="dot" style={{ background: STATE_COLOR[p.state] }} />{p.label}: <b>{p.value}</b>
                  </span>
                ))}
              </div>
              {b.pulse.filter((p) => p.note && (p.state === 'crit' || p.state === 'warn')).map((p) => <p key={p.label} className="note" style={{ margin: '8px 0 0' }}><b>{p.label}:</b> {p.note}</p>)}
            </div>
          ) : null}
          <div className="card" style={{ marginTop: 14 }}>
            <h2>Needs you ({mine.length})</h2>
            <p className="note">Decisions and actions only you can take, most urgent first.</p>
            <ItemList items={mine} threads={threads} showOwner={false} empty="Nothing is waiting on you." />
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <h2>Workstreams</h2>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Workstream</th><th>Where it stands</th><th>Next</th><th className="n">Open</th><th className="n">P0</th></tr></thead>
                <tbody>
                  {(b.workstreams || []).map((w) => {
                    const c = countFor(w.id);
                    return (
                      <tr key={w.id} style={{ cursor: 'pointer' }} onClick={() => { setWs(w.id); setView('build'); }}>
                        <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}><span className="dot" style={{ background: STATE_COLOR[w.state] }} />{w.name}</td>
                        <td style={{ minWidth: 240 }}>{w.summary}</td>
                        <td style={{ minWidth: 160 }}>{w.next || '—'}</td>
                        <td className="n">{c.open}</td>
                        <td className="n" style={{ color: c.p0 ? 'var(--crit)' : undefined, fontWeight: c.p0 ? 700 : 400 }}>{c.p0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <h2>Waiting on others ({others.length})</h2>
            <p className="note">Suppliers and partners who owe an answer or a credential.</p>
            <ItemList items={others} threads={threads} empty="Nobody outside owes anything." first={6} />
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <h2>Watch ({watch.length})</h2>
            <p className="note">Risks that need no action today but must not be forgotten.</p>
            <ItemList items={watch} threads={threads} empty="Nothing on watch." first={6} />
          </div>
          {(b.shipped || []).length ? (
            <div className="card" style={{ marginTop: 14 }}>
              <h2>Shipped lately</h2>
              <table><tbody>{b.shipped.slice(0, 14).map((s, i) => <tr key={i}><td style={{ whiteSpace: 'nowrap', color: 'var(--ink3)' }}>{s.date}</td><td>{s.what}</td><td style={{ whiteSpace: 'nowrap', color: 'var(--ink3)' }}>{s.ref || ''}</td></tr>)}</tbody></table>
            </div>
          ) : null}
        </>
      )}

      {view === 'build' && (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <select id="programme-ws" value={ws} onChange={(e) => setWs(e.target.value)} style={{ padding: '7px 10px', borderRadius: 10, border: '1px solid var(--grid)', background: 'transparent', color: 'var(--ink)', font: 'inherit' }}>
              <option value="all">All workstreams</option>
              {(b.workstreams || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <label className="note" style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input id="programme-open-only" type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> open items only
            </label>
          </div>
          {(b.workstreams || []).filter((w) => ws === 'all' || w.id === ws).map((w) => {
            const list = items.filter((i) => i.ws === w.id && (!openOnly || i.status !== 'DONE')).sort(byPriority);
            if (!list.length && ws === 'all') return null;
            return (
              <div key={w.id} className="card" style={{ marginBottom: 14 }}>
                <h2><span className="dot" style={{ background: STATE_COLOR[w.state] }} />{w.name} ({list.length})</h2>
                <p className="note">{w.summary}</p>
                {(w.live || []).length ? <p className="note"><b>Live:</b> {w.live.join(' · ')}</p> : null}
                {(w.threads || []).length ? <p className="note"><b>Sessions:</b> {w.threads.map((id) => threads[id]?.title || id).join(' · ')}</p> : null}
                <ItemList items={list} threads={threads} empty="No open items." first={ws === 'all' ? 6 : 40} />
              </div>
            );
          })}
        </>
      )}

      {view === 'threads' && (
        <div className="card">
          <h2>Sessions ({(b.threads || []).length})</h2>
          <p className="note">Each working session, what it owns and where it stopped. The link opens it in the Claude app on this computer.</p>
          {(b.threads || []).map((t) => (
            <div key={t.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--grid)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className={`pill ${t.state === 'active' ? 'g' : 'y'}`}>{t.state}</span>
                <span style={{ fontWeight: 600, fontSize: 13, flex: '1 1 240px', minWidth: 0 }}>{t.title}</span>
                <span className="vs" style={{ margin: 0 }}>last active {String(t.lastActive).slice(0, 10)} · {open.filter((i) => i.owner === `thread:${t.id}` || i.thread === t.id).length} open</span>
                {safeHref(t.link) ? <a href={safeHref(t.link)} style={{ fontSize: 12, color: 'var(--accent-ink)' }}>open</a> : null}
              </div>
              {t.role ? <div className="note" style={{ margin: '3px 0 0' }}>{t.role}</div> : null}
              {t.leftOff ? <div className="note" style={{ margin: '2px 0 0', fontSize: 12 }}><b>Left off:</b> {t.leftOff}</div> : null}
            </div>
          ))}
        </div>
      )}

      {view === 'security' && (
        <div className="card">
          <h2>Security sweep{b.security?.sweptAt ? ` of ${String(b.security.sweptAt).slice(0, 10)}` : ''}</h2>
          {b.security?.summary ? <p className="note">{b.security.summary}</p> : null}
          {!findings.length ? <div className="empty">No findings recorded.</div> : findings.map((f) => (
            <div key={f.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--grid)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className={`pill ${SEV_CLASS[f.severity] || 'y'}`}>{f.severity}</span>
                <span style={{ fontWeight: 600, fontSize: 13, flex: '1 1 260px', minWidth: 0 }}>{f.title}</span>
                <span className={`pill ${f.status === 'FIXED' ? 'g' : f.status === 'OPEN' ? 'r' : 'y'}`}>{String(f.status).toLowerCase()}</span>
              </div>
              {f.scenario ? <div className="note" style={{ margin: '3px 0 0', fontSize: 12 }}>{f.scenario}</div> : null}
              {f.fix ? <div className="note" style={{ margin: '2px 0 0' }}><b>Fix:</b> {f.fix}{f.commit ? ` (${f.commit})` : ''}</div> : null}
              <div className="note" style={{ margin: '2px 0 0', opacity: 0.8 }}>{f.id}{f.where ? ` · ${f.where}` : ''}</div>
            </div>
          ))}
        </div>
      )}

      {view === 'system' && (
        <>
          <div className="card">
            <h2>Architecture{b.architecture?.mapVersion ? ` (map ${b.architecture.mapVersion})` : ''}</h2>
            {b.architecture?.phase ? <p className="note">{b.architecture.phase}</p> : null}
            {safeHref(b.architecture?.mapUrl) ? <p className="note"><a href={safeHref(b.architecture.mapUrl)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-ink)' }}>Open the architecture map</a></p> : null}
            <table>
              <thead><tr><th>Component</th><th>State</th><th>Note</th></tr></thead>
              <tbody>{(b.architecture?.components || []).map((c) => <tr key={c.id}><td style={{ whiteSpace: 'nowrap' }}><b>{c.id}</b> {c.name}</td><td style={{ whiteSpace: 'nowrap' }}>{c.state}</td><td>{c.note || ''}</td></tr>)}</tbody>
            </table>
          </div>
          {(b.architecture?.subsystems || []).length ? (
            <div className="card" style={{ marginTop: 14 }}>
              <h2>Subsystems ({b.architecture.subsystems.length})</h2>
              <table>
                <thead><tr><th>Subsystem</th><th>State</th><th>Where it is described</th></tr></thead>
                <tbody>{b.architecture.subsystems.map((c) => <tr key={c.name}><td><b>{c.name}</b>{c.note ? <div className="note" style={{ margin: 0 }}>{c.note}</div> : null}</td><td style={{ whiteSpace: 'nowrap' }}>{c.state}</td><td>{c.doc || '—'}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {(b.docs || []).length ? (
            <div className="card" style={{ marginTop: 14 }}>
              <h2>Documents</h2>
              <table>
                <thead><tr><th>Document</th><th>State</th><th>Note</th></tr></thead>
                <tbody>{b.docs.map((x) => <tr key={x.doc}><td style={{ whiteSpace: 'nowrap' }}>{x.doc}</td><td><span className={`pill ${x.state === 'stale' ? 'r' : 'g'}`}>{x.state}</span></td><td>{x.note || ''}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
