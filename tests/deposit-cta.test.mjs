/**
 * PayFast deposit UX — preamble + tappable CTA-URL button, not a raw URL.
 *
 * Locks:
 * - the wire payload shape of buildCtaUrlPayload (pure, from @wapay/whatsapp)
 *   including Meta's 20-char button limit at the WORST-case deposit amount;
 * - static wiring in handleCardDepositLink: sendWhatsAppCtaUrl carries the
 *   checkout URL, the preamble explains the PayFast round trip, and a
 *   plain-text link fallback exists so presentation can never block payment.
 *
 * The processor is checked statically (importing it pulls Prisma).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildCtaUrlPayload } from '@wapay/whatsapp';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

/** The body of handleCardDepositLink, sliced out of the processor source. */
function cardDepositHandlerSource() {
  const start = processorSource.indexOf('async function handleCardDepositLink');
  assert.ok(start > -1, 'processor must define handleCardDepositLink');
  const end = processorSource.indexOf('\nasync function ', start);
  assert.ok(end > start, 'handleCardDepositLink must be followed by another function');
  return processorSource.slice(start, end);
}

/** randsShort as shipped (kept in sync with the processor's one-liner). */
function randsShort(cents) {
  return `R${((cents || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

// ---------------------------------------------------------------------------
// Wire payload shape
// ---------------------------------------------------------------------------

test('buildCtaUrlPayload: interactive cta_url with display_text + url', () => {
  const p = buildCtaUrlPayload({
    to: '27760000000',
    headerText: 'Add money to WaPay',
    bodyText: 'Body copy',
    footerText: 'Secured by PayFast',
    buttonText: 'Pay R100 now',
    url: 'https://www.payfast.co.za/eng/process?x=1',
  });

  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.type, 'interactive');
  assert.equal(p.interactive.type, 'cta_url');
  assert.equal(p.interactive.header.type, 'text');
  assert.equal(p.interactive.header.text, 'Add money to WaPay');
  assert.equal(p.interactive.body.text, 'Body copy');
  assert.equal(p.interactive.footer.text, 'Secured by PayFast');
  assert.equal(p.interactive.action.name, 'cta_url');
  assert.equal(p.interactive.action.parameters.display_text, 'Pay R100 now');
  assert.equal(p.interactive.action.parameters.url, 'https://www.payfast.co.za/eng/process?x=1');
});

test('buildCtaUrlPayload: header/footer omitted when not given', () => {
  const p = buildCtaUrlPayload({
    to: '27760000000',
    bodyText: 'Body copy',
    buttonText: 'Pay',
    url: 'https://example.test/x',
  });
  assert.ok(!('header' in p.interactive));
  assert.ok(!('footer' in p.interactive));
});

test('buildCtaUrlPayload: enforces Meta limits and https', () => {
  const base = { to: 'x', bodyText: 'b', buttonText: 'ok', url: 'https://e.test/' };
  assert.throws(() => buildCtaUrlPayload({ ...base, buttonText: 'x'.repeat(21) }), /20 chars/);
  assert.throws(() => buildCtaUrlPayload({ ...base, bodyText: 'x'.repeat(1025) }), /1024/);
  assert.throws(() => buildCtaUrlPayload({ ...base, headerText: 'x'.repeat(61) }), /60/);
  assert.throws(() => buildCtaUrlPayload({ ...base, footerText: 'x'.repeat(61) }), /60/);
  assert.throws(() => buildCtaUrlPayload({ ...base, url: 'http://insecure.test/' }), /https/);
});

test('button copy fits the 20-char limit at the WORST-case deposit amount', () => {
  // Max deposit R3000; worst display width is a cents amount like R2999.99.
  for (const cents of [300000, 299999, 1000, 1050]) {
    const label = `Pay ${randsShort(cents)} now`;
    assert.ok(
      label.length <= 20,
      `button "${label}" (${label.length} chars) must fit Meta's 20-char cap`
    );
  }
});

// ---------------------------------------------------------------------------
// Static wiring in the processor
// ---------------------------------------------------------------------------

test('static: processor imports sendWhatsAppCtaUrl from @wapay/whatsapp', () => {
  assert.match(
    processorSource,
    /import \{[^}]*sendWhatsAppCtaUrl[^}]*\} from '@wapay\/whatsapp'/
  );
});

test('static: the CTA button carries the checkout URL', () => {
  const body = cardDepositHandlerSource();
  assert.match(body, /sendWhatsAppCtaUrl\(\{/);
  assert.match(body, /url: checkoutUrl/, 'the button must open the PayFast checkout');
  assert.match(body, /buttonText: `Pay \$\{randsShort\(grossCents\)\} now`/, 'button quotes the GROSS (credit + fee)');
});

test('static: preamble explains the PayFast round trip (there AND back)', () => {
  const body = cardDepositHandlerSource();
  assert.match(body, /PayFast/, 'names the payment partner');
  assert.match(body, /card[\s\S]{0,12}or Instant EFT/i, 'names both payment methods');
  assert.match(body, /back to WaPay/i, 'tells the user they will return');
  assert.match(body, /to this chat/, 'promises the return to the chat');
});

test('static: plain-text link fallback exists and is logged', () => {
  const body = cardDepositHandlerSource();
  assert.match(body, /if \(interactive\?\.ok\) return interactive;/);
  assert.match(body, /deposit_cta_fallback/, 'fallback path must be observable in logs');
  assert.match(
    body,
    /sendWhatsAppText\(\{[\s\S]*\$\{checkoutUrl\}/,
    'fallback still delivers the raw checkout link'
  );
});
