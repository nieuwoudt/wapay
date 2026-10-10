/**
 * Growth instrumentation (2026-10-10): attribution from Meta's click-to-WhatsApp
 * referral, the Conversions API events, the Marketing API parsers, and the
 * Scale Model encoder the Growth tab uses to open the artifact with measured
 * inputs.
 *
 * Locks:
 * - an ad referral stamps acquisitionSource 'ad' with adId + ctwaClid in the
 *   SAME create as the account row (synchronous, before any reply);
 * - a card payer's number is 'paylink' with the requester as referrer;
 * - no referral and no payment = organic, no attribution object;
 * - Conversions API is OFF without a dataset id (no fetch is ever made);
 * - a business-messaging event carries action_source, messaging_channel,
 *   whatsapp_business_account_id and ctwa_clid; Purchase carries ZAR value;
 * - LeadSubmitted / QualifiedLead / Purchase are sent once each and marked;
 * - Meta insight rows map spend to cents and the messaging action types to
 *   conversations / connections;
 * - encodeScenario round-trips through the artifact's decode and never emits
 *   an input at its plan value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { attributionFromReferral, newAccountProfile, syncCapiForAccount } from '../lib/growth-attribution.js';
import { buildBusinessMessagingEvent, sendCapiEvents, capiConfig, CAPI_EVENTS } from '../lib/meta-capi.js';
import { parseInsightRow, parseAdRow, adsConfig, CONVERSATION_ACTION, CONNECTION_ACTION } from '../lib/meta-ads.js';
import { INPUTS, encodeScenario, decodeScenario, measuredToInputs, boundStatus, preset, simulate, budgetFn, BUDGET_DEFAULT } from '../lib/scale-model.js';
import { getOrCreateUser } from '../pages/api/webhooks/user-manager.js';

const REFERRAL = { source_url: 'https://fb.me/abc', source_type: 'ad', source_id: '120212345678901234', headline: 'Please pay me 🙏', body: 'Get paid on WhatsApp', media_type: 'image', ctwa_clid: 'ARAb12cd34ef' };

test('attribution: an ad referral becomes an attribution record; anything else is null', () => {
  const now = new Date('2026-10-10T10:00:00Z');
  const a = attributionFromReferral(REFERRAL, now);
  assert.equal(a.source, 'ad');
  assert.equal(a.adId, '120212345678901234');
  assert.equal(a.ctwaClid, 'ARAb12cd34ef');
  assert.equal(a.headline, 'Please pay me 🙏');
  assert.equal(a.capturedAt, now.toISOString());
  assert.equal(attributionFromReferral(null), null);
  assert.equal(attributionFromReferral({ source_type: 'post' }), null);
});

test('attribution: the profile a new account is created with', () => {
  assert.deepEqual(newAccountProfile({}), { acquisitionSource: 'organic' });
  const ad = newAccountProfile({ referral: REFERRAL });
  assert.equal(ad.acquisitionSource, 'ad');
  assert.equal(ad.attribution.ctwaClid, 'ARAb12cd34ef');
  const link = newAccountProfile({ paidBefore: true, referrerAccountId: 'acc-requester' });
  assert.equal(link.acquisitionSource, 'paylink');
  assert.equal(link.attribution.referrerAccountId, 'acc-requester');
  // An ad click wins over a pay-link history.
  assert.equal(newAccountProfile({ referral: REFERRAL, paidBefore: true }).acquisitionSource, 'ad');
});

test('getOrCreateUser computes the attribution BEFORE the upsert and writes it in the same create', () => {
  // Static lock: the module owns its prisma import, so the ordering is read
  // from the source. The pure half (newAccountProfile) is tested above.
  const src = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/user-manager.js', import.meta.url)), 'utf8');
  const attrib = src.indexOf('newAccountProfile({ referral');
  const upsert = src.indexOf('prisma.account.upsert');
  assert.ok(attrib > 0 && upsert > attrib, 'attribution is computed before the row is written');
  assert.ok(src.indexOf('profile: growthProfile', upsert) > upsert, 'the create carries the attribution');
  assert.equal(typeof getOrCreateUser, 'function');
});

test('conversions api: off without a dataset id, and the event shape when on', async () => {
  const off = capiConfig({});
  assert.equal(off.configured, false);
  let fetched = 0;
  const res = await sendCapiEvents([{ event_name: 'Purchase' }], { env: {}, fetchImpl: async () => { fetched += 1; return { ok: true, json: async () => ({}) }; } });
  assert.equal(res.skipped, 'NOT_CONFIGURED');
  assert.equal(fetched, 0, 'no network call without config');

  const ev = buildBusinessMessagingEvent({ eventName: CAPI_EVENTS.PURCHASE, eventTime: new Date('2026-10-10T10:00:00Z'), ctwaClid: 'ARAb12cd34ef', wabaId: '801970852418258', eventId: 'acc:purchase', valueCents: 5000 });
  assert.equal(ev.action_source, 'business_messaging');
  assert.equal(ev.messaging_channel, 'whatsapp');
  assert.equal(ev.user_data.whatsapp_business_account_id, '801970852418258');
  assert.equal(ev.user_data.ctwa_clid, 'ARAb12cd34ef');
  assert.equal(ev.event_time, Math.floor(new Date('2026-10-10T10:00:00Z').getTime() / 1000));
  assert.deepEqual(ev.custom_data, { currency: 'ZAR', value: 50 });
  assert.throws(() => buildBusinessMessagingEvent({ eventName: 'Purchase', eventTime: Date.now(), wabaId: 'x' }), /ctwaClid/);

  const env = { META_CAPI_DATASET_ID: 'ds1', META_WHATSAPP_TOKEN: 'tok', META_WHATSAPP_BUSINESS_ACCOUNT_ID: '801970852418258', META_CAPI_TEST_EVENT_CODE: 'TEST123' };
  let url = null, body = null;
  const sent = await sendCapiEvents([ev], { env, fetchImpl: async (u, init) => { url = u; body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ events_received: 1 }) }; } });
  assert.equal(sent.ok, true);
  assert.match(url, /\/ds1\/events\?access_token=tok$/);
  assert.equal(body.test_event_code, 'TEST123');
  assert.equal(body.data[0].event_name, 'Purchase');
});

test('conversions api: each milestone is sent once and marked on the profile', async () => {
  const env = { META_CAPI_DATASET_ID: 'ds1', META_WHATSAPP_TOKEN: 'tok', META_WHATSAPP_BUSINESS_ACCOUNT_ID: '801970852418258' };
  const profile = { attribution: { ctwaClid: 'ARAb12cd34ef', onboardedAt: '2026-10-09T09:00:00Z' } };
  const merges = [];
  const prisma = {
    account: { async findUnique() { return { id: 'acc1', profile }; } },
    consent: { async findFirst() { return { grantedAt: new Date('2026-10-09T09:00:00Z') }; } },
    paymentRequest: { async findFirst() { return { createdAt: new Date('2026-10-09T10:00:00Z') }; } },
    async $queryRaw() { return [{ at: new Date('2026-10-09T11:00:00Z'), cents: 15000 }]; },
    async $executeRaw(strings, ...values) { merges.push(values); profile.attribution.capi = { lead: 'x', qualified: 'x', purchase: 'x' }; return 1; },
  };
  const bodies = [];
  const fetchImpl = async (u, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ events_received: 3 }) }; };
  const first = await syncCapiForAccount({ prisma, accountId: 'acc1', now: new Date('2026-10-10T12:00:00Z'), env, fetchImpl });
  assert.deepEqual(first.sent, ['LeadSubmitted', 'QualifiedLead', 'Purchase']);
  assert.equal(bodies[0].data[2].custom_data.value, 150);
  assert.equal(merges.length, 1, 'marks merged once');
  const second = await syncCapiForAccount({ prisma, accountId: 'acc1', now: new Date(), env, fetchImpl });
  assert.equal(second.skipped, 'COMPLETE');
  assert.equal(bodies.length, 1, 'nothing sent twice');
});

test('marketing api: insight rows and ad rows parse into our shapes; off without envs', () => {
  assert.equal(adsConfig({}).configured, false);
  assert.equal(adsConfig({ META_ADS_ACCESS_TOKEN: 't', META_AD_ACCOUNT_ID: 'act_123' }).accountId, '123');
  const row = parseInsightRow({
    ad_id: '1', ad_name: 'Hook A', adset_id: '2', adset_name: 'Resellers', campaign_id: '3', campaign_name: 'PPM Oct', date_start: '2026-10-09', date_stop: '2026-10-09',
    spend: '123.45', impressions: '1000', reach: '900', clicks: '40', inline_link_clicks: '35',
    actions: [{ action_type: CONVERSATION_ACTION, value: '12' }, { action_type: CONNECTION_ACTION, value: '15' }, { action_type: 'link_click', value: '35' }],
  });
  assert.equal(row.spendCents, 12345);
  assert.equal(row.conversations, 12);
  assert.equal(row.connections, 15);
  assert.equal(row.date, '2026-10-09');
  assert.equal(parseInsightRow({}), null);
  const ad = parseAdRow({ id: '1', name: 'Hook A', effective_status: 'ACTIVE', adset: { id: '2', name: 'Resellers' }, campaign: { id: '3', name: 'PPM Oct', objective: 'OUTCOME_ENGAGEMENT' }, creative: { object_story_spec: { link_data: { name: 'Get paid on WhatsApp', message: 'Please pay me' } } } });
  assert.equal(ad.headline, 'Get paid on WhatsApp');
  assert.equal(ad.body, 'Please pay me');
});

test('scale model: the scenario encoder matches the artifact and only carries non-plan inputs', () => {
  const enc = encodeScenario({ inputs: { cpConv: 22, arpu: 15, nothing: 9 }, decision: 24, target: 250 });
  const dec = decodeScenario(enc);
  assert.deepEqual(dec.p, { cpConv: 22 }, 'arpu at plan and unknown keys are dropped');
  assert.equal(dec.d, 24);
  assert.equal(dec.t, 250);
  assert.equal(dec.b.length, 4);
  assert.doesNotMatch(enc, /[+/=]/, 'base64url');
  const inputs = measuredToInputs({ cpConv: { value: 18.4, n: 50 }, convToOnb: { value: 41, n: 5 } }, { minN: 20 });
  assert.deepEqual(inputs, { cpConv: 18 }, 'a thin sample stays at plan');
  assert.equal(boundStatus(INPUTS.find((i) => i.k === 'cpConv'), 9), 'great');
  assert.equal(boundStatus(INPUTS.find((i) => i.k === 'cpConv'), 31), 'stop');
  assert.equal(boundStatus(INPUTS.find((i) => i.k === 'arpu'), 16), 'plan');
  const res = simulate(preset('plan'), budgetFn(BUDGET_DEFAULT));
  assert.equal(res.rows.length, 36);
  assert.ok(res.rows.every((r) => Object.values(r).every((v) => typeof v !== 'number' || Number.isFinite(v))));
});
