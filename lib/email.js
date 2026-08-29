/**
 * WaPay email (Resend) — UniFuel's proven pattern (result-object contract,
 * never throws, inline HTML) on WaPay's OWN identity: WaPay branding, WaPay
 * domain, WaPay API key. Never send WaPay mail from the UniFuel identity.
 *
 * Uses Resend's REST API directly (same raw-fetch idiom as lib/localize.js)
 * so no new dependency rides into the serverless bundle.
 *
 * Env:
 *   RESEND_API_KEY    — WaPay's own Resend key (NOT UniFuel's)
 *   WAPAY_EMAIL_FROM  — default `WaPay <noreply@wapay.co.za>`; the domain
 *                       must be verified in WaPay's Resend account first
 *                       (founder action — until then sends fail cleanly)
 *   ALERT_EMAIL       — ops alert destination (low float, reconcile-required)
 *
 * First consumers are OPS alerts; customer-facing email waits for the
 * verified domain. Bearer secrets (wiCodes, voucher PINs) must never be
 * emailed to ops — reference codes only.
 */

const FROM = () => process.env.WAPAY_EMAIL_FROM || 'WaPay <noreply@wapay.co.za>';

export function isEmailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Send one email. Resolves `{ success, messageId?, error? }` — never throws
 * (the UniFuel contract; callers branch on `.success`, BUGLOG #24 lesson:
 * catch-based fallbacks around senders that resolve are dead code).
 */
export async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY not set' };
  if (!to || !subject || !html) return { success: false, error: 'to/subject/html required' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({ from: FROM(), to: [to], subject, html }),
    });
    clearTimeout(timer);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { success: false, error: data?.message || `HTTP ${resp.status}` };
    }
    return { success: true, messageId: data?.id || null };
  } catch (error) {
    return { success: false, error: String(error?.message || error).slice(0, 200) };
  }
}

/** Minimal WaPay-branded shell for transactional/ops mail. */
export function wapayEmailHtml({ title, bodyHtml }) {
  return (
    `<div style="background:#f4f6f4;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8e2">` +
    `<div style="background:#1d7a3f;color:#ffffff;padding:18px 24px;font-size:18px;font-weight:700">WaPay</div>` +
    `<div style="padding:24px">` +
    `<div style="font-size:16px;font-weight:600;color:#14512c;margin-bottom:12px">${title}</div>` +
    `<div style="font-size:14px;color:#333;line-height:1.55">${bodyHtml}</div>` +
    `</div>` +
    `<div style="padding:14px 24px;border-top:1px solid #eef2ee;font-size:11px;color:#8a948a">WaPay · WhatsApp wallet for South Africa</div>` +
    `</div></div>`
  );
}

/**
 * Ops alert to ALERT_EMAIL. Best-effort; logs the outcome. Never include a
 * bearer secret in `detailsHtml` — references only.
 */
export async function sendOpsAlert({ subject, detailsHtml }) {
  const to = process.env.ALERT_EMAIL;
  if (!to) return { success: false, error: 'ALERT_EMAIL not set' };
  const result = await sendEmail({
    to,
    subject: `[WaPay ops] ${subject}`,
    html: wapayEmailHtml({ title: subject, bodyHtml: detailsHtml }),
  });
  console.log(JSON.stringify({ type: 'ops_alert_email', subject, ok: result.success, error: result.error || null }));
  return result;
}
