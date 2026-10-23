/**
 * WaPay personal portal: activity (2026-10-21). Everything in and out, newest
 * first, 50 at a time, from the ledger.
 */
import { useEffect, useState } from 'react';
import Shell from '../../components/app/Shell.js';
import { ActivityRow, Notice, Spinner, api, useBusy } from '../../components/app/kit.js';

function ActivityScreen() {
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const load = (before = null) => run(async () => {
    const r = await api(`/api/app/activity${before ? `?before=${encodeURIComponent(before)}` : ''}`);
    if (!r.ok) { setError('Activity could not be loaded just now. Please try again.'); return; }
    setItems((cur) => (before && cur ? [...cur, ...r.data.items] : r.data.items));
    setNext(r.data.nextBefore || null);
  });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <p className="h1">Activity</p>
      <p className="p">Everything in and out, newest first.</p>
      <Notice tone="error">{error}</Notice>
      {items == null ? <Spinner /> : (
        <div className="card tight">
          {items.length ? items.map((it) => <ActivityRow key={it.id} item={it} long />) : <p className="p" style={{ margin: '12px 0' }}>Nothing yet.</p>}
        </div>
      )}
      {next ? <button type="button" className="btn ghost" disabled={busy} onClick={() => load(next)}>{busy ? 'Loading…' : 'Show older'}</button> : null}
    </>
  );
}

export default function Activity() {
  return (
    <Shell title="Activity" tab="activity">
      <ActivityScreen />
    </Shell>
  );
}
