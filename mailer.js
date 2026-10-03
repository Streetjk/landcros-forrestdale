// mailer.js — outbound transactional email (PIN setup / reset links, hazard
// reports). Two interchangeable transports; callers never care which is live.
//
//   SMTP  — send through an ordinary mailbox (Microsoft 365, Google Workspace,
//           anything speaking SMTP). Needs no DNS access, and mail genuinely
//           originates from that real address, so internal recipients see an
//           internal sender. Use this when you cannot verify a domain.
//   Resend — https://resend.com HTTP API. Needs a domain verified in Resend
//           (DNS records), but no mailbox and no SMTP AUTH.
//
// Config (env) — set EITHER group. SMTP wins if both are present, unless
// MAIL_TRANSPORT says otherwise.
//   MAIL_TRANSPORT   — optional: 'smtp' or 'resend' to force one explicitly.
//   SMTP_HOST        — e.g. smtp.office365.com (M365) or smtp.gmail.com
//   SMTP_PORT        — default 587 (STARTTLS). 465 implies implicit TLS.
//   SMTP_USER        — the mailbox address to authenticate as
//   SMTP_PASS        — that mailbox's password or app password
//   RESEND_API_KEY   — Resend API key (re_...)
//   MAIL_FROM        — e.g. "SiteNav <noreply@example.com>". On SMTP this
//                      defaults to SMTP_USER, and most providers REQUIRE the
//                      From address to match the authenticated mailbox (or
//                      have Send As permission), so leave it unset unless you
//                      know the mailbox may send as another address. On Resend
//                      it must be on a verified domain; the default shared
//                      sender only delivers to the account owner.
//   PUBLIC_BASE_URL  — absolute origin used to build emailed links, e.g.
//                      https://your-app.koyeb.app. Falls back to the request's
//                      own Host header (see server.js).
//
// With neither transport configured, sendMail() logs the message to the server
// console and reports sent:false, so local dev works with no account at all.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function _smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// Which transport a send would actually use: 'smtp', 'resend' or null.
function transport() {
  const forced = (process.env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (forced === 'smtp') return _smtpConfigured() ? 'smtp' : null;
  if (forced === 'resend') return process.env.RESEND_API_KEY ? 'resend' : null;
  if (_smtpConfigured()) return 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}

function isConfigured() {
  return transport() !== null;
}

function _from() {
  return process.env.MAIL_FROM || (transport() === 'smtp' ? process.env.SMTP_USER : 'SiteNav <onboarding@resend.dev>');
}

// Lazily built so the module loads without nodemailer being reachable and so
// .env (read by server.js after its requires) is in place first.
let _tx = null;
function _getSmtpTransport() {
  if (!_tx) {
    const nodemailer = require('nodemailer');
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    _tx = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 465 = implicit TLS; 587 upgrades via STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _tx;
}

async function _sendViaSmtp({ to, subject, text, html, attachments }) {
  const info = await _getSmtpTransport().sendMail({
    from: _from(),
    to,
    subject,
    text,
    html,
    // Callers hand us Resend's shape ({filename, content: <base64>}); tell
    // nodemailer how to read it rather than making callers branch.
    attachments: (attachments || []).map((a) => ({ filename: a.filename, content: a.content, encoding: 'base64' })),
  });
  return { sent: true, id: info.messageId };
}

// Returns { sent: boolean, id?: string }. Throws only on a provider error
// once configured — an unconfigured mailer never throws.
async function sendMail({ to, subject, text, html, attachments }) {
  if (!to || !subject || !(text || html)) throw new Error('sendMail: to, subject and text/html are required');

  const via = transport();
  if (!via) {
    console.log(`[mailer] no transport configured (set SMTP_* or RESEND_API_KEY) — email NOT sent.\n  To: ${to}\n  Subject: ${subject}\n  ${text || ''}`);
    return { sent: false };
  }

  if (via === 'smtp') return _sendViaSmtp({ to, subject, text, html, attachments });

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: _from(),
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

module.exports = { isConfigured, transport, sendMail, pinLinkEmail };
