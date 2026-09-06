// mailer.js — outbound transactional email (PIN setup / reset links).
//
// Uses the Resend HTTP API (https://resend.com — free tier: 3,000 emails/month,
// 100/day, one verified sender domain) via Node's global fetch, so there is no
// new npm dependency and nothing to install on the host. Any provider with a
// plain JSON "send" endpoint can be swapped in here without touching callers.
//
// Config (env):
//   RESEND_API_KEY   — enables real sending. When unset, sendMail() logs the
//                      message to the server console and reports sent:false,
//                      so local dev works with no account at all.
//   MAIL_FROM        — e.g. "SiteNav <noreply@yourdomain.com>". Must be on a
//                      domain verified in Resend. Defaults to Resend's shared
//                      onboarding sender, which only delivers to the account
//                      owner's own address — fine for a first test, not prod.
//   PUBLIC_BASE_URL  — absolute origin used to build emailed links, e.g.
//                      https://landcros-forrestdale.onrender.com. Falls back
//                      to the request's own Host header (see server.js).

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Returns { sent: boolean, id?: string }. Throws only on a provider error
// once configured — an unconfigured mailer never throws.
async function sendMail({ to, subject, text, html, attachments }) {
  if (!to || !subject || !(text || html)) throw new Error('sendMail: to, subject and text/html are required');

  if (!isConfigured()) {
    console.log(`[mailer] RESEND_API_KEY not set — email NOT sent.\n  To: ${to}\n  Subject: ${subject}\n  ${text || ''}`);
    return { sent: false };
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'SiteNav <onboarding@resend.dev>',
      to: [to],
      subject,
      text,
      html,
      // [{ filename, content: <base64> }] — Resend caps the whole message at 40 MB.
      attachments: attachments && attachments.length ? attachments : undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { sent: true, id: data.id };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The one template this app needs today. `mode` is 'setup' (first PIN) or
// 'reset' (user asked to change a PIN they forgot).
function pinLinkEmail({ to, link, mode, ttlMinutes }) {
  const isSetup = mode === 'setup';
  const subject = isSetup ? 'Set your SiteNav login PIN' : 'Reset your SiteNav login PIN';
  const intro = isSetup
    ? 'Your SiteNav account is ready. Choose a 6-digit PIN to finish signing in:'
    : 'Someone (hopefully you) asked to reset the login PIN for this address:';
  const text = [
    intro, '', link, '',
    `This link works once and expires in ${ttlMinutes} minutes.`,
    isSetup ? '' : 'If you did not request this, you can ignore this email — your current PIN still works.',
  ].join('\n');
  const html = `
    <div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:520px">
      <p>${escapeHtml(intro)}</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0F766E;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${isSetup ? 'Set my PIN' : 'Reset my PIN'}</a></p>
      <p style="color:#555;font-size:13px">Or paste this into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
      <p style="color:#555;font-size:13px">This link works once and expires in ${ttlMinutes} minutes.${isSetup ? '' : ' If you did not request this, ignore this email — your current PIN still works.'}</p>
    </div>`;
  return sendMail({ to, subject, text, html });
}

module.exports = { isConfigured, sendMail, pinLinkEmail };
