import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@amar/shared';
import { env } from './env';
import { HttpError } from './http';
import { User, type UserDoc } from './models';

/**
 * Phase 04 — identity, roles and trust.
 *
 * Reading is always anonymous: the whole public map works without an account.
 * Writing needs a token, and role checks live here in middleware rather than
 * in the UI, where they would be advisory only.
 */

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  trust: number;
  department?: string;
  wardIds: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (userId: string) =>
  jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: env.JWT_TTL as jwt.SignOptions['expiresIn'] });

/** Attaches req.user when a valid token is present, but never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();

  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as { sub?: string };
    if (!payload.sub) return next();
    const doc = await User.findById(payload.sub).lean<UserDoc & { _id: unknown }>();
    if (!doc) return next();
    req.user = {
      id: String(doc._id),
      name: doc.name,
      role: doc.role as Role,
      trust: doc.trust ?? 1,
      department: doc.department ?? undefined,
      wardIds: (doc.wardIds ?? []).map(String),
    };
  } catch {
    // An expired or forged token is treated as anonymous rather than as an
    // error, so a stale tab keeps browsing the map instead of hard-failing.
  }
  return next();
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw HttpError.unauthorized();
  return req.user;
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(HttpError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(HttpError.forbidden(`This needs the ${roles.join(' or ')} role`));
    }
    return next();
  };

// --- OTP --------------------------------------------------------------------

export const hashCode = (phone: string, code: string) =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(`${phone}:${code}`).digest('hex');

/** Six digits, uniform — crypto.randomInt, not Math.random. */
export const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// --- Rate limiting ----------------------------------------------------------

/**
 * In-memory fixed window. Phase 14 swaps the store for ElastiCache so limits
 * hold across tasks; the call sites do not change.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export const rateLimit = (opts: { windowMs: number; max: number; key?: (req: Request) => string }) => {
  const keyOf = opts.key ?? ((req: Request) => req.ip ?? 'unknown');
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.route?.path ?? req.path}:${keyOf(req)}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return next(HttpError.tooMany());
    }
    return next();
  };
};

// Keeps the map from growing without bound in a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();
