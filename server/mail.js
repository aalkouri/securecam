// Outgoing email through Resend's HTTP API (no dependency needed).
import { config, mailEnabled, mailLog } from './config.js';

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// One short message with a single link. Returns true when Resend accepted it.
export async function sendLinkEmail({ to, subject, intro, linkText, link, outro }) {
  if (!mailEnabled) return false;
  if (mailLog) {
    console.log(`[MAIL_LOG] to=${to} subject="${subject}" link=${link}`);
    return true;
  }
  const text = `${intro}\n\n${linkText}: ${link}\n\n${outro}`;
  const html = `<p>${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(link)}">${escapeHtml(linkText)}</a></p>
<p>${escapeHtml(outro)}</p>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.warn(`Email not sent (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.warn(`Email not sent: ${err.message}`);
    return false;
  }
}
