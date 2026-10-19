/**
 * "Close my account" (conversation audit 2026-10-19, BUGLOG #125): a customer
 * asked seven times and the model promised a "secure final step" that does not
 * exist. There is no self-service closure yet, so the chat says exactly what
 * happens (a person does it), raises the person alert once a day, and never
 * repeats a promise. Pure apart from the alert text; the processor sends.
 */
const firstNameOf = (account) => String(account?.displayName || '').trim().split(/\s+/)[0] || '';

export function matchCloseAccountAsk(text) {
  const t = String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120) return false;
  if (/\b(open|opening|create|start|register)\b/.test(t)) return false;
  return /\b(close|closing|delete|deleting|deactivate|remove|terminate|cancel)\s+(my\s+|the\s+|this\s+)?(wapay\s+)?(account|profile)\b/.test(t)
    || /\baccount\s+(closure|deletion|closed|deleted)\b/.test(t)
    || /^(close|delete) account$/.test(t);
}

export function closeAccountReply({ alerted = false } = {}) {
  const head = 'I can close your WaPay account. There is no self-service way to do it: a person from the WaPay team does it';
  const who = alerted ? ', they have been asked now, and they will confirm here when it is done.' : '. I will tell them, and they will confirm here when it is done.';
  return `${head}${who} Your balance stays yours until then and nothing else changes. If you only meant to cancel a payment link, say *cancel link*.`;
}

/** The ops alert: references and masks only, like the withdraw gate's. */
export function closeAccountAlert({ account, balanceCents = null } = {}) {
  const tail = String(account?.waId || account?.msisdn || '').replace(/\D/g, '').slice(-4);
  const name = firstNameOf(account) || 'A customer';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bal = balanceCents == null ? 'not read' : `R${(balanceCents / 100).toFixed(2)}`;
  const text = [
    `🗂️ ${name} asked to close their WaPay account.`,
    `Account ${account?.id || '?'}, WhatsApp •••${tail}, display name ${firstNameOf(account) || '(none)'}. Balance: ${bal}.`,
    'The chat said a person will close it and confirm. There is no self-service closure: settle any balance, mark the account closed from Mission Control or the database, then confirm to them from the business inbox.',
  ].join('\n');
  return {
    text,
    subject: `${name} asked to close their account`,
    detailsHtml: `<p>Account <code>${esc(account?.id || '?')}</code>, WhatsApp •••${esc(tail)}, display name ${esc(firstNameOf(account) || '(none)')}. Balance: ${esc(bal)}.</p><p>The chat said a person will close it and confirm. There is no self-service closure yet.</p>`,
  };
}
