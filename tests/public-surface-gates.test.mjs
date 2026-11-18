/**
 * The public surface (security sweep 2026-11-13): no operator route answers a
 * stranger.
 *
 * What these lock:
 * - every route under pages/api/admin and pages/api/internal checks a
 *   credential before it does anything (the admin login itself excepted);
 * - the leftovers the sweep found stay closed: the echo stub is gone, the
 *   balance route and the two Meta set-up routes need the internal key;
 * - no API answer can be sniffed into a page, and the one value the WhatsApp
 *   verification echoes is sent as plain text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const walk = (dir, out = []) => {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (lstatSync(join(ROOT, rel)).isDirectory()) walk(rel, out); else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
};

// The ways a route proves its caller today. A new route uses requireAdmin or requireInternalAuth. The
// incident route uses responderAuth (lib/responder-auth.js): the internal key, or a key that opens that
// route and nothing else (tests/incidents.test.mjs holds it to one route).
const GATE = /requireAdmin\(req\)|requireInternalAuth\(req, res\)|responderAuth\(req\)|if \(!keyOk\(req\)\)|if \(!isAuthed\(req\)\)|req\.headers\['x-admin-key'\] !== ADMIN_KEY/;
const LOGIN = new Set(['pages/api/admin/auth.js']);

test('every admin and internal route checks a credential before it does anything', () => {
  const routes = [...walk('pages/api/admin'), ...walk('pages/api/internal')];
  assert.ok(routes.length > 40, `found ${routes.length} operator routes`);
  const open = [];
  for (const rel of routes) {
    if (LOGIN.has(rel)) continue;
    const src = read(rel);
    const body = src.slice(Math.max(0, src.search(/export default|return async function handler/)));
    const gate = body.search(GATE);
    const firstTouch = body.search(/prisma\.[a-zA-Z$]+\.|await fetch\(|graph\.facebook\.com/);
    if (gate === -1) open.push(`${rel}: no gate`);
    else if (firstTouch !== -1 && firstTouch < gate) open.push(`${rel}: touches the database or the network before the gate`);
  }
  assert.deepEqual(open, []);
});

test('the leftovers the sweep found stay closed', () => {
  assert.equal(existsSync(join(ROOT, 'pages/api/webhook-test.js')), false, 'the echo stub is gone');
  for (const rel of ['pages/api/wallet/balance.js', 'pages/api/admin/list-wabas.js', 'pages/api/admin/init-templates.js']) {
    const src = read(rel);
    const body = src.slice(src.indexOf('export default'));
    const gate = body.indexOf('if (!requireInternalAuth(req, res)) return;');
    assert.ok(gate > -1, `${rel} needs the internal key`);
    for (const touch of ['prisma.', 'fetch(', 'initializeTemplates(', 'req.query']) {
      const at = body.indexOf(touch);
      assert.ok(at === -1 || gate < at, `${rel}: the key is checked before ${touch}`);
    }
  }
  assert.ok(!/error: error\.message/.test(read('pages/api/admin/init-templates.js')), 'a failure does not hand the caller the error text');
});

test('no API answer is sniffed into a page, and the verification echo is plain text', () => {
  const cfg = read('next.config.js');
  // The consoles where a tap approves money cannot be framed by another site.
  for (const source of ['/', '/admin', '/admin/:path*', '/business', '/business/:path*', '/ops/:path*', '/app', '/app/:path*']) {
    assert.ok(cfg.includes(`{ source: '${source}', headers: app }`), `${source} carries the frame, sniff and referrer headers`);
  }
  assert.match(cfg, /\{ key: 'X-Frame-Options', value: 'DENY' \}/); assert.match(cfg, /frame-ancestors 'none'/);
  assert.match(cfg, /\{ source: '\/api\/:path\*', headers: \[\{ key: 'X-Content-Type-Options', value: 'nosniff' \}\] \}/);
  const hook = read('pages/api/webhooks/whatsapp.js');
  const echo = hook.indexOf('return res.status(200).send(challenge);');
  assert.ok(echo > -1);
  assert.ok(hook.lastIndexOf("res.setHeader('Content-Type', 'text/plain; charset=utf-8');", echo) > hook.lastIndexOf('token === expectedToken', echo), 'set after the token check, before the echo');
  // Any route that sends a page says so itself, so the header above cannot blank it.
  const checkout = read('pages/api/pay/checkout.js');
  for (const m of checkout.matchAll(/res(?:\.status\(200\))?\.send\((ownLinkWarnHtml|autoSubmitHtml)\(/g)) {
    assert.ok(checkout.lastIndexOf("res.setHeader('Content-Type', 'text/html; charset=utf-8');", m.index) > m.index - 400, `${m[1]} is sent as text/html`);
  }
});
