/**
 * WaPay Scale Model — the planning model behind the "WaPay Scale Model"
 * artifact (https://claude.ai/artifact/2qy3TYNL6149xuT5FBZj8R), kept in the
 * repo so Mission Control can (a) carry the great / plan / stop bounds next
 * to every measured input and (b) build a link that opens the artifact with
 * MEASURED inputs in place of the assumed ones (`encodeScenario`).
 *
 * Pure: no DOM, no database. Monthly simulation over 36 months, rand.
 * Same file as the artifact's model.js plus the scenario encoder; keep the
 * two in step when the artifact changes (tests/growth.test.mjs pins the
 * encoder to the artifact's decode format).
 */

export const H = 36;
export const CONST = {
  freeMsgs: 1000,        // free service replies per business number per month (Meta, from 1 Oct 2026)
  adFreeReplies: 8,      // replies inside the 72-hour click-to-WhatsApp window: free
  onboardingReplies: 10, // bot replies to complete onboarding
  authPrice: 0.25,       // one authentication template (OTP) per onboarding, SA rate
  creepRef: 250000,      // monthly spend above which CAC creep applies
  seedTree: 1000,        // paid accounts seeded for the tree economics run
  dormantBalanceShare: 0.3,
};

// g: group · k: key · l: label · u: unit · plan/great/stop: the three bounds from the 13 Sep 2026 assessment
export const INPUTS = [
  { g: 'ads', k: 'cpConv', l: 'Cost per started conversation', u: 'R', plan: 15, great: 10, stop: 30, min: 3, max: 80, step: 1, solve: 'max', lowerIsBetter: true },
  { g: 'ads', k: 'convToOnb', l: 'Conversation to onboarding complete', u: '%', plan: 35, great: 45, stop: 20, min: 5, max: 80, step: 1, solve: 'min' },
  { g: 'ads', k: 'creep', l: 'CAC rise per doubling of spend above R250k', u: '%', plan: 25, great: 10, stop: 50, min: 0, max: 100, step: 5, solve: null, lowerIsBetter: true },
  { g: 'ads', k: 'optShare', l: 'Budget on optimisable placements', u: '%', plan: 80, great: 100, stop: 50, min: 0, max: 100, step: 5, solve: null },
  { g: 'ads', k: 'igPenalty', l: 'Cost multiplier on non-optimisable placements', u: '×', plan: 1.6, great: 1.3, stop: 2.0, min: 1, max: 3, step: 0.1, solve: null, lowerIsBetter: true },
  { g: 'ads', k: 'partnerMonthly', l: 'Partner and business-portal accounts per month', u: '', plan: 5000, great: 15000, stop: 0, min: 0, max: 50000, step: 500, solve: null },
  { g: 'ads', k: 'partnerStart', l: 'Partner channel starts in month', u: 'M', plan: 19, great: 13, stop: 36, min: 1, max: 36, step: 1, solve: null, lowerIsBetter: true },
  { g: 'funnel', k: 'onbToAct', l: 'Onboarded to first payment link created', u: '%', plan: 60, great: 75, stop: 40, min: 5, max: 100, step: 1, solve: 'min' },
  { g: 'funnel', k: 'actToFund', l: 'First link paid by someone', u: '%', plan: 55, great: 70, stop: 35, min: 5, max: 100, step: 1, solve: 'min' },
  { g: 'funnel', k: 'selfLoad', l: 'Non-activated who fund by self-load', u: '%', plan: 10, great: 15, stop: 5, min: 0, max: 60, step: 1, solve: null },
  { g: 'loop', k: 'linksPerActive', l: 'Links created per active per month', u: '', plan: 1.5, great: 2.5, stop: 0.8, min: 0, max: 6, step: 0.1, solve: 'min' },
  { g: 'loop', k: 'payersPerLink', l: 'Unique payers per link', u: '', plan: 1.2, great: 1.6, stop: 1.0, min: 0.5, max: 4, step: 0.1, solve: 'min' },
  { g: 'loop', k: 'payerToOnb', l: 'Payer to onboarded', u: '%', plan: 15, great: 25, stop: 6, min: 0, max: 60, step: 1, solve: 'min' },
  { g: 'loop', k: 'addressable', l: 'Addressable people', u: 'm', plan: 10, great: 14, stop: 6, min: 2, max: 30, step: 0.5, solve: null },
  { g: 'retention', k: 'm1Active', l: 'Active one month after funding', u: '%', plan: 70, great: 85, stop: 50, min: 10, max: 100, step: 1, solve: 'min' },
  { g: 'retention', k: 'm3Ret', l: 'Active three months after funding', u: '%', plan: 30, great: 40, stop: 15, min: 5, max: 95, step: 1, solve: 'min' },
  { g: 'retention', k: 'floorRet', l: 'Long-run floor', u: '%', plan: 15, great: 25, stop: 5, min: 0, max: 60, step: 1, solve: null },
  { g: 'econ', k: 'arpu', l: 'Net revenue per active per month', u: 'R', plan: 15, great: 25, stop: 8, min: 2, max: 60, step: 1, solve: 'min' },
  { g: 'econ', k: 'gmvPerActive', l: 'Money routed per active per month', u: 'R', plan: 600, great: 900, stop: 350, min: 50, max: 3000, step: 50, solve: null },
  { g: 'econ', k: 'repliesPerEvent', l: 'Bot replies per money event', u: '', plan: 8, great: 5, stop: 12, min: 2, max: 20, step: 1, solve: null, lowerIsBetter: true },
  { g: 'econ', k: 'eventsPerActive', l: 'Money events per active per month', u: '', plan: 6, great: 8, stop: 4, min: 1, max: 20, step: 1, solve: null },
  { g: 'econ', k: 'msgPrice', l: 'Meta price per delivered reply', u: 'R', plan: 0.13, great: 0.13, stop: 0.13, min: 0.05, max: 0.4, step: 0.01, solve: null, lowerIsBetter: true },
  { g: 'econ', k: 'aiCost', l: 'AI and infrastructure per active per month', u: 'R', plan: 2, great: 1, stop: 4, min: 0, max: 15, step: 0.5, solve: null, lowerIsBetter: true },
  { g: 'econ', k: 'fixedMonthly', l: 'Team and fixed costs per month', u: 'R', plan: 400000, great: 250000, stop: 700000, min: 0, max: 3000000, step: 10000, solve: null, lowerIsBetter: true },
  { g: 'econ', k: 'avgBalance', l: 'Average balance per active', u: 'R', plan: 120, great: 200, stop: 50, min: 0, max: 1000, step: 10, solve: null },
  { g: 'econ', k: 'floatYield', l: 'Interest earned on the safeguarded float', u: '% p.a.', plan: 0, great: 7, stop: 0, min: 0, max: 12, step: 0.5, solve: null },
  { g: 'econ', k: 'licenceMonth', l: 'E-money authorisation lands in month', u: 'M', plan: 13, great: 10, stop: 24, min: 1, max: 36, step: 1, solve: null, lowerIsBetter: true },
  { g: 'val', k: 'multiple', l: 'Revenue multiple at 5% monthly growth', u: '×', plan: 10, great: 12, stop: 6, min: 2, max: 25, step: 0.5, solve: 'min' },
  { g: 'val', k: 'floorVal', l: 'Pre-traction floor', u: 'Rm', plan: 15, great: 25, stop: 8, min: 0, max: 60, step: 1, solve: null },
  { g: 'val', k: 'perActive', l: 'Value per active user', u: 'R', plan: 1800, great: 2700, stop: 900, min: 200, max: 6000, step: 100, solve: 'min' },
  { g: 'val', k: 'premium', l: 'Licence and second-market premium', u: '×', plan: 1.0, great: 1.8, stop: 1.0, min: 1, max: 3, step: 0.1, solve: null },
];

export const BUDGET_DEFAULT = [
  { name: 'Prove', from: 1, spend: 40000 },
  { name: 'Push', from: 4, spend: 250000 },
  { name: 'Scale', from: 10, spend: 1000000 },
  { name: 'Compound', from: 19, spend: 2500000 },
];

export const SCALE_MODEL_URL = 'https://claude.ai/artifact/2qy3TYNL6149xuT5FBZj8R';

export function preset(name) {
  const p = {};
  for (const i of INPUTS) p[i.k] = i[name];
  return p;
}
export function byKey(k) {
  return INPUTS.find((i) => i.k === k) || null;
}

/**
 * Where a measured value sits against an input's bounds.
 * @returns {'great'|'plan'|'stop'|'unknown'} great = at or beyond the great bound,
 * stop = at or beyond the stop bound, plan = in between.
 */
export function boundStatus(input, value) {
  if (!input || value === null || value === undefined || !isFinite(value)) return 'unknown';
  const better = input.lowerIsBetter ? (a, b) => a <= b : (a, b) => a >= b;
  if (input.great === input.stop) return 'plan';
  if (better(value, input.great)) return 'great';
  if (!better(value, input.stop)) return 'stop';
  return 'plan';
}

/**
 * The artifact's own state format (`#s=` in its URL): a base64url JSON of the
 * inputs that differ from the plan case, the budget phases, the decision
 * month, the sensitivity output, the target valuation (R million) and frame.
 * `inputs` may be partial; keys the model does not know are dropped.
 */
export function encodeScenario({ inputs = {}, budget = BUDGET_DEFAULT, decision = 24, output = 'valRev', target = 250, frame = 'rev' } = {}) {
  const diff = {};
  for (const i of INPUTS) {
    const v = inputs[i.k];
    if (v === undefined || v === null || !isFinite(v)) continue;
    const clamped = Math.min(i.max, Math.max(i.min, Number(v)));
    if (clamped !== i.plan) diff[i.k] = clamped;
  }
  const o = { p: diff, b: budget.slice(0, 4).map((b) => [b.from, b.spend]), d: decision, o: output, t: target, f: frame };
  const json = JSON.stringify(o);
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(json, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of encodeScenario (what the artifact does on load). */
export function decodeScenario(s) {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const json = typeof Buffer !== 'undefined' ? Buffer.from(t, 'base64').toString('utf8') : decodeURIComponent(escape(atob(t)));
  return JSON.parse(json);
}

export function scenarioUrl(scenario, baseUrl = SCALE_MODEL_URL) {
  return `${baseUrl}#s=${encodeScenario(scenario)}`;
}

/**
 * Measured inputs → model inputs. Each measured entry is { value, n }; a value
 * is used only when its sample reached `minN`, otherwise the plan case stays.
 */
export function measuredToInputs(measured, { minN = 20 } = {}) {
  const inputs = {};
  for (const i of INPUTS) {
    const m = measured?.[i.k];
    if (!m || m.value === null || m.value === undefined || !isFinite(m.value)) continue;
    if ((m.n ?? 0) < minN) continue;
    inputs[i.k] = Math.round(m.value / i.step) * i.step;
  }
  return inputs;
}

export function budgetFn(schedule) {
  const s = schedule.slice().sort((a, b) => a.from - b.from);
  return (m) => {
    let spend = 0;
    for (const ph of s) if (m >= ph.from) spend = ph.spend;
    return spend;
  };
}

export function retentionFn(p) {
  const m1 = p.m1Active / 100;
  const floor = Math.min(p.floorRet / 100, m1 - 0.01);
  let m3 = Math.min(p.m3Ret / 100, m1);
  m3 = Math.max(m3, floor + 0.005);
  const lam = -Math.log((m3 - floor) / (m1 - floor)) / 2;
  return (age) => (age <= 0 ? 1 : floor + (m1 - floor) * Math.exp(-lam * (age - 1)));
}

export function channelFactor(p) {
  return p.optShare / 100 + (1 - p.optShare / 100) * p.igPenalty;
}
export function baseCostPerOnboarded(p) {
  return (p.cpConv / (p.convToOnb / 100)) * channelFactor(p);
}

export function simulate(p, budget, o = {}) {
  const Hh = o.horizon || H;
  const r = retentionFn(p);
  const channel = channelFactor(p);
  const rows = [];
  const fundedC = [];
  let cumOnb = 0, cumFunded = 0, cumSpend = 0, cumCash = 0, minCash = 0, mauPrev = 0;
  for (let m = 1; m <= Hh; m++) {
    const spend = o.noPaid ? 0 : budget(m);
    const creep = spend > CONST.creepRef ? Math.pow(1 + p.creep / 100, Math.log(spend / CONST.creepRef) / Math.LN2) : 1;
    const cpo = (p.cpConv / (p.convToOnb / 100)) * creep * channel;
    let paidOnb = spend > 0 ? spend / cpo : 0;
    if (o.seedPaid && m === 1) paidOnb += o.seedPaid;
    const convs = spend / p.cpConv;
    const newShare = Math.max(0, 1 - cumOnb / (p.addressable * 1e6));
    const K = p.linksPerActive * p.payersPerLink * (p.payerToOnb / 100) * newShare;
    const loopOnb = mauPrev * K;
    const partnerOnb = !o.noPartner && m >= p.partnerStart ? p.partnerMonthly : 0;
    const onb = paidOnb + loopOnb + partnerOnb;
    const activated = (onb * p.onbToAct) / 100;
    const funded = (activated * p.actToFund) / 100 + ((onb - activated) * p.selfLoad) / 100;
    fundedC.push(funded);
    cumOnb += onb;
    cumFunded += funded;
    let mau = 0;
    for (let c = 0; c < fundedC.length; c++) mau += fundedC[c] * r(m - (c + 1));
    const floatBal = p.avgBalance * (mau + CONST.dormantBalanceShare * Math.max(0, cumFunded - mau));
    const floatInt = m >= p.licenceMonth ? (floatBal * (p.floatYield / 100)) / 12 : 0;
    const revenue = mau * p.arpu + floatInt;
    const msgs = mau * p.repliesPerEvent * p.eventsPerActive + onb * CONST.onboardingReplies - paidOnb * CONST.adFreeReplies;
    const msgCost = Math.max(0, msgs - CONST.freeMsgs) * p.msgPrice + onb * CONST.authPrice;
    const ai = mau * p.aiCost;
    const contribution = revenue - msgCost - ai;
    const fixed = o.noFixed ? 0 : p.fixedMonthly;
    const cash = contribution - spend - fixed;
    cumSpend += spend;
    cumCash += cash;
    if (cumCash < minCash) minCash = cumCash;
    const gmv = mau * p.gmvPerActive;
    const arr = revenue * 12;
    const mau3 = rows.length >= 3 ? rows[rows.length - 3].mau : 0;
    const growth = mau3 > 0 ? Math.pow(mau / mau3, 1 / 3) - 1 : mauPrev > 0 ? mau / mauPrev - 1 : 0;
    const growthAdj = 1 + Math.min(1, Math.max(0, (growth - 0.05) / 0.2));
    const prem = m >= p.licenceMonth ? p.premium : 1;
    const floorV = p.floorVal * 1e6;
    const valRev = Math.max(floorV, arr * p.multiple * growthAdj) * prem;
    const valActive = Math.max(floorV, mau * p.perActive) * prem;
    rows.push({ m, spend, cpo, creep, convs, paidOnb, loopOnb, partnerOnb, onb, activated, funded, cumOnb, cumFunded, mau, K, newShare, floatBal, floatInt, revenue, msgCost, ai, contribution, fixed, cash, cumCash, cumSpend, gmv, arr, growth, growthAdj, valRev, valActive });
    mauPrev = mau;
  }
  return { rows, minCash, fundedC, retention: r };
}

export function milestones(res, targets = [100, 1000, 10000, 100000, 1000000]) {
  return targets.map((t) => {
    const row = res.rows.find((r) => r.cumOnb >= t) || null;
    let cashNeed = 0;
    if (row) for (let j = 0; j < row.m; j++) cashNeed = Math.min(cashNeed, res.rows[j].cumCash);
    return { target: t, row, cashNeed: -cashNeed };
  });
}

export function fmtR(x) {
  if (x === null || x === undefined || isNaN(x)) return '–';
  const s = x < 0 ? '−' : '';
  const a = Math.abs(x);
  if (a >= 1e9) return `${s}R${trim(a / 1e9)}bn`;
  if (a >= 1e6) return `${s}R${trim(a / 1e6)}m`;
  if (a >= 1e3) return `${s}R${trim(a / 1e3)}k`;
  return `${s}R${a < 10 ? trim(a) : Math.round(a)}`;
}
export function fmtN(x) {
  if (x === null || x === undefined || isNaN(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e6) return `${trim(a / 1e6)}m`;
  if (a >= 1e3) return `${trim(a / 1e3)}k`;
  return String(Math.round(a));
}
function trim(v) {
  const d = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const s = v.toFixed(d);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
}
export function fmtInput(i, v) {
  if (v === null || v === undefined || !isFinite(v)) return '–';
  if (i.u === 'R') return v >= 1000 ? fmtR(v) : `R${Math.round(v * 100) / 100}`;
  if (i.u === '%' || i.u === '% p.a.') return `${Math.round(v * 10) / 10}%`;
  if (i.u === '×') return `${Number(v).toFixed(1)}×`;
  if (i.u === 'M') return `M${v}`;
  if (i.u === 'Rm') return `R${v}m`;
  if (i.u === 'm') return `${v}m`;
  return v >= 1000 ? fmtN(v) : String(Math.round(v * 100) / 100);
}
