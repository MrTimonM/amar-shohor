import crypto from 'node:crypto';
import { Router } from 'express';
import { emailRequestSchema, emailVerifySchema, magicConsumeSchema } from '@amar/shared';
import { generateCode, hashCode, rateLimit, requireUser, signToken } from '../auth';
import { loginEmail, magicUrlFor } from '../emails';
import { env } from '../env';
import { HttpError, parse, route } from '../http';
import { log } from '../log';
import { mailerConfigured, sendMail } from '../mailer';
import { LoginChallenge, User, type UserDoc } from '../models';
import { me as serializeMe } from '../serialize';

/**
 * Phase 04 — sign-in.
 *
 * Passwordless, because the citizen this product is for will not create and
 * remember a password, and a forgotten password is a citizen who stops
 * reporting.
 *
 * One email carries two routes: a six-digit code and a magic link. That is not
 * indecision — someone reading mail on the same device taps the link, while
 * someone signing in on a phone with their mail open on a laptop types the
 * code. Using either one consumes the challenge, so the other immediately
 * stops working: a link still live after the code was used is a second,
 * quieter way in.
 */
export const authRouter = Router();

const MAX_ATTEMPTS = 5;
const ttlMs = () => env.LOGIN_CODE_TTL_MINUTES * 60_000;

/** Magic tokens are opaque, 32 bytes of CSPRNG, and stored only as a hash. */
const newMagicToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token: string) =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(`magic:${token}`).digest('hex');

/** Never log a whole address. */
const maskEmail = (email: string) => email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
// --- email ------------------------------------------------------------------

authRouter.post(
  '/email/request',
  rateLimit({ windowMs: 10 * 60_000, max: 5, key: (req) => String(req.body?.email ?? req.ip) }),
  route(async (req, res) => {
    const { email, name } = parse(emailRequestSchema, req.body);

    if (!mailerConfigured()) {
      throw new HttpError(
        503,
        'mail_unconfigured',
        'Sign-in is not set up on this server yet: no mail sender is configured.',
      );
    }

    const code = generateCode();
    const magicToken = newMagicToken();
    const isNewAccount = !(await User.exists({ email }));

    await LoginChallenge.deleteMany({ identifier: email, consumedAt: { $exists: false } });
    await LoginChallenge.create({
      identifier: email,
      codeHash: hashCode(email, code),
      magicHash: hashToken(magicToken),
      requestedName: name,
      expiresAt: new Date(Date.now() + ttlMs()),
      requestedIp: req.ip,
    });

    const magicUrl = magicUrlFor(magicToken);
    const message = loginEmail({
      code,
      magicUrl,
      minutes: env.LOGIN_CODE_TTL_MINUTES,
      isNewAccount,
    });

    const result = await sendMail({ to: email, ...message });

    if (!result.ok) {
      // Every sender account failed. Say so plainly instead of leaving someone
      // waiting for a mail that is never coming.
      log.error('login email could not be delivered', { to: maskEmail(email), attempts: result.attempts });
      throw new HttpError(
        502,
        'mail_failed',
        'We could not send that email — every sending account refused it. Try again in a few minutes.',
      );
    }

    log.info('login email sent', { to: maskEmail(email), via: result.via, attempts: result.attempts, isNewAccount });

    res.json({
      sent: true,
      expiresInSeconds: ttlMs() / 1000,
      isNewAccount,
    });
  }),
);

authRouter.post(
  '/email/verify',
  rateLimit({ windowMs: 10 * 60_000, max: 10, key: (req) => String(req.body?.email ?? req.ip) }),
  route(async (req, res) => {
    const { email, code, name } = parse(emailVerifySchema, req.body);
    const challenge = await consumeCode(email, code);
    // Whatever was typed on the code screen wins; otherwise fall back to the
    // name given when the email was requested.
    const user = await upsertUser(email, name ?? challenge.requestedName);
    res.json({ token: signToken(String(user._id)), user: serializeMe(user) });
  }),
);

/**
 * The magic link lands on the web app, which POSTs the token here. The token
 * never becomes the session: it is exchanged for a JWT once and then dead.
 */
authRouter.post(
  '/magic/consume',
  rateLimit({ windowMs: 10 * 60_000, max: 20 }),
  route(async (req, res) => {
    const { token } = parse(magicConsumeSchema, req.body);

    const challenge = await LoginChallenge.findOne({ magicHash: hashToken(token) });

    if (!challenge) throw HttpError.badRequest('That sign-in link is not valid. Ask for a new one.');
    if (challenge.consumedAt) {
      throw HttpError.conflict('That link has already been used. Ask for a new one if you need to sign in again.');
    }
    if (challenge.expiresAt.valueOf() < Date.now()) {
      throw HttpError.badRequest('That sign-in link has expired. Ask for a new one.');
    }

    challenge.consumedAt = new Date();
    challenge.consumedBy = 'link';
    await challenge.save();

    const user = await upsertUser(challenge.identifier, challenge.requestedName);
    log.info('signed in by magic link', { to: maskEmail(challenge.identifier) });

    res.json({ token: signToken(String(user._id)), user: serializeMe(user) });
  }),
);

// --- me ---------------------------------------------------------------------

authRouter.get(
  '/me',
  route(async (req, res) => {
    const auth = requireUser(req);
    const user = await User.findById(auth.id).lean<UserDoc & { _id: unknown }>();
    if (!user) throw HttpError.notFound('That account no longer exists');
    res.json(serializeMe(user));
  }),
);

// --- shared helpers ---------------------------------------------------------

/**
 * Checks a six-digit code and marks the challenge used. Wrong codes increment
 * an attempt counter rather than being retryable forever — six digits is only
 * a million guesses.
 */
async function consumeCode(identifier: string, code: string) {
  const challenge = await LoginChallenge.findOne({
    identifier,
    consumedAt: { $exists: false },
  }).sort({ expiresAt: -1 });

  if (!challenge) throw HttpError.badRequest('That code has expired. Ask for a new one.');
  if (challenge.expiresAt.valueOf() < Date.now()) {
    throw HttpError.badRequest('That code has expired. Ask for a new one.');
  }
  if ((challenge.attempts ?? 0) >= MAX_ATTEMPTS) {
    throw HttpError.tooMany('Too many wrong codes. Ask for a new one.');
  }

  if (challenge.codeHash !== hashCode(identifier, code)) {
    challenge.attempts = (challenge.attempts ?? 0) + 1;
    await challenge.save();
    throw HttpError.badRequest("That code doesn't match. Check the digits and try again.");
  }

  challenge.consumedAt = new Date();
  challenge.consumedBy = 'code';
  await challenge.save();
  return challenge;
}

/** Finds or creates the account behind a verified email address. */
async function upsertUser(email: string, name?: string) {
  let user = await User.findOne({ email });

  if (!user) {
    user = await User.create({
      email,
      emailVerifiedAt: new Date(),
      // A person can rename themselves later; a blank name would be worse than
      // a generic one on a public problem page.
      name: name?.trim() || fallbackName(email),
      role: 'citizen',
      trust: 1,
    });
    log.info('user registered', { id: String(user._id) });
  } else {
    if (!user.emailVerifiedAt) user.emailVerifiedAt = new Date();
    // Only fill in a name that was never set: never overwrite a real one.
    if (name && (user.name === 'Citizen' || !user.name)) user.name = name.trim();
  }

  user.lastSeenAt = new Date();
  await user.save();
  return user.toObject() as UserDoc & { _id: unknown };
}

/** `rafiq@example.com` → `Rafiq`, so the first problem page is not "Citizen". */
function fallbackName(email: string): string {
  const local = email.split('@')[0] ?? '';
  const cleaned = local.replace(/[._\-+\d]+/g, ' ').trim();
  if (cleaned.length >= 2) {
    return cleaned
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .slice(0, 60);
  }
  return 'Citizen';
}
