/**
 * The deterministic sweep of the daily audit (docs/audits/DAILY_AUDIT.md):
 * scripts/audit/scan-conversations.mjs as pure functions over the export of
 * lib/audit/export.js. Rules that need no judgement: a bot line that names a
 * rail production does not have, a R20 withdrawal minimum, a date promise, a
 * word about games of chance, an em dash, an internal name, an error line, a live product
 * called coming soon, a coming-soon purchase flow started, the first-link
 * example answered with a link; and the shapes of a stuck customer: the last
 * message unanswered, the same bot text three times, two clarifications in a
 * row, a reply over 1,200 characters. The pattern counts (what customers ask
 * for that is coming soon, the third gate tier, business asks) ride along.
 *
 * Every finding carries the bot line (at most 200 characters, known names
 * masked) and the customer line before it. Account ids only. Pure: no
 * database, no clock but the `now` it is given.
 */
import { isFirstLinkExample } from '../ad-flow.js';
import { maskNames } from './export.js';

export const SEVERITIES = ['P1', 'P2', 'P3'];
export const CATEGORIES = ['wrong-fact', 'money', 'security', 'stuck-loop', 'unanswered', 'menu-dump', 'contradiction', 'language', 'promise', 'business', 'onboarding', 'tone', 'other'];

export const QUOTE_CHARS = 200;
export const LONG_REPLY_CHARS = 1200;
export const UNANSWERED_AFTER_MS = 10 * 60 * 1000;
export const LOOP_TIMES = 3;

/** Bot-text rules: key -> { re, severity, category, title, why, fix }. */
export const RULES = {
  ewallet: {
    re: /eWallet|e-wallet|FNB ATM/i,
    severity: 'P1', category: 'wrong-fact',
    title: 'Names the FNB eWallet as a withdrawal method',
    why: 'Production has no eWallet rail; the live methods are PayShap and cash at an Absa or Nedbank ATM.',
    fix: 'Name only the live pay-out methods, read from the pay-out registry, never a static list.',
  },
  r20: {
    re: /\bR20\b[^.]{0,40}\b(withdraw|R3000|R3 000)|withdraw[^.]{0,60}\bR20\b|between R20 and/i,
    severity: 'P1', category: 'wrong-fact',
    title: 'Quotes a R20 withdrawal minimum',
    why: 'The live minimum is the rail floor of R50, and cash carries a customer fee.',
    fix: 'Quote the minimum from methodLimits for the method the customer chose.',
  },
  date: {
    re: /\b(within (?:\d+|a few|twenty-four|24) (?:hours?|days?)|tomorrow|next week|next month|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (?:january|february|march|april|may|june|july|august|september|october|november|december)|20\d\d)\b/i,
    severity: 'P2', category: 'promise',
    title: 'A time or date promise',
    why: 'WaPay promises no date and no delivery time; a receipt that carries a transaction date is the one allowed shape.',
    fix: 'Say what happens and what works now; never when.',
  },
  betting: {
    re: /\b(bet|bets|betting|wager|casino|odds|gambl\w*|hollywoodbets|betway|sportingbet)\b/i,
    severity: 'P1', category: 'security',
    title: 'A word about games of chance in customer copy',
    why: 'WhatsApp cannot carry that promotion in South Africa; one line risks the whole business account.',
    fix: 'Remove the word from the copy or the model prompt that produced it.',
  },
  emdash: {
    re: /[\u2014\u2013]/,
    severity: 'P3', category: 'tone',
    title: 'An em or en dash in customer copy',
    why: 'Founder style rule: no em dashes in customer-facing copy.',
    fix: 'Rewrite the line with a comma, a colon or a full stop.',
  },
  internal: {
    re: /\b(undefined|null|NaN|\[object Object\]|onboarding_step_\d|otp_register|consent_terms_|welcome_new_user)\b/,
    severity: 'P1', category: 'other',
    title: 'An internal name or a raw value leaked into the chat',
    why: 'The customer read a placeholder, a template name or a raw value instead of a sentence.',
    fix: 'Find the template or format call that produced it and give it a real value or a fallback.',
  },
  error: {
    re: /(something went wrong|try again later|an error occurred|internal error|unexpected error|failed to)/i,
    severity: 'P2', category: 'other',
    title: 'An error line reached the customer',
    why: 'A generic error is a dead end; the customer cannot tell what to do next.',
    fix: 'Say what did not happen, that nothing was charged, and one thing to do now.',
  },
  comingSoonLive: {
    re: /(send money|get paid|payment link|withdraw\w*)[^.]{0,40}coming soon/i,
    severity: 'P1', category: 'wrong-fact',
    title: 'Calls a live product coming soon',
    why: 'Send money, get paid and withdrawals are live for every customer.',
    fix: 'Read what is live from the capability registry, never from the model.',
  },
};

/** What customers ask for that is coming soon or absent, counted on user turns. */
export const COMING = {
  airtime: /\bairtime\b/i,
  data: /\b(data|bundle)\b/i,
  electricity: /\b(electricity|prepaid|meter)\b/i,
  fuel: /\b(fuel|petrol|diesel)\b/i,
  voucher: /\b(ott|voucher|1voucher|blu)\b/i,
  card: /\b(virtual card|card number|bank card)\b/i,
  instore: /\b(in-?store|till|shop|spar|shoprite|checkers|pick n pay)\b/i,
  bills: /\b(dstv|netflix|bill)\b/i,
  loan: /\b(loan|borrow|credit|lend)\b/i,
  chanceGames: /\b(bet|betway|hollywood)\b/i,
};

// The flows' own first prompts (message-processor-v2.js): a bot that sends one of
// these while the product is off for everyone has started a coming-soon purchase.
export const COMING_SOON_STARTS = {
  airtime: /How much airtime would you like to buy\?/i,
  data: /Which bundle period\?/i,
  electricity: /Please enter your meter number/i,
};

const CLARIFY = /not sure what you mean|do you mean|didn't catch|did not catch|could you rephrase/i;
const BUSINESS_ASK = /business account|my business|for my (shop|business|spaza)/i;

const clip = (t, n = QUOTE_CHARS) => String(t || '').replace(/\n/g, ' / ').slice(0, n);

function finding({ rule, account, bot, user, severity, category, title, why, fix }) {
  const names = account.privacyNames || [];
  return {
    severity, category, title,
    accountId: account.id,
    at: bot?.at || user?.at || null,
    botQuote: bot ? clip(maskNames(bot.text, names)) : '',
    userQuote: user ? clip(maskNames(user.text, names)) : '',
    why, fix, rule,
  };
}

/** The nearest user turn before index i. */
function userBefore(turns, i) {
  for (let j = i - 1; j >= 0; j--) if (turns[j].role === 'user') return turns[j];
  return null;
}

/**
 * scanExport(exportResult, { now, scope }) -> { findings, counts, patterns }
 * `scope` is lib/vas-config.js launchScope(null): the products off for everyone
 * decide the coming-soon-started rule. Without it that rule is skipped.
 */
export function scanExport(exp, { now = new Date(), scope = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const findings = [];
  const counts = {};
  const patterns = { accounts: 0, turns: 0, unanswered: 0, loops: 0, clarifyRuns: 0, gateTier3: 0, longReplies: 0, comingSoonStarted: 0, exampleEchoLinked: 0, comingSoonAsks: {}, businessAsks: 0 };
  const bump = (key) => { counts[key] = (counts[key] || 0) + 1; };

  for (const account of exp?.accounts || []) {
    const turns = account.turns || [];
    patterns.accounts += 1;
    patterns.turns += turns.length;

    // Rules on bot text, in the window only (context turns were audited by an earlier run).
    turns.forEach((t, i) => {
      if (t.role !== 'assistant' || t.context) return;
      const user = userBefore(turns, i);
      for (const [key, rule] of Object.entries(RULES)) {
        if (rule.re.test(t.text || '')) { bump(key); findings.push(finding({ rule: key, account, bot: t, user, ...rule })); }
      }
      if (scope) {
        for (const [product, re] of Object.entries(COMING_SOON_STARTS)) {
          if (scope[product] === false && re.test(t.text || '')) {
            bump('comingSoonStarted'); patterns.comingSoonStarted += 1;
            findings.push(finding({
              rule: 'comingSoonStarted', account, bot: t, user,
              severity: 'P1', category: 'wrong-fact',
              title: `Starts a ${product} purchase while ${product} is coming soon`,
              why: `${product[0].toUpperCase()}${product.slice(1)} is off for every customer; the flow should answer coming soon and what works today, never ask for an amount, a bundle or a meter.`,
              fix: 'Gate the flow entry on isCategoryEnabledForWaId before the first prompt (docs/LAUNCH_SCOPE.md section 4).',
            }));
          }
        }
      }
      if ((t.text || '').length > LONG_REPLY_CHARS) {
        bump('longReply'); patterns.longReplies += 1;
        findings.push(finding({
          rule: 'longReply', account, bot: t, user,
          severity: 'P3', category: 'tone',
          title: 'A reply over 1,200 characters',
          why: 'A wall of text on a phone screen is skipped, not read.',
          fix: 'Two lines and one question; lists only when the content is multifaceted.',
        }));
      }
    });

    // The first-link example typed back word for word, answered with a link instead of the ask (BUGLOG #126).
    turns.forEach((t, i) => {
      if (t.role !== 'user' || t.context || !isFirstLinkExample(t.text)) return;
      const next = turns.slice(i + 1).find((x) => x.role === 'assistant');
      if (!next || /my example/i.test(next.text || '')) return;
      bump('exampleEcho'); patterns.exampleEchoLinked += 1;
      findings.push(finding({
        rule: 'exampleEcho', account, bot: next, user: t,
        severity: 'P2', category: 'onboarding',
        title: 'The first-link example typed back word for word was treated as a real debt',
        why: 'The customer copied the prompt\'s example; a link for a fictional person helps nobody.',
        fix: 'Answer with the example-echo ask (lib/ad-flow.js EXAMPLE_ECHO_REPLY) before the amount parser.',
      }));
    });

    // Unanswered: the last turn is the customer's and it is older than ten minutes.
    const last = turns[turns.length - 1];
    if (last && last.role === 'user' && !last.context && nowMs - Date.parse(last.at) > UNANSWERED_AFTER_MS) {
      bump('unanswered'); patterns.unanswered += 1;
      findings.push(finding({
        rule: 'unanswered', account, bot: null, user: last,
        severity: 'P2', category: 'unanswered',
        title: 'The last customer message has no recorded reply',
        why: 'A message with no answer is a customer waiting; a reply the chat sent but never recorded looks the same (BUGLOG #120).',
        fix: 'Check the webhook log for the message; if the reply was sent, record it; if not, answer and fix the path that dropped it.',
      }));
    }

    // Loops and clarification runs over everything the account was told.
    const seen = {};
    let clar = 0;
    turns.forEach((t, i) => {
      if (t.role !== 'assistant') return;
      const k = String(t.text || '').slice(0, 160);
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] === LOOP_TIMES && !t.context) {
        bump('loop'); patterns.loops += 1;
        findings.push(finding({
          rule: 'loop', account, bot: t, user: userBefore(turns, i),
          severity: 'P2', category: 'stuck-loop',
          title: 'The same bot text sent three or more times',
          why: 'The customer is going round in a circle; a repeated line never adds the missing fact.',
          fix: 'After the second repeat say what is wrong differently, offer three concrete options, or bring in a person.',
        }));
      }
      if (CLARIFY.test(t.text || '')) {
        clar += 1;
        if (clar === 2 && !t.context) {
          bump('clarifyRun'); patterns.clarifyRuns += 1;
          findings.push(finding({
            rule: 'clarifyRun', account, bot: t, user: userBefore(turns, i),
            severity: 'P2', category: 'stuck-loop',
            title: 'Two clarifications in a row',
            why: 'Asking "what do you mean" twice means the chat has no idea; the customer is stuck.',
            fix: 'After two clarifications offer three concrete options or a person (audit 2026-10-19, open item).',
          }));
        }
      } else {
        clar = 0;
      }
      if (t.refs?.gate && Number(t.refs?.tier) >= 2 && !t.context) patterns.gateTier3 += 1;
    });

    // What customers ask for that WaPay cannot do yet, counted on the window's user turns.
    for (const t of turns) {
      if (t.role !== 'user' || t.context) continue;
      for (const [k, re] of Object.entries(COMING)) if (re.test(t.text || '')) patterns.comingSoonAsks[k] = (patterns.comingSoonAsks[k] || 0) + 1;
      if (BUSINESS_ASK.test(t.text || '')) patterns.businessAsks += 1;
    }
  }

  return { findings, counts, patterns };
}
