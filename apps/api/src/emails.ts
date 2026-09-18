import { env } from './env';

/**
 * The sign-in email. It carries both routes deliberately: a magic link for
 * whoever reads mail on the same device, and a code for whoever is signing in
 * on a phone while reading mail on a laptop. Either one works, and using one
 * invalidates the other.
 *
 * Written as inline-styled tables because that is what mail clients render.
 * No external images, no web fonts — both get stripped or blocked, and a
 * blocked image is a login email that looks broken.
 */

interface LoginEmail {
  code: string;
  magicUrl: string;
  minutes: number;
  isNewAccount: boolean;
}

const INK = '#16211c';
const INK_2 = '#4a5a52';
const INK_3 = '#74847b';
const ACCENT = '#00694c';
const LINE = '#dfe4e0';
const GROUND = '#f5f6f4';

export function loginEmail({ code, magicUrl, minutes, isNewAccount }: LoginEmail) {
  const heading = isNewAccount ? 'Confirm your email to start reporting' : 'Sign in to Amar Shohor';
  const spacedCode = code.split('').join(' ');

  const subject = `${code} is your Amar Shohor sign-in code`;

  const text = [
    heading,
    '',
    `Your code is ${code}`,
    '',
    'Or open this link to sign in directly:',
    magicUrl,
    '',
    `Both expire in ${minutes} minutes, and using either one cancels the other.`,
    'If you did not ask to sign in, you can ignore this email — nobody can',
    'get in with it unless they also have your inbox.',
    '',
    'Amar Shohor — আমার শহর',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GROUND};padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;font-family:'Helvetica Neue',Arial,sans-serif;">

    <tr><td style="padding:22px 26px 0 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:30px;height:30px;background:${ACCENT};border-radius:8px;text-align:center;vertical-align:middle;color:#ffffff;font-size:15px;font-weight:bold;line-height:30px;">◉</td>
        <td style="padding-left:10px;">
          <div style="font-size:16px;font-weight:bold;color:${INK};letter-spacing:-0.3px;">Amar Shohor</div>
          <div style="font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:${INK_3};">One city, one map</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:22px 26px 0 26px;">
      <h1 style="margin:0 0 8px 0;font-size:20px;line-height:1.25;color:${INK};font-weight:bold;">${escape(heading)}</h1>
      <p style="margin:0;font-size:14.5px;line-height:1.55;color:${INK_2};">
        Use whichever is easier — the button, or the code below it.
      </p>
    </td></tr>

    <tr><td style="padding:20px 26px 0 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td align="center" style="background:${ACCENT};border-radius:8px;">
          <a href="${escape(magicUrl)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Sign in to Amar Shohor</a>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:18px 26px 0 26px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:16px 26px 0 26px;" align="center">
      <div style="font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:${INK_3};margin-bottom:8px;">Or enter this code</div>
      <div style="font-family:'Courier New',Courier,monospace;font-size:29px;font-weight:bold;letter-spacing:7px;color:${INK};background:${GROUND};border:1px solid ${LINE};border-radius:8px;padding:13px 8px;">${escape(spacedCode)}</div>
    </td></tr>

    <tr><td style="padding:16px 26px 22px 26px;">
      <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.6;color:${INK_3};">
        Both expire in ${minutes} minutes, and using either one cancels the other.
      </p>
      <p style="margin:0;font-size:12.5px;line-height:1.6;color:${INK_3};">
        If you did not ask to sign in, ignore this email. Nobody can get in with it unless they also have your inbox.
      </p>
    </td></tr>

    <tr><td style="padding:14px 26px;background:${GROUND};border-top:1px solid ${LINE};border-radius:0 0 12px 12px;">
      <p style="margin:0;font-size:11.5px;line-height:1.5;color:${INK_3};">
        Amar Shohor — আমার শহর · Citizens report city problems, and the city sees, prioritises and resolves them.
      </p>
    </td></tr>

  </table>
  <div style="max-width:520px;padding:12px 6px 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:${INK_3};">
    If the button does not work, copy this address into your browser:<br>
    <span style="word-break:break-all;color:${INK_2};">${escape(magicUrl)}</span>
  </div>
</td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}

export const magicUrlFor = (token: string) =>
  `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/auth/magic?token=${encodeURIComponent(token)}`;

/** Escapes into HTML text/attribute context. Values here are ours, but the
 *  email is assembled by string concatenation, so nothing goes in raw. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
