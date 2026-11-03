import nodemailer from 'nodemailer';

// TurboSMTP is the only mail transport (no Resend / Mailjet / Gmail). Each store
// domain is housed in one of up to three TurboSMTP accounts
// (TURBOSMTP_{n}_USER / _PASS / _DOMAINS, same vars as user-order-service) and the
// sender domain must be verified (SPF + DKIM) in that account. A domain in no
// account uses TURBOSMTP_FALLBACK_ACCOUNT if set; otherwise the send fails with
// a clear error instead of falling back to another provider.
// Kept as a local copy so admin-service stays independently deployable.

const env = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v);
};

const MAX_ACCOUNTS = 3;

const account = (n) => {
  const user = env(`TURBOSMTP_${n}_USER`).trim();
  const pass = env(`TURBOSMTP_${n}_PASS`).trim();
  if (!user || !pass) return null;
  const domains = env(`TURBOSMTP_${n}_DOMAINS`)
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
  return { n, user, pass, domains, host: env('TURBOSMTP_HOST', 'pro.turbo-smtp.com').trim(), port: Number(env('TURBOSMTP_PORT', '587')) || 587 };
};

export const resolveTurboSmtpAccount = (domain) => {
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  const accounts = [];
  for (let n = 1; n <= MAX_ACCOUNTS; n++) { const a = account(n); if (a) accounts.push(a); }
  const hit = d && accounts.find((a) => a.domains.includes(d));
  if (hit) return hit;
  const fallback = Number(env('TURBOSMTP_FALLBACK_ACCOUNT'));
  return accounts.find((a) => a.n === fallback) || null;
};

const transports = new Map();
const transportFor = (a) => {
  const key = `${a.n}:${a.host}:${a.port}:${a.user}`;
  if (!transports.has(key)) {
    transports.set(key, nodemailer.createTransport({
      host: a.host,
      port: a.port,
      secure: a.port === 465,
      auth: { user: a.user, pass: a.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    }));
  }
  return transports.get(key);
};

/** Sends via the TurboSMTP account housing `domain`. Returns { success, messageId?, error? }. */
export const sendViaTurboSmtp = async ({ domain, from, fromName, to, replyTo, subject, html, text, headers, attachments }) => {
  const a = resolveTurboSmtpAccount(domain);
  if (!a) return { success: false, error: `No TurboSMTP account configured for "${domain}"` };
  try {
    const info = await transportFor(a).sendMail({
      from: `${fromName} <${from}>`,
      to,
      replyTo: replyTo || from,
      subject,
      html,
      ...(text ? { text } : {}),
      ...(headers && typeof headers === 'object' && Object.keys(headers).length ? { headers } : {}),
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    });
    return { success: true, messageId: info?.messageId || null, transport: `turbosmtp:${a.n}` };
  } catch (e) {
    return { success: false, error: e?.response || e?.message || String(e) };
  }
};
