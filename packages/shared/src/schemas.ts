import { z } from 'zod';
import { CATEGORIES, ROLES, STATUSES } from './domain';

/**
 * Zod is the single source of truth for request and response shapes. The API
 * validates with these; the web app infers its TypeScript types from the same
 * objects, so a field can never drift between the two.
 */

export const lngLat = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

export const geoPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: lngLat,
});

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter an email address that looks like name@example.com')
  .max(254);

/**
 * Email sign-in. One request issues both a six-digit code and a magic link;
 * either one signs the person in, and using one cancels the other.
 */
export const emailRequestSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(60).optional(),
});

export const emailVerifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'The code is six digits'),
  name: z.string().trim().min(2).max(60).optional(),
});

export const magicConsumeSchema = z.object({
  token: z.string().trim().min(20, 'That sign-in link looks incomplete').max(512),
});

export const createReportSchema = z.object({
  category: z.enum(CATEGORIES),
  /** Optional: the vision model fills it in when the citizen skips it. */
  severity: z.number().int().min(1).max(5).optional(),
  description: z.string().trim().max(1000).optional(),
  location: geoPointSchema,
  /** Metres of GPS uncertainty the browser reported, kept for integrity checks. */
  accuracy: z.number().min(0).max(10_000).optional(),
  photoIds: z.array(z.string().min(1)).min(1, 'A photo is required').max(4),
  /** Set when the citizen tapped an existing issue instead of filing a new one. */
  confirmsIssueId: z.string().optional(),
  /** True when the report was queued offline and flushed later (phase 05). */
  queuedOffline: z.boolean().optional(),
  capturedAt: z.coerce.date().optional(),
});

export const issueQuerySchema = z.object({
  /** Viewport as "west,south,east,north" — the map never asks for the whole city. */
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
    .optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  ward: z.string().optional(),
  band: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  since: z.coerce.date().optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(['priority', 'newest', 'oldest', 'reports']).default('priority'),
  limit: z.coerce.number().int().min(1).max(500).default(120),
  cursor: z.string().optional(),
});

export const verifySchema = z.object({
  vote: z.enum(['confirm', 'dispute']),
  /** Proximity-gated: the server checks this against the issue location. */
  at: geoPointSchema,
  note: z.string().trim().max(300).optional(),
});

export const statusChangeSchema = z.object({
  to: z.enum(STATUSES),
  note: z.string().trim().min(3, 'A note is required on every status change').max(600),
  /** Required by the server when moving to resolved (phase 13). */
  proofPhotoIds: z.array(z.string()).max(4).optional(),
  assigneeId: z.string().optional(),
});

export const mergeDecisionSchema = z.object({
  reportId: z.string().min(1),
  action: z.enum(['merge', 'split', 'reject']),
  targetIssueId: z.string().optional(),
  note: z.string().trim().max(300).optional(),
});

export const updateRoleSchema = z.object({
  role: z.enum(ROLES),
  department: z.string().optional(),
  wardIds: z.array(z.string()).optional(),
});

export type EmailRequestInput = z.infer<typeof emailRequestSchema>;
export type EmailVerifyInput = z.infer<typeof emailVerifySchema>;
export type CreateReportInput = z.infer<typeof createReportSchema>;
export type IssueQuery = z.infer<typeof issueQuerySchema>;
export type VerifyInput = z.infer<typeof verifySchema>;
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;
export type MergeDecisionInput = z.infer<typeof mergeDecisionSchema>;
