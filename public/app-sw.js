/*
 * The WaPay app's service worker (2026-11-24), registered for /app by
 * components/app/Shell.js. It exists so the installed app has something to
 * show when the phone has no connection.
 *
 * It stores nothing. There is no cache here: a page is always fetched from
 * WaPay, and when that fails the person sees the offline screen below, which
 * is part of this file and shows no balance and no customer data
 * (docs/GOLDEN_THREAD.md 2.13). The screen says nothing about what did or did
 * not happen in the account: it cannot know. It only ever answers a page load. Every other
 * request, and anything under /api/, passes straight through untouched.
 */
const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>No connection</title>
<style>
:root{--page:#F4F6F8;--ink:#111827;--grey:#6B7280;--green:#359853}
@media (prefers-color-scheme:dark){:root{--page:#0E100F;--ink:#F3F5F2;--grey:#9BA39D}}
html,body{margin:0;height:100%}
body{background:var(--page);color:var(--ink);font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;text-align:center}
main{padding:24px;max-width:340px}
h1{font-size:22px;margin:0 0 8px}
p{font-size:14.5px;line-height:1.5;color:var(--grey);margin:0 0 20px}
button{font:inherit;font-weight:700;font-size:15.5px;border:0;border-radius:14px;padding:14px 22px;background:var(--green);color:#fff;cursor:pointer}
</style>
</head>
<body>
<main>
<h1>No connection</h1>
<p>WaPay needs a connection to show your money. Check your data or Wi-Fi, then try again. If you were busy with a payment, look at Activity before you try it again.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Page loads only. An API call, a script, an image or a form post is never touched.
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request).catch(() => new Response(OFFLINE_PAGE, {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
      },
    })),
  );
});
