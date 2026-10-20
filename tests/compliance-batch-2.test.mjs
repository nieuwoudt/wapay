// WhatsApp policy compliance, second batch (2026-10-20): the agent's standing rule,
// the internal routes for templates, ad breakdowns and Graph nodes, and the
// policy document that binds them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateTemplateBody, ALLOWED_CATEGORIES } from '../pages/api/internal/template-create.js';
import adsBreakdown, { BREAKDOWNS, parseRow, isoDayOk } from '../pages/api/internal/ads-breakdown.js';
import metaNode, { pickFields } from '../pages/api/internal/meta-node.js';
import templateCreate from '../pages/api/internal/template-create.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
function res() { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }

test('the agent prompt carries the reply-only rule next to the date rule', () => {
  const src = read('../packages/ai/src/prompt.ts');
  assert.match(src, /- Never promise a date\.\n- WaPay only answers\. One reply to each message; never say you will message, remind or follow up later, and never ask the customer to wait for a message from WaPay\./);
});

test('template creation refuses marketing and malformed bodies before Meta sees them', () => {
  assert.deepEqual(ALLOWED_CATEGORIES, ['UTILITY', 'AUTHENTICATION']);
  const good = { name: 'wapay_support_followup', category: 'UTILITY', language: 'en', components: [{ type: 'BODY', text: 'Hi {{1}}, WaPay support here. {{2}}' }] };
  assert.deepEqual(validateTemplateBody(good), { ok: true });
  assert.equal(validateTemplateBody({ ...good, category: 'MARKETING' }).error, 'BAD_CATEGORY');
  assert.equal(validateTemplateBody({ ...good, name: 'Bad Name' }).error, 'BAD_NAME');
  assert.equal(validateTemplateBody({ ...good, components: [] }).error, 'BAD_COMPONENTS');
  assert.equal(validateTemplateBody({ ...good, components: [{ type: 'BODY', text: 'x'.repeat(1025) }] }).error, 'BAD_BODY_TEXT');
  assert.equal(validateTemplateBody({ ...good, components: [{ type: 'BODY', text: 'a — b' }] }).error, 'EM_DASH');
  assert.equal(validateTemplateBody(null).error, 'BAD_BODY');
});

test('ads breakdown: whitelist, day check, row parsing', () => {
  assert.deepEqual(Object.keys(BREAKDOWNS), ['none', 'placement', 'age', 'gender', 'age_gender', 'region', 'device']);
  assert.ok(isoDayOk('2026-10-18') && !isoDayOk('18-10-2026') && !isoDayOk(''));
  const row = parseRow({ ad_id: '1', ad_name: 'A', publisher_platform: 'instagram', platform_position: 'instagram_reels', age: '25-34', impressions: '100', reach: '90', clicks: '10', inline_link_clicks: '7', ctr: '10', cpc: '0.5', cpm: '12.34', spend: '5.00', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' }, { action_type: 'lead', value: '2' }] });
  assert.equal(row.publisherPlatform, 'instagram'); assert.equal(row.platformPosition, 'instagram_reels'); assert.equal(row.age, '25-34');
  assert.equal(row.spendCents, 500); assert.equal(row.cpcCents, 50); assert.equal(row.cpmCents, 1234); assert.equal(row.conversations, 3); assert.equal(row.leads, 2); assert.equal(row.linkClicks, 7);
});

test('meta node: field whitelist', () => {
  assert.deepEqual(pickFields('name,account_review_status,access_token,id'), ['name', 'account_review_status', 'id']);
  assert.deepEqual(pickFields(undefined), ['id', 'name']);
});

test('the three routes refuse a call without the internal key', async () => {
  const prev = process.env.WAPAY_INTERNAL_API_KEY; process.env.WAPAY_INTERNAL_API_KEY = 'test-key-2026';
  try {
    for (const h of [adsBreakdown, metaNode, templateCreate]) {
      const r = res(); await h({ method: 'GET', headers: {}, query: {}, url: '/x' }, r);
      assert.equal(r.code, 401, h.name || 'route');
    }
    const r = res(); await adsBreakdown({ method: 'GET', headers: { 'x-internal-api-key': 'test-key-2026' }, query: { by: 'nope', since: '2026-10-18' }, url: '/x' }, r);
    assert.ok([400, 503].includes(r.code), 'a bad breakdown is refused (or the ads token is absent locally)');
  } finally { if (prev === undefined) delete process.env.WAPAY_INTERNAL_API_KEY; else process.env.WAPAY_INTERNAL_API_KEY = prev; }
});

test('the compliance standard names the support follow-up template and the send cap', () => {
  const doc = read('../docs/WHATSAPP_POLICY_COMPLIANCE.md');
  assert.match(doc, /wapay_support_followup/);
  assert.match(doc, /send cap|SEND_CAP/i);
  assert.ok(!/\b20\d\d-\d\d-\d\d\b.*customer/i.test(doc.split('\n').find((l) => /support follow-up/i.test(l)) || ''), 'no dates in customer-facing lines');
});
