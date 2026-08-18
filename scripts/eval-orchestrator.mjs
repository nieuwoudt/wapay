#!/usr/bin/env node
/**
 * Live evaluation of the orchestration engine against the golden corpus.
 *
 * Runs every case in tests/fixtures/orchestrator-golden.json through the
 * REAL two-tier engine (OpenAI calls — needs OPENAI_API_KEY) and scores:
 *   - action accuracy (exact, with a small tolerance set per scenario id)
 *   - amountCents exactness where the scenario pins one
 *   - msisdn exactness where the scenario pins one
 *
 * Usage:
 *   set -a && source .env && set +a && node scripts/eval-orchestrator.mjs
 *   node scripts/eval-orchestrator.mjs --lang zu       # one language
 *   node scripts/eval-orchestrator.mjs --concurrency 6 # default 4
 *
 * Prints a per-language table plus every miss in detail. Exits 0 always —
 * this is an eval harness, not CI; the numbers are the deliverable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../tests/fixtures/orchestrator-golden.json', import.meta.url));

/**
 * Per-scenario tolerance: actions that are also acceptable besides the
 * canonical expectAction. Kept deliberately tight — commerce and money
 * scenarios allow nothing else.
 */
const ACCEPTABLE = {
  'data-want': ['BUY_DATA', 'LIST_CATEGORY'],
  help: ['HELP', 'LIST_PRODUCTS', 'NONE'],
  greeting: ['NONE', 'HELP', 'HOME'],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { lang: null, concurrency: 4 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang') out.lang = args[++i];
    if (args[i] === '--concurrency') out.concurrency = Number(args[++i]) || 4;
  }
  return out;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set — source .env first.');
    process.exit(1);
  }
  const { orchestrate } = await import('@wapay/ai');
  const { lang, concurrency } = parseArgs();

  const all = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const cases = lang ? all.filter((c) => c.language === lang) : all;
  console.log(`Evaluating ${cases.length} cases (concurrency ${concurrency})…\n`);

  const results = [];
  let inFlight = 0;
  let idx = 0;
  await new Promise((resolveAll) => {
    const pump = () => {
      if (idx >= cases.length && inFlight === 0) return resolveAll();
      while (inFlight < concurrency && idx < cases.length) {
        const c = cases[idx++];
        inFlight++;
        orchestrate(c.text)
          .then((r) => results.push({ c, r }))
          .catch((e) => results.push({ c, error: e.message }))
          .finally(() => {
            inFlight--;
            pump();
          });
      }
    };
    pump();
  });

  const normalize = (m) => String(m || '').replace(/^\+?27/, '0').replace(/\D/g, '');

  const perLang = new Map();
  const misses = [];
  for (const { c, r, error } of results) {
    const stats = perLang.get(c.language) || { total: 0, action: 0, slots: 0, errors: 0 };
    stats.total++;
    if (error) {
      stats.errors++;
      misses.push({ c, got: `ERROR ${error}` });
      perLang.set(c.language, stats);
      continue;
    }
    const okActions = ACCEPTABLE[c.id] || [c.expectAction];
    const actionOk = okActions.includes(r.action);
    const amountOk = c.amountCents == null || r.slots.amountCents === c.amountCents;
    const msisdnOk = c.msisdn == null || normalize(r.slots.msisdn) === normalize(c.msisdn);
    if (actionOk) stats.action++;
    if (actionOk && amountOk && msisdnOk) stats.slots++;
    else {
      misses.push({
        c,
        got: `action=${r.action} amountCents=${r.slots.amountCents} msisdn=${r.slots.msisdn} lang=${r.language} tier=${r.tier}`,
      });
    }
    perLang.set(c.language, stats);
  }

  console.log('lang | cases | action-ok | fully-ok | errors');
  console.log('-----|-------|-----------|----------|-------');
  let tTotal = 0, tAction = 0, tFull = 0, tErr = 0;
  for (const [language, s] of [...perLang.entries()].sort()) {
    console.log(
      `${language.padEnd(4)} | ${String(s.total).padEnd(5)} | ${String(s.action).padEnd(9)} | ${String(s.slots).padEnd(8)} | ${s.errors}`
    );
    tTotal += s.total; tAction += s.action; tFull += s.slots; tErr += s.errors;
  }
  console.log(
    `ALL  | ${tTotal} | ${tAction} (${((100 * tAction) / tTotal).toFixed(1)}%) | ${tFull} (${((100 * tFull) / tTotal).toFixed(1)}%) | ${tErr}`
  );

  if (misses.length) {
    console.log(`\n--- ${misses.length} misses ---`);
    for (const { c, got } of misses) {
      console.log(`[${c.language}/${c.id}] "${c.text}"\n  want ${c.expectAction}${c.amountCents ? ` amount=${c.amountCents}` : ''}${c.msisdn ? ` msisdn=${c.msisdn}` : ''}\n  got  ${got}`);
    }
  }
}

main();
