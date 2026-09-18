import nodemailer, { type Transporter } from 'nodemailer';
import { env } from './env';
import { log } from './log';

/**
 * Outbound email with account failover.
 *
 * Several sender accounts are configured; a send tries them in order and moves
 * on when one refuses. A failing account is put in a cooldown so the next
 * request does not pay its timeout again, and accounts are tried starting from
 * the last one that worked — otherwise every send re-tests a dead account
 * first.
 *
 * Consumer mail providers rate-limit hard and lock accounts without warning,
 * which is exactly why this is a pool and not a single transport. It is still
 * the wrong tool for production: phase 14 should point `SMTP_*` at SES.
 */

export interface MailAccount {
  user: string;
  pass: string;
}

interface Slot {
  account: MailAccount;
  transport: Transporter;
  /** Epoch ms until which this account is skipped after a failure. */
  cooldownUntil: number;
  failures: number;
  sent: number;
}

const COOLDOWN_MS = 5 * 60_000;

/** `user:pass,user:pass` — parsed here so the secret never appears in code. */
export function parseAccounts(raw: string): MailAccount[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // Split on the first colon only: passwords may contain one.
      const at = entry.indexOf(':');
      if (at < 1) return null;
      const user = entry.slice(0, at).trim();
      const pass = entry.slice(at + 1).trim();
      return user && pass ? { user, pass } : null;
    })
    .filter((a): a is MailAccount => a !== null);
}

const accounts = parseAccounts(env.SMTP_ACCOUNTS);

const slots: Slot[] = accounts.map((account) => ({
  account,
  transport: nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; 587 starts plaintext and upgrades with STARTTLS.
    secure: env.SMTP_PORT === 465,
    auth: { user: account.user, pass: account.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  }),
  cooldownUntil: 0,
  failures: 0,
  sent: 0,
}));

let cursor = 0;

export const mailerConfigured = () => slots.length > 0;

export interface SendResult {
  ok: boolean;
  /** Which account actually delivered it, for the audit log. */
  via?: string;
  attempts: number;
  error?: string;
}

export async function sendMail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<SendResult> {
  if (slots.length === 0) {
    return { ok: false, attempts: 0, error: 'No SMTP accounts are configured (set SMTP_ACCOUNTS).' };
  }

  const now = Date.now();
  // Start from the last account that worked, then walk the ring.
  const order = slots.map((_, i) => slots[(cursor + i) % slots.length]!);
  const ready = order.filter((slot) => slot.cooldownUntil <= now);
  // If everything is cooling down, try anyway rather than refusing to send:
  // a cooldown is a guess, and a login code nobody receives is worse.
  const queue = ready.length > 0 ? ready : order;

  let attempts = 0;
  let lastError = '';

  for (const slot of queue) {
    attempts += 1;
    try {
      await slot.transport.sendMail({
        // Most providers reject a From that is not the authenticated mailbox.
        from: `"${env.MAIL_FROM_NAME}" <${slot.account.user}>`,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      slot.sent += 1;
      slot.failures = 0;
      slot.cooldownUntil = 0;
      cursor = slots.indexOf(slot);

      log.info('mail sent', { via: slot.account.user, attempts, subject: message.subject });
      return { ok: true, via: slot.account.user, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      slot.failures += 1;
      slot.cooldownUntil = Date.now() + COOLDOWN_MS;
      log.warn('mail account failed, trying the next one', {
        account: slot.account.user,
        failures: slot.failures,
        err: lastError,
      });
    }
  }

  log.error('every mail account failed', { attempts, err: lastError });
  return { ok: false, attempts, error: lastError };
}

/**
 * Checks each account's credentials at boot so a bad password shows up in the
 * log immediately rather than the first time somebody tries to sign in.
 * Deliberately not awaited by the server start path.
 */
export async function verifyAccounts(): Promise<void> {
  if (slots.length === 0) {
    log.warn('no SMTP accounts configured — email sign-in will not work');
    return;
  }
  await Promise.all(
    slots.map(async (slot) => {
      try {
        await slot.transport.verify();
        log.info('smtp account ready', { account: slot.account.user });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        slot.cooldownUntil = Date.now() + COOLDOWN_MS;
        log.warn('smtp account rejected its credentials', {
          account: slot.account.user,
          err: message,
          // The most common cause by far, and invisible from the error text.
          hint: 'Consumer providers often require IMAP/POP access to be switched on in the mailbox settings before SMTP will authenticate.',
        });
      }
    }),
  );
}

export const mailerStatus = () =>
  slots.map((slot) => ({
    account: slot.account.user.replace(/^(.{3}).*(@.*)$/, '$1***$2'),
    sent: slot.sent,
    failures: slot.failures,
    coolingDown: slot.cooldownUntil > Date.now(),
  }));
