// apps/api/src/index.ts
import path3 from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

// packages/shared/src/domain.ts
var CATEGORIES = [
  "road_damage",
  "waterlogging",
  "garbage",
  "streetlight",
  "traffic_signal",
  "sidewalk",
  "congestion",
  "environmental"
];
var DEPARTMENTS = ["roads", "water", "waste", "electrical", "traffic", "environment"];
var CATEGORY_META = {
  road_damage: { en: "Damaged road or pothole", bn: "\u09AD\u09BE\u0999\u09BE \u09B0\u09BE\u09B8\u09CD\u09A4\u09BE \u09AC\u09BE \u0997\u09B0\u09CD\u09A4", department: "roads", slaHours: 168, hazard: true },
  waterlogging: { en: "Waterlogging or drainage", bn: "\u099C\u09B2\u09BE\u09AC\u09A6\u09CD\u09A7\u09A4\u09BE \u09AC\u09BE \u09A8\u09B0\u09CD\u09A6\u09AE\u09BE", department: "water", slaHours: 72, hazard: true },
  garbage: { en: "Garbage accumulation", bn: "\u0986\u09AC\u09B0\u09CD\u099C\u09A8\u09BE\u09B0 \u09B8\u09CD\u09A4\u09C2\u09AA", department: "waste", slaHours: 48, hazard: false },
  streetlight: { en: "Broken streetlight", bn: "\u09A8\u09B7\u09CD\u099F \u09B8\u09A1\u09BC\u0995 \u09AC\u09BE\u09A4\u09BF", department: "electrical", slaHours: 120, hazard: true },
  traffic_signal: { en: "Damaged traffic signal", bn: "\u09A8\u09B7\u09CD\u099F \u099F\u09CD\u09B0\u09BE\u09AB\u09BF\u0995 \u09B8\u09BF\u0997\u09A8\u09CD\u09AF\u09BE\u09B2", department: "traffic", slaHours: 24, hazard: true },
  sidewalk: { en: "Sidewalk damage", bn: "\u09AB\u09C1\u099F\u09AA\u09BE\u09A4 \u0995\u09CD\u09B7\u09A4\u09BF\u0997\u09CD\u09B0\u09B8\u09CD\u09A4", department: "roads", slaHours: 240, hazard: false },
  congestion: { en: "Traffic congestion", bn: "\u09AF\u09BE\u09A8\u099C\u099F", department: "traffic", slaHours: 336, hazard: false },
  environmental: { en: "Environmental hazard", bn: "\u09AA\u09B0\u09BF\u09AC\u09C7\u09B6\u0997\u09A4 \u099D\u09C1\u0981\u0995\u09BF", department: "environment", slaHours: 48, hazard: true }
};
var STATUSES = ["reported", "verified", "assigned", "in_progress", "resolved", "rejected"];
var TRANSITIONS = {
  reported: ["verified", "rejected"],
  verified: ["assigned", "rejected"],
  assigned: ["in_progress", "verified", "rejected"],
  in_progress: ["resolved", "assigned"],
  // A citizen who reopens a fix that did not hold sends it back to assigned.
  resolved: ["assigned"],
  rejected: []
};
function canTransition(from, to) {
  return TRANSITIONS[from].includes(to);
}
var ROLES = ["citizen", "verifier", "authority", "admin"];

// packages/shared/src/geo.ts
var EARTH_RADIUS_M = 6371e3;
var toRad = (deg) => deg * Math.PI / 180;
function distanceMeters(a, b) {
  const [lng1, lat1] = a.coordinates;
  const [lng2, lat2] = b.coordinates;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// packages/shared/src/priority.ts
var PRIORITY_WEIGHTS = {
  severity: 32,
  reports: 24,
  density: 14,
  age: 18,
  hazard: 12
};
var DENSITY_CEILING = 45e3;
var AGE_CEILING_HOURS = 30 * 24;
var REPORTS_CEILING = 12;
var clamp01 = (n) => Math.max(0, Math.min(1, n));
function computePriority(input) {
  const meta = CATEGORY_META[input.category];
  const severityValue = clamp01((input.severity - 1) / 4);
  const reportsValue = clamp01(Math.log2(Math.max(1, input.reportCount)) / Math.log2(REPORTS_CEILING));
  const densityValue = clamp01(input.wardDensity / DENSITY_CEILING);
  const ageValue = clamp01(input.ageHours / AGE_CEILING_HOURS);
  const hazardValue = meta.hazard ? 1 : 0;
  const factors = [
    {
      key: "severity",
      label: "How bad it is",
      value: severityValue,
      weight: PRIORITY_WEIGHTS.severity,
      points: severityValue * PRIORITY_WEIGHTS.severity,
      detail: `Severity ${input.severity} of 5`
    },
    {
      key: "reports",
      label: "How many people reported it",
      value: reportsValue,
      weight: PRIORITY_WEIGHTS.reports,
      points: reportsValue * PRIORITY_WEIGHTS.reports,
      detail: input.reportCount === 1 ? "1 report" : `${input.reportCount} reports merged`
    },
    {
      key: "density",
      label: "How many people it affects",
      value: densityValue,
      weight: PRIORITY_WEIGHTS.density,
      points: densityValue * PRIORITY_WEIGHTS.density,
      detail: `${Math.round(input.wardDensity).toLocaleString("en-US")} people per km\xB2 in this ward`
    },
    {
      key: "age",
      label: "How long it has been open",
      value: ageValue,
      weight: PRIORITY_WEIGHTS.age,
      points: ageValue * PRIORITY_WEIGHTS.age,
      detail: describeAge(input.ageHours)
    },
    {
      key: "hazard",
      label: "Safety risk",
      value: hazardValue,
      weight: PRIORITY_WEIGHTS.hazard,
      points: hazardValue * PRIORITY_WEIGHTS.hazard,
      detail: meta.hazard ? "This category can cause injury" : "Not flagged as a safety risk"
    }
  ];
  const score = Math.round(factors.reduce((sum, f) => sum + f.points, 0));
  return { score, band: bandFor(score), factors };
}
function bandFor(score) {
  if (score >= 70) return "critical";
  if (score >= 50) return "high";
  if (score >= 30) return "medium";
  return "low";
}
function describeAge(hours) {
  if (hours < 24) return `Open ${Math.max(1, Math.round(hours))} hour${Math.round(hours) === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `Open ${days} day${days === 1 ? "" : "s"}`;
}

// packages/shared/src/schemas.ts
import { z } from "zod";
var lngLat = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90)
]);
var geoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: lngLat
});
var emailSchema = z.string().trim().toLowerCase().email("Enter an email address that looks like name@example.com").max(254);
var emailRequestSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(60).optional()
});
var emailVerifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, "The code is six digits"),
  name: z.string().trim().min(2).max(60).optional()
});
var magicConsumeSchema = z.object({
  token: z.string().trim().min(20, "That sign-in link looks incomplete").max(512)
});
var createReportSchema = z.object({
  category: z.enum(CATEGORIES),
  /** Optional: the vision model fills it in when the citizen skips it. */
  severity: z.number().int().min(1).max(5).optional(),
  description: z.string().trim().max(1e3).optional(),
  location: geoPointSchema,
  /** Metres of GPS uncertainty the browser reported, kept for integrity checks. */
  accuracy: z.number().min(0).max(1e4).optional(),
  photoIds: z.array(z.string().min(1)).min(1, "A photo is required").max(4),
  /** Set when the citizen tapped an existing issue instead of filing a new one. */
  confirmsIssueId: z.string().optional(),
  /** True when the report was queued offline and flushed later (phase 05). */
  queuedOffline: z.boolean().optional(),
  capturedAt: z.coerce.date().optional()
});
var issueQuerySchema = z.object({
  /** Viewport as "west,south,east,north" — the map never asks for the whole city. */
  bbox: z.string().regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/).optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  ward: z.string().optional(),
  band: z.enum(["critical", "high", "medium", "low"]).optional(),
  since: z.coerce.date().optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["priority", "newest", "oldest", "reports"]).default("priority"),
  limit: z.coerce.number().int().min(1).max(500).default(120),
  cursor: z.string().optional()
});
var verifySchema = z.object({
  vote: z.enum(["confirm", "dispute"]),
  /** Proximity-gated: the server checks this against the issue location. */
  at: geoPointSchema,
  note: z.string().trim().max(300).optional()
});
var statusChangeSchema = z.object({
  to: z.enum(STATUSES),
  note: z.string().trim().min(3, "A note is required on every status change").max(600),
  /** Required by the server when moving to resolved (phase 13). */
  proofPhotoIds: z.array(z.string()).max(4).optional(),
  assigneeId: z.string().optional()
});
var mergeDecisionSchema = z.object({
  reportId: z.string().min(1),
  action: z.enum(["merge", "split", "reject"]),
  targetIssueId: z.string().optional(),
  note: z.string().trim().max(300).optional()
});
var updateRoleSchema = z.object({
  role: z.enum(ROLES),
  department: z.string().optional(),
  wardIds: z.array(z.string()).optional()
});

// apps/api/src/env.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";
import { z as z2 } from "zod";
var here = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile({ path: path.resolve(here, "..", ".env") });
loadEnvFile({ path: path.resolve(here, "..", "..", "..", ".env") });
var envBool = (fallback) => z2.string().optional().transform((raw) => {
  if (raw === void 0 || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
});
var schema = z2.object({
  NODE_ENV: z2.enum(["development", "test", "production"]).default("development"),
  PORT: z2.coerce.number().int().default(4e3),
  API_PUBLIC_URL: z2.string().url().default("http://localhost:4000"),
  WEB_ORIGIN: z2.string().default("http://localhost:5173"),
  MONGO_URL: z2.string().min(1).default("mongodb://localhost:27017/amar_shohor"),
  JWT_SECRET: z2.string().min(16, "JWT_SECRET must be at least 16 characters").default("dev-only-secret-do-not-ship"),
  JWT_TTL: z2.string().default("7d"),
  WEB_PUBLIC_URL: z2.string().url().default("http://localhost:5173"),
  // Email sign-in. SMTP_ACCOUNTS is `user:pass,user:pass` — several senders,
  // tried in order, because consumer mailboxes rate-limit and lock without
  // warning. Phase 14 points this at SES instead.
  SMTP_HOST: z2.string().default(""),
  SMTP_PORT: z2.coerce.number().int().default(587),
  SMTP_ACCOUNTS: z2.string().default(""),
  MAIL_FROM_NAME: z2.string().default("Amar Shohor"),
  LOGIN_CODE_TTL_MINUTES: z2.coerce.number().int().min(2).max(60).default(15),
  // Seeded staff accounts get these addresses so the authority and admin roles
  // can actually be signed into. Kept in the environment, not in the seed
  // script, because they are real mailboxes.
  SEED_ADMIN_EMAIL: z2.string().default(""),
  SEED_STAFF_EMAILS: z2.string().default(""),
  STORAGE_DRIVER: z2.enum(["local", "s3"]).default("local"),
  S3_BUCKET: z2.string().optional(),
  S3_REGION: z2.string().default("ap-southeast-1"),
  S3_ENDPOINT: z2.string().optional(),
  AI_SERVICE_URL: z2.string().default("http://localhost:8000"),
  AI_ENABLED: envBool(true),
  DEDUP_AUTO_MERGE: z2.coerce.number().min(0).max(1).default(0.72),
  DEDUP_REVIEW: z2.coerce.number().min(0).max(1).default(0.5),
  DEDUP_RADIUS_M: z2.coerce.number().default(120),
  DEDUP_WINDOW_DAYS: z2.coerce.number().default(45),
  VERIFY_THRESHOLD: z2.coerce.number().default(3),
  VERIFY_PROXIMITY_M: z2.coerce.number().default(400)
});
var parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  console.error(`Configuration is invalid:
${lines.join("\n")}

Copy .env.example to .env and fill it in.`);
  process.exit(1);
}
var env = parsed.data;
var isProd = env.NODE_ENV === "production";
if (isProd && env.JWT_SECRET === "dev-only-secret-do-not-ship") {
  console.error("Refusing to start in production with the development JWT secret.");
  process.exit(1);
}

// apps/api/src/log.ts
var ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
var MIN = ORDER[env.NODE_ENV === "development" ? "debug" : "info"];
function emit(level, msg, fields) {
  if (ORDER[level] < MIN) return;
  const line = { ts: (/* @__PURE__ */ new Date()).toISOString(), level, msg, ...fields };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}
`);
}
var log = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields)
};

// apps/api/src/ai.ts
var AI_TIMEOUT_MS = 6e3;
async function analysePhoto(input) {
  if (!env.AI_ENABLED) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/v1/analyse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_url: input.imageUrl,
        reported_category: input.reportedCategory ?? null,
        description: input.description ?? null
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      log.warn("ai service returned an error", { status: res.status });
      return null;
    }
    const body = await res.json();
    if (!CATEGORIES.includes(body.category)) {
      log.warn("ai service returned an unknown category", { category: body.category });
      return null;
    }
    return {
      model: body.model,
      category: body.category,
      categoryConfidence: body.category_confidence,
      severity: body.severity,
      relevant: body.relevant,
      embedding: body.embedding ?? [],
      integrity: {
        screenshotSuspected: body.integrity?.screenshot_suspected ?? false,
        reusedImage: body.integrity?.reused_image ?? false
      }
    };
  } catch (err) {
    log.debug("ai service unreachable", { err: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function aiHealth() {
  if (!env.AI_ENABLED) return { up: false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${env.AI_SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { up: false };
    const body = await res.json();
    return { up: true, models: body.models };
  } catch {
    return { up: false };
  }
}
var pending = [];
var running = 0;
var CONCURRENCY = 2;
function enqueue(name, job) {
  pending.push(async () => {
    const started = Date.now();
    try {
      await job();
      log.debug("job done", { job: name, ms: Date.now() - started });
    } catch (err) {
      log.error("job failed", { job: name, err: String(err) });
    }
  });
  drain();
}
function drain() {
  while (running < CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    if (!job) return;
    running += 1;
    void job().finally(() => {
      running -= 1;
      drain();
    });
  }
}
var queueDepth = () => pending.length + running;
function cosine(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function meanVector(vectors) {
  const usable = vectors.filter((v) => v.length > 0);
  const first = usable[0];
  if (!first) return void 0;
  const out = new Array(first.length).fill(0);
  for (const v of usable) {
    if (v.length !== out.length) continue;
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return void 0;
  return out.map((x) => x / norm);
}

// apps/api/src/auth.ts
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

// apps/api/src/http.ts
import { ZodError } from "zod";
var HttpError = class _HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
  static badRequest = (msg, fields) => new _HttpError(400, "bad_request", msg, fields);
  static unauthorized = (msg = "Sign in to continue") => new _HttpError(401, "unauthorized", msg);
  static forbidden = (msg = "You do not have access to this") => new _HttpError(403, "forbidden", msg);
  static notFound = (msg = "Not found") => new _HttpError(404, "not_found", msg);
  static conflict = (msg) => new _HttpError(409, "conflict", msg);
  static tooMany = (msg = "Too many attempts. Wait a minute and try again.") => new _HttpError(429, "rate_limited", msg);
};
var route = (fn) => (req, res, next) => {
  fn(req, res).catch(next);
};
function parse(schema2, data) {
  try {
    return schema2.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const fields = {};
      for (const issue of err.issues) {
        const key = issue.path.join(".") || "_";
        if (!fields[key]) fields[key] = issue.message;
      }
      throw HttpError.badRequest("Some fields need fixing", fields);
    }
    throw err;
  }
}
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message, fields: err.fields });
    return;
  }
  if (typeof err === "object" && err && err.code === 11e3) {
    res.status(409).json({ error: "conflict", message: "That already exists" });
    return;
  }
  log.error("unhandled error", { path: req.path, method: req.method, err: String(err), stack: err?.stack });
  res.status(500).json({ error: "internal", message: "Something broke on our side. Try again in a moment." });
}
var REF_ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXZ";
function makeRef(prefix) {
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return `${prefix}-${out}`;
}

// apps/api/src/models.ts
import mongoose, { Schema } from "mongoose";
var geoPoint = {
  type: { type: String, enum: ["Point"], required: true, default: "Point" },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator: (v) => v.length === 2,
      message: "coordinates must be [lng, lat]"
    }
  }
};
var photoSchema = new Schema(
  {
    id: { type: String, required: true },
    key: { type: String, required: true },
    url: { type: String, required: true },
    thumbUrl: { type: String, required: true },
    width: Number,
    height: Number,
    bytes: Number,
    exif: {
      capturedAt: Date,
      lat: Number,
      lng: Number,
      make: String,
      model: String
    }
  },
  { _id: false }
);
var wardSchema = new Schema(
  {
    name: { type: String, required: true },
    nameBn: { type: String, required: true },
    cityCorporation: { type: String, required: true },
    densityPerKm2: { type: Number, required: true },
    center: geoPoint,
    boundary: {
      type: { type: String, enum: ["Polygon"], default: "Polygon" },
      coordinates: { type: [[[Number]]] }
    }
  },
  { timestamps: true }
);
wardSchema.index({ boundary: "2dsphere" });
wardSchema.index({ center: "2dsphere" });
var userSchema = new Schema(
  {
    // Sparse, because most accounts have no phone number at all and a plain
    // `unique` index would collide every such row on null.
    phone: { type: String, unique: true, sparse: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerifiedAt: Date,
    name: { type: String, required: true },
    role: { type: String, enum: ROLES, default: "citizen", index: true },
    department: { type: String, enum: DEPARTMENTS },
    wardIds: [{ type: Schema.Types.ObjectId, ref: "Ward" }],
    trust: { type: Number, default: 1, min: 0, max: 5 },
    reportCount: { type: Number, default: 0 },
    verifiedCount: { type: Number, default: 0 },
    lastSeenAt: Date
  },
  { timestamps: true }
);
var loginChallengeSchema = new Schema({
  identifier: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  magicHash: { type: String, index: true },
  requestedName: String,
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  consumedAt: Date,
  consumedBy: { type: String, enum: ["code", "link"] },
  requestedIp: String
});
loginChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
var uploadSchema = new Schema({
  photo: { type: photoSchema, required: true },
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  claimedAt: Date,
  expiresAt: { type: Date, required: true }
});
uploadSchema.index({ "photo.id": 1 }, { unique: true });
uploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
var aiVerdictSchema = new Schema(
  {
    model: String,
    category: { type: String, enum: CATEGORIES },
    categoryConfidence: Number,
    severity: Number,
    relevant: Boolean,
    embedding: { type: [Number], default: void 0 },
    integrity: {
      exifGpsDriftM: Number,
      captureToSubmitMinutes: Number,
      screenshotSuspected: Boolean,
      reusedImage: Boolean
    },
    overriddenByUser: Boolean,
    at: Date
  },
  { _id: false }
);
var reportSchema = new Schema(
  {
    ref: { type: String, required: true, unique: true },
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    severity: { type: Number, min: 1, max: 5, default: 3 },
    description: String,
    location: geoPoint,
    accuracy: Number,
    address: String,
    photos: { type: [photoSchema], default: [] },
    reporterId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    wardId: { type: Schema.Types.ObjectId, ref: "Ward", index: true },
    ai: aiVerdictSchema,
    issueId: { type: Schema.Types.ObjectId, ref: "Issue", index: true },
    mergeConfidence: Number,
    mergeDecision: {
      type: String,
      enum: ["auto", "reviewed", "new", "pending"],
      default: "pending",
      index: true
    },
    queuedOffline: Boolean,
    capturedAt: Date,
    rejectedReason: String
  },
  { timestamps: true }
);
reportSchema.index({ location: "2dsphere" });
reportSchema.index({ createdAt: -1 });
var priorityFactorSchema = new Schema(
  { key: String, label: String, value: Number, weight: Number, points: Number, detail: String },
  { _id: false }
);
var issueSchema = new Schema(
  {
    ref: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    status: { type: String, enum: STATUSES, default: "reported", index: true },
    severity: { type: Number, min: 1, max: 5, default: 3 },
    description: String,
    location: geoPoint,
    address: String,
    wardId: { type: Schema.Types.ObjectId, ref: "Ward", index: true },
    reportIds: [{ type: Schema.Types.ObjectId, ref: "Report" }],
    reportCount: { type: Number, default: 1, index: true },
    photos: { type: [photoSchema], default: [] },
    proofPhotos: { type: [photoSchema], default: [] },
    priorityScore: { type: Number, default: 0, index: true },
    priorityBand: {
      type: String,
      enum: ["critical", "high", "medium", "low"],
      default: "low",
      index: true
    },
    priorityFactors: { type: [priorityFactorSchema], default: [] },
    embedding: { type: [Number], default: void 0 },
    confirms: { type: Number, default: 0 },
    disputes: { type: Number, default: 0 },
    weightedConfirms: { type: Number, default: 0 },
    weightedDisputes: { type: Number, default: 0 },
    assigneeId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    department: { type: String, enum: DEPARTMENTS, index: true },
    slaDueAt: Date,
    assignedAt: Date,
    verifiedAt: Date,
    resolvedAt: Date,
    firstReportAt: { type: Date, required: true },
    citizenSignedOffAt: Date
  },
  { timestamps: true }
);
issueSchema.index({ location: "2dsphere" });
issueSchema.index({ status: 1, priorityScore: -1 });
issueSchema.index({ department: 1, status: 1, slaDueAt: 1 });
var statusEventSchema = new Schema({
  issueId: { type: Schema.Types.ObjectId, ref: "Issue", required: true, index: true },
  status: { type: String, enum: STATUSES, required: true },
  from: { type: String, enum: STATUSES },
  note: String,
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  actorName: String,
  actorRole: { type: String, enum: ROLES },
  proofPhotos: { type: [photoSchema], default: [] },
  at: { type: Date, default: () => /* @__PURE__ */ new Date(), index: true }
});
var APPEND_ONLY = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete"
];
for (const op of APPEND_ONLY) {
  statusEventSchema.pre(op, function() {
    throw new Error("StatusEvent is append-only: the public timeline and the audit log are the same data");
  });
}
var verificationSchema = new Schema({
  issueId: { type: Schema.Types.ObjectId, ref: "Issue", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  vote: { type: String, enum: ["confirm", "dispute"], required: true },
  weight: { type: Number, default: 1 },
  distanceM: Number,
  note: String,
  at: { type: Date, default: () => /* @__PURE__ */ new Date() }
});
verificationSchema.index({ issueId: 1, userId: 1 }, { unique: true });
var m = (name, schema2) => mongoose.models[name] ?? mongoose.model(name, schema2);
var Ward = m("Ward", wardSchema);
var User = m("User", userSchema);
var LoginChallenge = m("LoginChallenge", loginChallengeSchema);
var Upload = m("Upload", uploadSchema);
var Report = m("Report", reportSchema);
var Issue = m("Issue", issueSchema);
var StatusEvent = m("StatusEvent", statusEventSchema);
var Verification = m("Verification", verificationSchema);

// apps/api/src/auth.ts
var signToken = (userId) => jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: env.JWT_TTL });
async function attachUser(req, _res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET);
    if (!payload.sub) return next();
    const doc = await User.findById(payload.sub).lean();
    if (!doc) return next();
    req.user = {
      id: String(doc._id),
      name: doc.name,
      role: doc.role,
      trust: doc.trust ?? 1,
      department: doc.department ?? void 0,
      wardIds: (doc.wardIds ?? []).map(String)
    };
  } catch {
  }
  return next();
}
function requireUser(req) {
  if (!req.user) throw HttpError.unauthorized();
  return req.user;
}
var requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(HttpError.unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(HttpError.forbidden(`This needs the ${roles.join(" or ")} role`));
  }
  return next();
};
var hashCode = (phone, code) => crypto.createHmac("sha256", env.JWT_SECRET).update(`${phone}:${code}`).digest("hex");
var generateCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, "0");
var buckets = /* @__PURE__ */ new Map();
var rateLimit = (opts) => {
  const keyOf = opts.key ?? ((req) => req.ip ?? "unknown");
  return (req, res, next) => {
    const key = `${req.route?.path ?? req.path}:${keyOf(req)}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1e3));
      return next(HttpError.tooMany());
    }
    return next();
  };
};
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 6e4).unref();

// apps/api/src/db.ts
import mongoose2 from "mongoose";
async function connectDb() {
  mongoose2.set("strictQuery", true);
  mongoose2.connection.on("disconnected", () => log.warn("mongo disconnected"));
  mongoose2.connection.on("reconnected", () => log.info("mongo reconnected"));
  try {
    await mongoose2.connect(env.MONGO_URL, { serverSelectionTimeoutMS: 8e3 });
  } catch (err) {
    log.error("mongo connection failed", { url: redact(env.MONGO_URL), err: String(err) });
    console.error(
      "\nCould not reach MongoDB. Either start it with `docker compose up -d mongo`\nor point MONGO_URL at an Atlas cluster in your .env file.\n"
    );
    process.exit(1);
  }
  await mongoose2.connection.syncIndexes().catch((err) => log.warn("syncIndexes failed", { err: String(err) }));
  log.info("mongo connected", { db: mongoose2.connection.name });
}
var redact = (url) => url.replace(/\/\/[^@]*@/, "//***@");

// apps/api/src/mailer.ts
import nodemailer from "nodemailer";
var COOLDOWN_MS = 5 * 6e4;
function parseAccounts(raw) {
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const at = entry.indexOf(":");
    if (at < 1) return null;
    const user = entry.slice(0, at).trim();
    const pass = entry.slice(at + 1).trim();
    return user && pass ? { user, pass } : null;
  }).filter((a) => a !== null);
}
var accounts = parseAccounts(env.SMTP_ACCOUNTS);
var slots = accounts.map((account) => ({
  account,
  transport: nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; 587 starts plaintext and upgrades with STARTTLS.
    secure: env.SMTP_PORT === 465,
    auth: { user: account.user, pass: account.pass },
    connectionTimeout: 1e4,
    greetingTimeout: 1e4,
    socketTimeout: 2e4
  }),
  cooldownUntil: 0,
  failures: 0,
  sent: 0
}));
var cursor = 0;
var mailerConfigured = () => slots.length > 0;
async function sendMail(message) {
  if (slots.length === 0) {
    return { ok: false, attempts: 0, error: "No SMTP accounts are configured (set SMTP_ACCOUNTS)." };
  }
  const now = Date.now();
  const order = slots.map((_, i) => slots[(cursor + i) % slots.length]);
  const ready = order.filter((slot) => slot.cooldownUntil <= now);
  const queue = ready.length > 0 ? ready : order;
  let attempts = 0;
  let lastError = "";
  for (const slot of queue) {
    attempts += 1;
    try {
      await slot.transport.sendMail({
        // Most providers reject a From that is not the authenticated mailbox.
        from: `"${env.MAIL_FROM_NAME}" <${slot.account.user}>`,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html
      });
      slot.sent += 1;
      slot.failures = 0;
      slot.cooldownUntil = 0;
      cursor = slots.indexOf(slot);
      log.info("mail sent", { via: slot.account.user, attempts, subject: message.subject });
      return { ok: true, via: slot.account.user, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      slot.failures += 1;
      slot.cooldownUntil = Date.now() + COOLDOWN_MS;
      log.warn("mail account failed, trying the next one", {
        account: slot.account.user,
        failures: slot.failures,
        err: lastError
      });
    }
  }
  log.error("every mail account failed", { attempts, err: lastError });
  return { ok: false, attempts, error: lastError };
}
async function verifyAccounts() {
  if (slots.length === 0) {
    log.warn("no SMTP accounts configured \u2014 email sign-in will not work");
    return;
  }
  await Promise.all(
    slots.map(async (slot) => {
      try {
        await slot.transport.verify();
        log.info("smtp account ready", { account: slot.account.user });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        slot.cooldownUntil = Date.now() + COOLDOWN_MS;
        log.warn("smtp account rejected its credentials", {
          account: slot.account.user,
          err: message,
          // The most common cause by far, and invisible from the error text.
          hint: "Consumer providers often require IMAP/POP access to be switched on in the mailbox settings before SMTP will authenticate."
        });
      }
    })
  );
}
var mailerStatus = () => slots.map((slot) => ({
  account: slot.account.user.replace(/^(.{3}).*(@.*)$/, "$1***$2"),
  sent: slot.sent,
  failures: slot.failures,
  coolingDown: slot.cooldownUntil > Date.now()
}));

// apps/api/src/routes/authority.ts
import { Router } from "express";

// apps/api/src/dedup.ts
var WEIGHTS = { distance: 0.3, category: 0.2, time: 0.12, image: 0.3, text: 0.08 };
function scoreMatch(report, issue) {
  const dist = distanceMeters(report.location, issue.location);
  const distanceValue = Math.max(0, 1 - dist / env.DEDUP_RADIUS_M);
  const sameCategory = report.category === issue.category;
  const sameDept = CATEGORY_META[report.category].department === CATEGORY_META[issue.category].department;
  const categoryValue = sameCategory ? 1 : sameDept ? 0.45 : 0;
  const ageDays = Math.abs(
    (report.createdAt?.valueOf() ?? Date.now()) - new Date(issue.firstReportAt).valueOf()
  ) / 864e5;
  const timeValue = Math.max(0, 1 - ageDays / env.DEDUP_WINDOW_DAYS);
  const reportEmbedding = report.ai?.embedding ?? [];
  const issueEmbedding = issue.embedding ?? [];
  const hasVectors = reportEmbedding.length > 0 && issueEmbedding.length > 0;
  const imageValue = hasVectors ? Math.max(0, cosine(reportEmbedding, issueEmbedding)) : 0;
  const textValue = jaccard(report.description ?? "", issue.description ?? "");
  const factors = [
    { key: "distance", weight: WEIGHTS.distance, value: distanceValue, detail: `${Math.round(dist)} m apart` },
    {
      key: "category",
      weight: WEIGHTS.category,
      value: categoryValue,
      detail: sameCategory ? "Same category" : sameDept ? "Related category, same department" : "Different category"
    },
    { key: "time", weight: WEIGHTS.time, value: timeValue, detail: `${Math.round(ageDays)} days apart` },
    {
      key: "image",
      weight: WEIGHTS.image,
      value: imageValue,
      // Being explicit beats silently scoring 0 — this is the line that tells a
      // reviewer the AI service was down when the decision was made.
      detail: hasVectors ? `Photo similarity ${(imageValue * 100).toFixed(0)}%` : "No photo embedding available"
    },
    { key: "text", weight: WEIGHTS.text, value: textValue, detail: textValue > 0 ? "Descriptions overlap" : "No description overlap" }
  ];
  const usable = factors.filter((f) => !(f.key === "image" && !hasVectors));
  const totalWeight = usable.reduce((s, f) => s + f.weight, 0);
  const score = usable.reduce((s, f) => s + f.value * f.weight, 0) / (totalWeight || 1);
  return { issueId: String(issue._id), score, factors };
}
function jaccard(a, b) {
  const norm = (s) => new Set(
    s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)
  );
  const setA = norm(a);
  const setB = norm(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}
async function resolveReport(report) {
  const since = new Date(Date.now() - env.DEDUP_WINDOW_DAYS * 864e5);
  const candidates = await Issue.find({
    status: { $nin: ["resolved", "rejected"] },
    firstReportAt: { $gte: since },
    location: {
      $near: {
        $geometry: report.location,
        $maxDistance: env.DEDUP_RADIUS_M
      }
    }
  }).limit(25).lean();
  const scored = candidates.map((issue2) => scoreMatch(report, issue2)).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score >= env.DEDUP_AUTO_MERGE) {
    await attachReport(best.issueId, report, "auto", best.score);
    log.info("report auto-merged", { report: report.ref, issue: best.issueId, score: best.score.toFixed(3) });
    return { decision: "auto", issueId: best.issueId, confidence: best.score, factors: best.factors };
  }
  if (best && best.score >= env.DEDUP_REVIEW) {
    await Report.updateOne(
      { _id: report._id },
      { $set: { mergeDecision: "pending", mergeConfidence: best.score, issueId: null } }
    );
    log.info("report held for review", { report: report.ref, issue: best.issueId, score: best.score.toFixed(3) });
    return { decision: "pending", issueId: best.issueId, confidence: best.score, factors: best.factors };
  }
  const issue = await createIssueFromReport(report);
  return { decision: "new", issueId: String(issue._id), confidence: best?.score ?? 0 };
}
async function createIssueFromReport(report) {
  const ward2 = report.wardId ? await Ward.findById(report.wardId).lean() : await nearestWard(report.location);
  const meta = CATEGORY_META[report.category];
  const priority = computePriority({
    category: report.category,
    severity: report.severity ?? 3,
    reportCount: 1,
    wardDensity: ward2?.densityPerKm2 ?? 2e4,
    ageHours: 0
  });
  const issue = await Issue.create({
    ref: makeRef("AS"),
    title: meta.en,
    category: report.category,
    status: "reported",
    severity: report.severity ?? 3,
    description: report.description,
    location: report.location,
    address: report.address,
    wardId: ward2?._id,
    reportIds: [report._id],
    reportCount: 1,
    photos: report.photos,
    embedding: report.ai?.embedding ?? void 0,
    department: meta.department,
    priorityScore: priority.score,
    priorityBand: priority.band,
    priorityFactors: priority.factors,
    firstReportAt: report.createdAt ?? /* @__PURE__ */ new Date()
  });
  await Report.updateOne(
    { _id: report._id },
    { $set: { issueId: issue._id, mergeDecision: "new", wardId: ward2?._id } }
  );
  await StatusEvent.create({
    issueId: issue._id,
    status: "reported",
    note: "Reported by a citizen",
    actorId: report.reporterId,
    actorRole: "citizen",
    at: report.createdAt ?? /* @__PURE__ */ new Date()
  });
  return issue;
}
async function attachReport(issueId, report, decision, confidence) {
  const issue = await Issue.findById(issueId);
  if (!issue) throw new Error(`issue ${issueId} vanished during merge`);
  const alreadyIn = (issue.reportIds ?? []).some((id2) => String(id2) === String(report._id));
  if (!alreadyIn) {
    issue.reportIds = [...issue.reportIds ?? [], report._id];
    issue.reportCount = (issue.reportIds ?? []).length;
  }
  issue.severity = Math.max(issue.severity ?? 3, report.severity ?? 3);
  const members = await Report.find({ _id: { $in: issue.reportIds } }).select("location ai.embedding").lean();
  const pts = members.map((r) => r.location.coordinates);
  if (pts.length > 0) {
    const lng = pts.reduce((s, p) => s + (p[0] ?? 0), 0) / pts.length;
    const lat = pts.reduce((s, p) => s + (p[1] ?? 0), 0) / pts.length;
    issue.location = { type: "Point", coordinates: [lng, lat] };
  }
  const vectors = members.map((r) => r.ai?.embedding ?? []).filter((v) => Array.isArray(v) && v.length > 0);
  const mean = meanVector(vectors);
  if (mean) issue.embedding = mean;
  const merged = [...issue.photos ?? [], ...report.photos ?? []];
  issue.photos = merged.slice(0, 8);
  await issue.save();
  await recomputePriority(String(issue._id));
  await Report.updateOne(
    { _id: report._id },
    { $set: { issueId: issue._id, mergeDecision: decision, mergeConfidence: confidence, wardId: issue.wardId } }
  );
  return issue;
}
async function recomputePriority(issueId) {
  const issue = await Issue.findById(issueId);
  if (!issue) return null;
  const ward2 = issue.wardId ? await Ward.findById(issue.wardId).lean() : null;
  const ageHours = (Date.now() - new Date(issue.firstReportAt).valueOf()) / 36e5;
  const priority = computePriority({
    category: issue.category,
    severity: issue.severity ?? 3,
    reportCount: issue.reportCount ?? 1,
    wardDensity: ward2?.densityPerKm2 ?? 2e4,
    // A resolved issue should stop climbing the queue as it ages.
    ageHours: issue.resolvedAt ? 0 : ageHours
  });
  issue.priorityScore = priority.score;
  issue.priorityBand = priority.band;
  issue.priorityFactors = priority.factors;
  await issue.save();
  return priority;
}
async function nearestWard(at) {
  const containing = await Ward.findOne({ boundary: { $geoIntersects: { $geometry: at } } }).lean();
  if (containing) return containing;
  return Ward.findOne({ center: { $near: { $geometry: at } } }).lean();
}

// apps/api/src/serialize.ts
var id = (doc) => String(doc._id);
var photo = (p) => ({
  id: p.id,
  url: p.url,
  thumbUrl: p.thumbUrl,
  width: p.width ?? void 0,
  height: p.height ?? void 0
});
var ward = (w) => w ? {
  id: id(w),
  name: w.name,
  nameBn: w.nameBn,
  cityCorporation: w.cityCorporation,
  densityPerKm2: w.densityPerKm2
} : void 0;
var reportSummary = (r, reporter) => ({
  id: id(r),
  ref: r.ref,
  category: r.category,
  severity: r.severity ?? 3,
  description: r.description ?? void 0,
  location: r.location,
  photos: (r.photos ?? []).map(photo),
  createdAt: new Date(r.createdAt ?? Date.now()).toISOString(),
  queuedOffline: r.queuedOffline ?? void 0,
  reporter: reporter ? { id: id(reporter), name: reporter.name, trust: reporter.trust ?? 1 } : void 0,
  ai: r.ai ? {
    model: r.ai.model ?? "unknown",
    category: r.ai.category ?? void 0,
    categoryConfidence: r.ai.categoryConfidence ?? void 0,
    severity: r.ai.severity ?? void 0,
    relevant: r.ai.relevant ?? void 0,
    integrity: r.ai.integrity ? {
      exifGpsDriftM: r.ai.integrity.exifGpsDriftM ?? void 0,
      captureToSubmitMinutes: r.ai.integrity.captureToSubmitMinutes ?? void 0,
      screenshotSuspected: r.ai.integrity.screenshotSuspected ?? void 0,
      reusedImage: r.ai.integrity.reusedImage ?? void 0
    } : void 0,
    overriddenByUser: r.ai.overriddenByUser ?? void 0,
    at: new Date(r.ai.at ?? Date.now()).toISOString()
  } : void 0,
  issueId: r.issueId ? String(r.issueId) : void 0,
  mergeConfidence: r.mergeConfidence ?? void 0,
  mergeDecision: r.mergeDecision ?? void 0
});
function verification(issue, opts = {}) {
  const distanceM = opts.viewerAt ? distanceMeters(opts.viewerAt, issue.location) : void 0;
  return {
    confirms: issue.confirms ?? 0,
    disputes: issue.disputes ?? 0,
    weightedConfirms: Number((issue.weightedConfirms ?? 0).toFixed(2)),
    weightedDisputes: Number((issue.weightedDisputes ?? 0).toFixed(2)),
    threshold: env.VERIFY_THRESHOLD,
    myVote: opts.myVote,
    eligible: distanceM === void 0 ? void 0 : distanceM <= env.VERIFY_PROXIMITY_M,
    distanceM: distanceM === void 0 ? void 0 : Math.round(distanceM)
  };
}
function issueSummary(i, extra = {}) {
  const score = i.priorityScore ?? 0;
  return {
    id: id(i),
    ref: i.ref,
    title: i.title,
    category: i.category,
    status: i.status,
    severity: i.severity ?? 3,
    location: i.location,
    address: i.address ?? void 0,
    ward: ward(extra.ward),
    reportCount: i.reportCount ?? 1,
    photos: (i.photos ?? []).map(photo),
    priority: {
      score,
      band: i.priorityBand ?? bandFor(score),
      factors: (i.priorityFactors ?? []).map((f) => ({
        key: f.key,
        label: f.label ?? "",
        value: f.value ?? 0,
        weight: f.weight ?? 0,
        points: f.points ?? 0,
        detail: f.detail ?? ""
      }))
    },
    createdAt: new Date(i.createdAt ?? Date.now()).toISOString(),
    updatedAt: new Date(i.updatedAt ?? Date.now()).toISOString(),
    slaDueAt: i.slaDueAt ? new Date(i.slaDueAt).toISOString() : void 0,
    slaBreached: i.slaDueAt ? new Date(i.slaDueAt).valueOf() < Date.now() && !i.resolvedAt : false,
    verification: verification(i, { myVote: extra.myVote, viewerAt: extra.viewerAt }),
    assignee: extra.assignee ? {
      id: id(extra.assignee),
      name: extra.assignee.name,
      department: extra.assignee.department ?? "roads"
    } : void 0
  };
}
var statusEvent = (e) => ({
  id: id(e),
  status: e.status,
  note: e.note ?? void 0,
  actor: { name: e.actorName ?? "System", role: e.actorRole ?? "admin" },
  proofPhotos: (e.proofPhotos ?? []).map(photo),
  at: new Date(e.at ?? Date.now()).toISOString()
});
function issueDetail(i, parts) {
  return {
    ...issueSummary(i, parts),
    description: i.description ?? void 0,
    reports: parts.reports.map(({ report, reporter }) => reportSummary(report, reporter)),
    timeline: parts.timeline.map(statusEvent),
    proofPhotos: (i.proofPhotos ?? []).map(photo),
    nearby: parts.nearby
  };
}
var me = (u) => ({
  id: id(u),
  name: u.name,
  phone: u.phone ?? void 0,
  email: u.email ?? void 0,
  emailVerified: Boolean(u.emailVerifiedAt),
  role: u.role,
  trust: u.trust ?? 1,
  department: u.department ?? void 0,
  wardIds: (u.wardIds ?? []).map(String),
  reportCount: u.reportCount ?? 0,
  verifiedCount: u.verifiedCount ?? 0
});

// apps/api/src/routes/authority.ts
var authorityRouter = Router();
authorityRouter.get(
  "/queue",
  requireRole("authority", "admin"),
  route(async (req, res) => {
    const auth = requireUser(req);
    const filter = { status: { $nin: ["resolved", "rejected"] } };
    if (auth.role === "authority" && auth.department) filter.department = auth.department;
    if (auth.role === "authority" && auth.wardIds.length > 0) filter.wardId = { $in: auth.wardIds };
    if (req.query.status === "mine") filter.assigneeId = auth.id;
    if (req.query.status === "unassigned") filter.assigneeId = { $exists: false };
    if (req.query.status === "overdue") {
      filter.slaDueAt = { $lt: /* @__PURE__ */ new Date() };
      filter.resolvedAt = { $exists: false };
    }
    const issues = await Issue.find(filter).sort({ priorityScore: -1, firstReportAt: 1 }).limit(200).lean();
    const [wards, assignees] = await Promise.all([
      Ward.find({ _id: { $in: issues.map((i) => i.wardId).filter(Boolean) } }).lean(),
      User.find({ _id: { $in: issues.map((i) => i.assigneeId).filter(Boolean) } }).lean()
    ]);
    const wardById = new Map(wards.map((w) => [String(w._id), w]));
    const userById = new Map(assignees.map((u) => [String(u._id), u]));
    res.json({
      items: issues.map(
        (i) => issueSummary(i, {
          ward: wardById.get(String(i.wardId)),
          assignee: userById.get(String(i.assigneeId))
        })
      ),
      counts: {
        total: issues.length,
        unassigned: issues.filter((i) => !i.assigneeId).length,
        overdue: issues.filter((i) => i.slaDueAt && new Date(i.slaDueAt) < /* @__PURE__ */ new Date()).length
      }
    });
  })
);
authorityRouter.post(
  "/issues/:id/status",
  requireRole("authority", "admin"),
  route(async (req, res) => {
    const auth = requireUser(req);
    const input = parse(statusChangeSchema, req.body);
    const issue = await Issue.findById(req.params.id);
    if (!issue) throw HttpError.notFound("That problem does not exist");
    const from = issue.status;
    if (from === input.to) throw HttpError.conflict(`This is already ${from.replace("_", " ")}`);
    if (!canTransition(from, input.to)) {
      throw HttpError.conflict(`A problem cannot go from ${from.replace("_", " ")} to ${input.to.replace("_", " ")}`);
    }
    let proofPhotos = [];
    if (input.to === "resolved") {
      if (!input.proofPhotoIds || input.proofPhotoIds.length === 0) {
        throw HttpError.badRequest("Closing a problem needs a photo of the fix \u2014 an issue cannot be resolved on your word alone.");
      }
      const uploads = await Upload.find({ "photo.id": { $in: input.proofPhotoIds }, ownerId: auth.id });
      if (uploads.length !== input.proofPhotoIds.length) {
        throw HttpError.badRequest("Those photos have expired. Upload the proof-of-fix photo again.");
      }
      proofPhotos = uploads.map((u) => u.photo);
      await Upload.updateMany({ _id: { $in: uploads.map((u) => u._id) } }, { $set: { claimedAt: /* @__PURE__ */ new Date() } });
    }
    if (input.to === "assigned") {
      const assigneeId = input.assigneeId ?? auth.id;
      const assignee = await User.findById(assigneeId);
      if (!assignee || !["authority", "admin"].includes(assignee.role)) {
        throw HttpError.badRequest("Assign this to an authority account");
      }
      issue.assigneeId = assignee._id;
      issue.assignedAt = /* @__PURE__ */ new Date();
      const hours = CATEGORY_META[issue.category].slaHours;
      issue.slaDueAt = new Date(Date.now() + hours * 36e5);
    }
    if (input.to === "resolved") {
      issue.resolvedAt = /* @__PURE__ */ new Date();
      issue.proofPhotos = [...issue.proofPhotos ?? [], ...proofPhotos];
    }
    if (from === "resolved" && input.to === "assigned") {
      issue.resolvedAt = void 0;
      issue.citizenSignedOffAt = void 0;
    }
    issue.status = input.to;
    await issue.save();
    await StatusEvent.create({
      issueId: issue._id,
      status: input.to,
      from,
      note: input.note,
      actorId: auth.id,
      actorName: auth.name,
      actorRole: auth.role,
      proofPhotos
    });
    await recomputePriority(String(issue._id));
    log.info("issue status changed", { issue: issue.ref, from, to: input.to, by: auth.id });
    const fresh = await Issue.findById(issue._id).lean();
    res.json({ issue: fresh ? issueSummary(fresh) : void 0 });
  })
);
authorityRouter.get(
  "/review",
  requireRole("authority", "admin"),
  route(async (_req, res) => {
    const pending2 = await Report.find({ mergeDecision: "pending", issueId: { $in: [null, void 0] } }).sort({ createdAt: 1 }).limit(50).lean();
    const items = await Promise.all(
      pending2.map(async (report) => {
        const candidates = await Issue.find({
          status: { $nin: ["resolved", "rejected"] },
          location: { $near: { $geometry: report.location, $maxDistance: 250 } }
        }).limit(4).lean();
        const scored = candidates.map((issue) => ({ issue: issueSummary(issue), match: scoreMatch(report, issue) })).sort((a, b) => b.match.score - a.match.score);
        return { report: reportSummary(report), candidates: scored, reason: report.rejectedReason ?? void 0 };
      })
    );
    res.json({ items, total: items.length });
  })
);
authorityRouter.post(
  "/review",
  requireRole("authority", "admin"),
  route(async (req, res) => {
    const auth = requireUser(req);
    const input = parse(mergeDecisionSchema, req.body);
    const report = await Report.findById(input.reportId);
    if (!report) throw HttpError.notFound("That report does not exist");
    if (report.issueId) throw HttpError.conflict("That report has already been filed");
    if (input.action === "reject") {
      report.mergeDecision = "reviewed";
      report.rejectedReason = input.note ?? "Rejected in review";
      await report.save();
      log.info("report rejected in review", { report: report.ref, by: auth.id });
      res.json({ ok: true, action: "reject" });
      return;
    }
    if (input.action === "merge") {
      if (!input.targetIssueId) throw HttpError.badRequest("Pick the problem to merge into");
      const issue2 = await attachReport(
        input.targetIssueId,
        report.toObject(),
        "reviewed",
        report.mergeConfidence ?? 0
      );
      await StatusEvent.create({
        issueId: issue2._id,
        status: issue2.status,
        from: issue2.status,
        note: `Report ${report.ref} merged in during review${input.note ? ` \u2014 ${input.note}` : ""}`,
        actorId: auth.id,
        actorName: auth.name,
        actorRole: auth.role
      });
      res.json({ ok: true, action: "merge", issueId: String(issue2._id) });
      return;
    }
    const issue = await createIssueFromReport(report.toObject());
    await Report.updateOne({ _id: report._id }, { $set: { mergeDecision: "reviewed" } });
    res.json({ ok: true, action: "split", issueId: String(issue._id) });
  })
);
authorityRouter.post(
  "/issues/:id/signoff",
  route(async (req, res) => {
    const auth = requireUser(req);
    const issue = await Issue.findById(req.params.id);
    if (!issue) throw HttpError.notFound("That problem does not exist");
    if (issue.status !== "resolved") throw HttpError.conflict("This has not been marked resolved yet");
    const mine = await Report.exists({ issueId: issue._id, reporterId: auth.id });
    if (!mine) throw HttpError.forbidden("Only someone who reported this can sign it off");
    const accept = req.body?.accept !== false;
    if (accept) {
      issue.citizenSignedOffAt = /* @__PURE__ */ new Date();
      await issue.save();
      await StatusEvent.create({
        issueId: issue._id,
        status: "resolved",
        from: "resolved",
        note: "The citizen who reported it confirmed the fix",
        actorId: auth.id,
        actorName: auth.name,
        actorRole: auth.role
      });
      res.json({ ok: true, signedOff: true });
      return;
    }
    issue.status = "assigned";
    issue.resolvedAt = void 0;
    issue.citizenSignedOffAt = void 0;
    await issue.save();
    await StatusEvent.create({
      issueId: issue._id,
      status: "assigned",
      from: "resolved",
      note: req.body?.note ? `Reopened by the reporter \u2014 ${String(req.body.note).slice(0, 300)}` : "Reopened by the reporter: the problem is still there",
      actorId: auth.id,
      actorName: auth.name,
      actorRole: auth.role
    });
    await recomputePriority(String(issue._id));
    res.json({ ok: true, reopened: true });
  })
);

// apps/api/src/routes/auth.ts
import crypto2 from "node:crypto";
import { Router as Router2 } from "express";

// apps/api/src/emails.ts
var INK = "#16211c";
var INK_2 = "#4a5a52";
var INK_3 = "#74847b";
var ACCENT = "#00694c";
var LINE = "#dfe4e0";
var GROUND = "#f5f6f4";
function loginEmail({ code, magicUrl, minutes, isNewAccount }) {
  const heading = isNewAccount ? "Confirm your email to start reporting" : "Sign in to Amar Shohor";
  const spacedCode = code.split("").join(" ");
  const subject = `${code} is your Amar Shohor sign-in code`;
  const text = [
    heading,
    "",
    `Your code is ${code}`,
    "",
    "Or open this link to sign in directly:",
    magicUrl,
    "",
    `Both expire in ${minutes} minutes, and using either one cancels the other.`,
    "If you did not ask to sign in, you can ignore this email \u2014 nobody can",
    "get in with it unless they also have your inbox.",
    "",
    "Amar Shohor \u2014 \u0986\u09AE\u09BE\u09B0 \u09B6\u09B9\u09B0"
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GROUND};padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;font-family:'Helvetica Neue',Arial,sans-serif;">

    <tr><td style="padding:22px 26px 0 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:30px;height:30px;background:${ACCENT};border-radius:8px;text-align:center;vertical-align:middle;color:#ffffff;font-size:15px;font-weight:bold;line-height:30px;">\u25C9</td>
        <td style="padding-left:10px;">
          <div style="font-size:16px;font-weight:bold;color:${INK};letter-spacing:-0.3px;">Amar Shohor</div>
          <div style="font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:${INK_3};">One city, one map</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:22px 26px 0 26px;">
      <h1 style="margin:0 0 8px 0;font-size:20px;line-height:1.25;color:${INK};font-weight:bold;">${escape(heading)}</h1>
      <p style="margin:0;font-size:14.5px;line-height:1.55;color:${INK_2};">
        Use whichever is easier \u2014 the button, or the code below it.
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
        Amar Shohor \u2014 \u0986\u09AE\u09BE\u09B0 \u09B6\u09B9\u09B0 \xB7 Citizens report city problems, and the city sees, prioritises and resolves them.
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
var magicUrlFor = (token) => `${env.WEB_PUBLIC_URL.replace(/\/$/, "")}/auth/magic?token=${encodeURIComponent(token)}`;
function escape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// apps/api/src/routes/auth.ts
var authRouter = Router2();
var MAX_ATTEMPTS = 5;
var ttlMs = () => env.LOGIN_CODE_TTL_MINUTES * 6e4;
var newMagicToken = () => crypto2.randomBytes(32).toString("base64url");
var hashToken = (token) => crypto2.createHmac("sha256", env.JWT_SECRET).update(`magic:${token}`).digest("hex");
var maskEmail = (email) => email.replace(/^(.{2}).*(@.*)$/, "$1***$2");
authRouter.post(
  "/email/request",
  rateLimit({ windowMs: 10 * 6e4, max: 5, key: (req) => String(req.body?.email ?? req.ip) }),
  route(async (req, res) => {
    const { email, name } = parse(emailRequestSchema, req.body);
    if (!mailerConfigured()) {
      throw new HttpError(
        503,
        "mail_unconfigured",
        "Sign-in is not set up on this server yet: no mail sender is configured."
      );
    }
    const code = generateCode();
    const magicToken = newMagicToken();
    const isNewAccount = !await User.exists({ email });
    await LoginChallenge.deleteMany({ identifier: email, consumedAt: { $exists: false } });
    await LoginChallenge.create({
      identifier: email,
      codeHash: hashCode(email, code),
      magicHash: hashToken(magicToken),
      requestedName: name,
      expiresAt: new Date(Date.now() + ttlMs()),
      requestedIp: req.ip
    });
    const magicUrl = magicUrlFor(magicToken);
    const message = loginEmail({
      code,
      magicUrl,
      minutes: env.LOGIN_CODE_TTL_MINUTES,
      isNewAccount
    });
    const result = await sendMail({ to: email, ...message });
    if (!result.ok) {
      log.error("login email could not be delivered", { to: maskEmail(email), attempts: result.attempts });
      throw new HttpError(
        502,
        "mail_failed",
        "We could not send that email \u2014 every sending account refused it. Try again in a few minutes."
      );
    }
    log.info("login email sent", { to: maskEmail(email), via: result.via, attempts: result.attempts, isNewAccount });
    res.json({
      sent: true,
      expiresInSeconds: ttlMs() / 1e3,
      isNewAccount
    });
  })
);
authRouter.post(
  "/email/verify",
  rateLimit({ windowMs: 10 * 6e4, max: 10, key: (req) => String(req.body?.email ?? req.ip) }),
  route(async (req, res) => {
    const { email, code, name } = parse(emailVerifySchema, req.body);
    const challenge = await consumeCode(email, code);
    const user = await upsertUser(email, name ?? challenge.requestedName);
    res.json({ token: signToken(String(user._id)), user: me(user) });
  })
);
authRouter.post(
  "/magic/consume",
  rateLimit({ windowMs: 10 * 6e4, max: 20 }),
  route(async (req, res) => {
    const { token } = parse(magicConsumeSchema, req.body);
    const challenge = await LoginChallenge.findOne({ magicHash: hashToken(token) });
    if (!challenge) throw HttpError.badRequest("That sign-in link is not valid. Ask for a new one.");
    if (challenge.consumedAt) {
      throw HttpError.conflict("That link has already been used. Ask for a new one if you need to sign in again.");
    }
    if (challenge.expiresAt.valueOf() < Date.now()) {
      throw HttpError.badRequest("That sign-in link has expired. Ask for a new one.");
    }
    challenge.consumedAt = /* @__PURE__ */ new Date();
    challenge.consumedBy = "link";
    await challenge.save();
    const user = await upsertUser(challenge.identifier, challenge.requestedName);
    log.info("signed in by magic link", { to: maskEmail(challenge.identifier) });
    res.json({ token: signToken(String(user._id)), user: me(user) });
  })
);
authRouter.get(
  "/me",
  route(async (req, res) => {
    const auth = requireUser(req);
    const user = await User.findById(auth.id).lean();
    if (!user) throw HttpError.notFound("That account no longer exists");
    res.json(me(user));
  })
);
async function consumeCode(identifier, code) {
  const challenge = await LoginChallenge.findOne({
    identifier,
    consumedAt: { $exists: false }
  }).sort({ expiresAt: -1 });
  if (!challenge) throw HttpError.badRequest("That code has expired. Ask for a new one.");
  if (challenge.expiresAt.valueOf() < Date.now()) {
    throw HttpError.badRequest("That code has expired. Ask for a new one.");
  }
  if ((challenge.attempts ?? 0) >= MAX_ATTEMPTS) {
    throw HttpError.tooMany("Too many wrong codes. Ask for a new one.");
  }
  if (challenge.codeHash !== hashCode(identifier, code)) {
    challenge.attempts = (challenge.attempts ?? 0) + 1;
    await challenge.save();
    throw HttpError.badRequest("That code doesn't match. Check the digits and try again.");
  }
  challenge.consumedAt = /* @__PURE__ */ new Date();
  challenge.consumedBy = "code";
  await challenge.save();
  return challenge;
}
async function upsertUser(email, name) {
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
      email,
      emailVerifiedAt: /* @__PURE__ */ new Date(),
      // A person can rename themselves later; a blank name would be worse than
      // a generic one on a public problem page.
      name: name?.trim() || fallbackName(email),
      role: "citizen",
      trust: 1
    });
    log.info("user registered", { id: String(user._id) });
  } else {
    if (!user.emailVerifiedAt) user.emailVerifiedAt = /* @__PURE__ */ new Date();
    if (name && (user.name === "Citizen" || !user.name)) user.name = name.trim();
  }
  user.lastSeenAt = /* @__PURE__ */ new Date();
  await user.save();
  return user.toObject();
}
function fallbackName(email) {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._\-+\d]+/g, " ").trim();
  if (cleaned.length >= 2) {
    return cleaned.split(/\s+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ").slice(0, 60);
  }
  return "Citizen";
}

// apps/api/src/routes/issues.ts
import { Router as Router3 } from "express";
var issuesRouter = Router3();
issuesRouter.get(
  "/",
  route(async (req, res) => {
    const q = parse(issueQuerySchema, req.query);
    const filter = {};
    if (q.bbox) {
      const [west, south, east, north] = q.bbox.split(",").map(Number);
      filter.location = {
        $geoWithin: {
          $box: [
            [west, south],
            [east, north]
          ]
        }
      };
    }
    if (q.category) {
      const wanted = q.category.split(",").filter((c) => CATEGORIES.includes(c));
      if (wanted.length > 0) filter.category = { $in: wanted };
    }
    if (q.status) {
      const wanted = q.status.split(",").filter((s) => STATUSES.includes(s));
      if (wanted.length > 0) filter.status = { $in: wanted };
    } else {
      filter.status = { $nin: ["rejected"] };
    }
    if (q.ward) filter.wardId = q.ward;
    if (q.band) filter.priorityBand = q.band;
    if (q.since) filter.createdAt = { $gte: q.since };
    if (q.q) filter.$or = [{ ref: q.q.toUpperCase() }, { title: { $regex: escapeRegex(q.q), $options: "i" } }];
    const SORTS = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      reports: { reportCount: -1 },
      priority: { priorityScore: -1 }
    };
    const sort = SORTS[q.sort] ?? SORTS.priority;
    const [items, total] = await Promise.all([
      Issue.find(filter).sort(sort).limit(q.limit).lean(),
      Issue.countDocuments(filter)
    ]);
    const wards = await wardMap(items);
    res.json({
      items: items.map((i) => issueSummary(i, { ward: wards.get(String(i.wardId)) })),
      total
    });
  })
);
issuesRouter.get(
  "/:id",
  route(async (req, res) => {
    const issue = await findIssue(req.params.id);
    const [reports, timeline, ward2, assignee] = await Promise.all([
      Report.find({ issueId: issue._id }).sort({ createdAt: 1 }).lean(),
      StatusEvent.find({ issueId: issue._id }).sort({ at: 1 }).lean(),
      issue.wardId ? Ward.findById(issue.wardId).lean() : null,
      issue.assigneeId ? User.findById(issue.assigneeId).lean() : null
    ]);
    const reporters = await User.find({ _id: { $in: reports.map((r) => r.reporterId).filter(Boolean) } }).lean();
    const byId = new Map(reporters.map((u) => [String(u._id), u]));
    const nearbyDocs = await Issue.find({
      _id: { $ne: issue._id },
      status: { $nin: ["resolved", "rejected"] },
      location: { $near: { $geometry: issue.location, $maxDistance: 900 } }
    }).limit(4).lean();
    const myVote = req.user ? (await Verification.findOne({ issueId: issue._id, userId: req.user.id }).lean())?.vote : void 0;
    const viewerAt = parseAt(req.query.at);
    res.json(
      issueDetail(issue, {
        reports: reports.map((report) => ({ report, reporter: byId.get(String(report.reporterId)) })),
        timeline,
        nearby: nearbyDocs.map((n) => issueSummary(n)),
        ward: ward2,
        assignee,
        myVote,
        viewerAt
      })
    );
  })
);
issuesRouter.post(
  "/:id/verify",
  route(async (req, res) => {
    const auth = requireUser(req);
    const input = parse(verifySchema, req.body);
    const issue = await findIssue(req.params.id);
    const distance = distanceMeters(input.at, issue.location);
    if (distance > env.VERIFY_PROXIMITY_M) {
      throw HttpError.forbidden(
        `You need to be within ${env.VERIFY_PROXIMITY_M} m of the problem to verify it. You are ${Math.round(distance)} m away.`
      );
    }
    const reportedByMe = await Report.exists({ issueId: issue._id, reporterId: auth.id });
    if (reportedByMe) throw HttpError.conflict("You reported this one, so your confirmation is already counted.");
    const existing = await Verification.findOne({ issueId: issue._id, userId: auth.id });
    if (existing) throw HttpError.conflict("You have already voted on this problem.");
    const user = await User.findById(auth.id);
    const weight = Math.max(0.25, Math.min(user?.trust ?? 1, 5));
    await Verification.create({
      issueId: issue._id,
      userId: auth.id,
      vote: input.vote,
      weight,
      distanceM: Math.round(distance),
      note: input.note
    });
    const inc = input.vote === "confirm" ? { confirms: 1, weightedConfirms: weight } : { disputes: 1, weightedDisputes: weight };
    await Issue.updateOne({ _id: issue._id }, { $inc: inc });
    await User.updateOne({ _id: auth.id }, { $inc: { verifiedCount: 1 } });
    const updated = await Issue.findById(issue._id);
    if (!updated) throw HttpError.notFound();
    const crossed = updated.status === "reported" && (updated.weightedConfirms ?? 0) >= env.VERIFY_THRESHOLD && (updated.weightedConfirms ?? 0) > (updated.weightedDisputes ?? 0) * 2;
    if (crossed) {
      updated.status = "verified";
      updated.verifiedAt = /* @__PURE__ */ new Date();
      await updated.save();
      await StatusEvent.create({
        issueId: updated._id,
        status: "verified",
        from: "reported",
        note: `Confirmed by ${updated.confirms} nearby ${updated.confirms === 1 ? "citizen" : "citizens"}`,
        actorName: "Community",
        actorRole: "verifier"
      });
      await User.updateMany(
        { _id: { $in: await confirmerIds(String(updated._id)) } },
        { $inc: { trust: 0.05 } }
      );
      log.info("issue verified by community", { issue: updated.ref, confirms: updated.confirms });
    }
    await recomputePriority(String(updated._id));
    const fresh = await Issue.findById(updated._id).lean();
    res.json({
      verification: fresh ? issueSummary(fresh, { myVote: input.vote, viewerAt: input.at }).verification : void 0,
      statusChanged: crossed
    });
  })
);
async function findIssue(idOrRef) {
  if (!idOrRef) throw HttpError.badRequest("An issue id is required");
  const byId = /^[a-f\d]{24}$/i.test(idOrRef) ? await Issue.findById(idOrRef).lean() : null;
  const issue = byId ?? await Issue.findOne({ ref: idOrRef.toUpperCase() }).lean();
  if (!issue) throw HttpError.notFound("That problem does not exist, or the reference is wrong.");
  return issue;
}
async function wardMap(items) {
  const ids = [...new Set(items.map((i) => i.wardId).filter(Boolean).map(String))];
  const wards = await Ward.find({ _id: { $in: ids } }).lean();
  return new Map(wards.map((w) => [String(w._id), w]));
}
var confirmerIds = async (issueId) => (await Verification.find({ issueId, vote: "confirm" }).select("userId").lean()).map((v) => v.userId);
function parseAt(raw) {
  if (typeof raw !== "string") return void 0;
  const [lat, lng] = raw.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return void 0;
  return { type: "Point", coordinates: [lng, lat] };
}
var escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// apps/api/src/routes/media.ts
import crypto4 from "node:crypto";
import { Router as Router4 } from "express";
import multer from "multer";

// apps/api/src/storage.ts
import crypto3 from "node:crypto";
import fs from "node:fs/promises";
import path2 from "node:path";
var ALLOWED = /* @__PURE__ */ new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/heic", "heic"]
]);
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return "image/heic";
  return null;
}
var MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
function validateUpload(file) {
  if (file.buffer.length > MAX_UPLOAD_BYTES) {
    throw HttpError.badRequest("That image is over 12MB. The app compresses photos before upload \u2014 try re-taking it.");
  }
  const sniffed = sniff(file.buffer);
  if (!sniffed || !ALLOWED.has(sniffed)) {
    throw HttpError.badRequest("Only JPEG, PNG, WebP or HEIC photos are accepted.");
  }
  return sniffed;
}
var sharpModule;
async function getSharp() {
  if (sharpModule !== void 0) return sharpModule;
  try {
    sharpModule = (await import("sharp")).default;
    log.info("sharp available \u2014 generating WebP derivatives");
  } catch {
    sharpModule = null;
    log.warn("sharp unavailable \u2014 serving original images without derivatives");
  }
  return sharpModule;
}
async function derive(buffer, mime) {
  const sharp = await getSharp();
  if (!sharp) {
    return { full: buffer, thumb: buffer, ext: ALLOWED.get(mime) ?? "jpg" };
  }
  const image = sharp(buffer, { failOn: "none" });
  const meta = await image.metadata();
  const [full, thumb] = await Promise.all([
    sharp(buffer, { failOn: "none" }).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
    sharp(buffer, { failOn: "none" }).rotate().resize({ width: 420, height: 320, fit: "cover" }).webp({ quality: 74 }).toBuffer()
  ]);
  const exif = readExif(meta);
  return { full, thumb, ext: "webp", width: meta.width, height: meta.height, exif };
}
function readExif(meta) {
  if (!meta.exif) return void 0;
  const raw = meta.exif.toString("latin1");
  const dateMatch = raw.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  const capturedAt = dateMatch ? /* @__PURE__ */ new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}`) : void 0;
  return capturedAt && !Number.isNaN(capturedAt.valueOf()) ? { capturedAt } : void 0;
}
var UPLOAD_ROOT = path2.resolve(process.cwd(), "var", "uploads");
var LocalStorage = class {
  driver = "local";
  async put(file) {
    const mime = validateUpload(file);
    const { full, thumb, ext, width, height, exif } = await derive(file.buffer, mime);
    const id2 = crypto3.randomUUID();
    const now = /* @__PURE__ */ new Date();
    const dir = path2.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"));
    const key = `${dir}/${id2}.${ext}`;
    const thumbKey = `${dir}/${id2}_t.${ext}`;
    await fs.mkdir(path2.join(UPLOAD_ROOT, dir), { recursive: true });
    await Promise.all([
      fs.writeFile(path2.join(UPLOAD_ROOT, key), full),
      fs.writeFile(path2.join(UPLOAD_ROOT, thumbKey), thumb)
    ]);
    return {
      id: id2,
      key,
      url: `${env.API_PUBLIC_URL}/uploads/${key}`,
      thumbUrl: `${env.API_PUBLIC_URL}/uploads/${thumbKey}`,
      width,
      height,
      bytes: full.length,
      exif
    };
  }
  async remove(key) {
    const ext = path2.extname(key);
    const thumbKey = key.replace(new RegExp(`${ext}$`), `_t${ext}`);
    await Promise.allSettled([
      fs.unlink(path2.join(UPLOAD_ROOT, key)),
      fs.unlink(path2.join(UPLOAD_ROOT, thumbKey))
    ]);
  }
};
var S3Storage = class {
  driver = "s3";
  async put() {
    throw new HttpError(
      501,
      "not_implemented",
      "The S3 driver is a phase 14 task. Set STORAGE_DRIVER=local for now."
    );
  }
  async remove() {
    throw new HttpError(501, "not_implemented", "The S3 driver is a phase 14 task.");
  }
};
var storage = env.STORAGE_DRIVER === "s3" ? new S3Storage() : new LocalStorage();
var uploadRoot = UPLOAD_ROOT;

// apps/api/src/routes/media.ts
var mediaRouter = Router4();
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 4 }
});
mediaRouter.post(
  "/photos",
  rateLimit({ windowMs: 6e4, max: 20 }),
  upload.array("photos", 4),
  route(async (req, res) => {
    const auth = requireUser(req);
    const files = req.files ?? [];
    if (files.length === 0) throw HttpError.badRequest("Attach at least one photo");
    const stored = await Promise.all(files.map((f) => storage.put(f)));
    await Upload.insertMany(
      stored.map((p) => ({
        photo: p,
        ownerId: auth.id,
        expiresAt: new Date(Date.now() + 6 * 36e5)
      }))
    );
    res.status(201).json({
      photos: stored.map((p) => ({ id: p.id, url: p.url, thumbUrl: p.thumbUrl, width: p.width, height: p.height }))
    });
  })
);
mediaRouter.get("/placeholder/:category/:seed", (req, res) => {
  const category = CATEGORIES.includes(req.params.category) ? req.params.category : "road_damage";
  const seed = req.params.seed ?? "0";
  res.setHeader("content-type", "image/svg+xml");
  res.setHeader("cache-control", "public, max-age=31536000, immutable");
  res.send(placeholderSvg(category, seed));
});
var PALETTES = {
  road_damage: ["#3b3f45", "#22262b"],
  waterlogging: ["#2f4a63", "#1b2b3a"],
  garbage: ["#4a4433", "#2b271d"],
  streetlight: ["#2c3348", "#1a1f2c"],
  traffic_signal: ["#4a2f33", "#2b1c1f"],
  sidewalk: ["#40423d", "#25261f"],
  congestion: ["#3d3646", "#231f29"],
  environmental: ["#2f4638", "#1b2921"]
};
function placeholderSvg(category, seed) {
  const [from, to] = PALETTES[category];
  const rng = mulberry(hash(`${category}:${seed}`));
  const label = CATEGORY_META[category].en;
  const shapes = Array.from({ length: 7 }, () => {
    const x = rng() * 420;
    const y = 150 + rng() * 150;
    const w = 30 + rng() * 120;
    const h = 8 + rng() * 40;
    const o = (0.05 + rng() * 0.16).toFixed(3);
    return `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" rx="3" fill="#ffffff" opacity="${o}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="320" viewBox="0 0 420 320" role="img" aria-label="${label}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<rect width="420" height="320" fill="url(#g)"/>
<rect y="146" width="420" height="4" fill="#ffffff" opacity="0.10"/>
${shapes}
<text x="16" y="300" font-family="ui-monospace, monospace" font-size="11" fill="#ffffff" opacity="0.42">${label} \xB7 sample</text>
</svg>`;
}
var hash = (s) => {
  const digest = crypto4.createHash("sha1").update(s).digest();
  return digest.readUInt32BE(0);
};
function mulberry(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// apps/api/src/routes/reports.ts
import { Router as Router5 } from "express";
var reportsRouter = Router5();
reportsRouter.post(
  "/",
  rateLimit({ windowMs: 6e4, max: 10 }),
  route(async (req, res) => {
    const auth = requireUser(req);
    const input = parse(createReportSchema, req.body);
    const uploads = await Upload.find({
      "photo.id": { $in: input.photoIds },
      ownerId: auth.id,
      claimedAt: { $exists: false }
    });
    if (uploads.length !== input.photoIds.length) {
      throw HttpError.badRequest("Those photos have expired. Re-take the photo and submit again.");
    }
    const ward2 = await nearestWard(input.location);
    const report = await Report.create({
      ref: makeRef("RP"),
      category: input.category,
      severity: input.severity ?? 3,
      description: input.description,
      location: input.location,
      accuracy: input.accuracy,
      address: ward2 ? `${ward2.name}, ${ward2.cityCorporation}` : void 0,
      photos: uploads.map((u) => u.photo),
      reporterId: auth.id,
      wardId: ward2?._id,
      queuedOffline: input.queuedOffline,
      capturedAt: input.capturedAt,
      mergeDecision: "pending"
    });
    await Upload.updateMany({ _id: { $in: uploads.map((u) => u._id) } }, { $set: { claimedAt: /* @__PURE__ */ new Date() } });
    await User.updateOne({ _id: auth.id }, { $inc: { reportCount: 1 } });
    if (input.confirmsIssueId) {
      const target = await Issue.findById(input.confirmsIssueId);
      if (target) {
        await attachReport(String(target._id), report.toObject(), "reviewed", 1);
        enqueue(`enrich:${report.ref}`, () => enrich(String(report._id), false));
        const fresh = await Issue.findById(target._id).lean();
        res.status(201).json({
          report: reportSummary(report.toObject()),
          issue: fresh ? issueSummary(fresh, { ward: ward2 }) : void 0,
          dedup: { decision: "auto", confidence: 1, reason: "You confirmed an existing problem" }
        });
        return;
      }
    }
    enqueue(`enrich:${report.ref}`, () => enrich(String(report._id), true));
    res.status(201).json({
      report: reportSummary(report.toObject()),
      /** The client polls this report until dedup has run. */
      pending: true
    });
  })
);
async function enrich(reportId, runDedup) {
  const report = await Report.findById(reportId);
  if (!report) return;
  const firstPhoto = (report.photos ?? [])[0];
  if (firstPhoto) {
    const verdict = await analysePhoto({
      imageUrl: firstPhoto.url,
      reportedCategory: report.category,
      description: report.description ?? void 0
    });
    if (verdict) {
      const exif = firstPhoto.exif;
      const drift = exif?.lat != null && exif?.lng != null ? distanceMeters({ type: "Point", coordinates: [exif.lng, exif.lat] }, report.location) : void 0;
      report.ai = {
        model: verdict.model,
        category: verdict.category,
        categoryConfidence: verdict.categoryConfidence,
        severity: verdict.severity,
        relevant: verdict.relevant,
        embedding: verdict.embedding,
        integrity: {
          exifGpsDriftM: drift,
          captureToSubmitMinutes: exif?.capturedAt ? Math.round((new Date(report.createdAt ?? Date.now()).valueOf() - new Date(exif.capturedAt).valueOf()) / 6e4) : void 0,
          screenshotSuspected: verdict.integrity.screenshotSuspected,
          reusedImage: verdict.integrity.reusedImage
        },
        // The citizen's own category always wins; the disagreement is the
        // training signal phase 09 collects.
        overriddenByUser: verdict.category !== report.category,
        at: /* @__PURE__ */ new Date()
      };
      if (report.severity === 3 && verdict.severity) report.severity = verdict.severity;
      if (verdict.relevant === false) {
        report.mergeDecision = "pending";
        report.rejectedReason = "The photo did not look like a street problem \u2014 held for review";
        await report.save();
        log.warn("report held: photo failed the relevance gate", { report: report.ref });
        return;
      }
      await report.save();
    }
  }
  if (!runDedup) return;
  const outcome = await resolveReport(report.toObject());
  if (outcome.decision === "auto") await recomputePriority(outcome.issueId);
}
reportsRouter.get(
  "/mine",
  route(async (req, res) => {
    const auth = requireUser(req);
    const reports = await Report.find({ reporterId: auth.id }).sort({ createdAt: -1 }).limit(60).lean();
    const issueIds = reports.map((r) => r.issueId).filter(Boolean);
    const issues = await Issue.find({ _id: { $in: issueIds } }).lean();
    const byId = new Map(issues.map((i) => [String(i._id), i]));
    const user = await User.findById(auth.id).lean();
    res.json({
      items: reports.map((r) => ({
        ...reportSummary(r, user),
        issue: r.issueId ? byId.get(String(r.issueId)) ? issueSummary(byId.get(String(r.issueId))) : void 0 : void 0
      }))
    });
  })
);
reportsRouter.get(
  "/nearby",
  route(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw HttpError.badRequest("lat and lng are required");
    }
    const category = typeof req.query.category === "string" ? req.query.category : void 0;
    const radius = Math.min(Number(req.query.radius) || env.DEDUP_RADIUS_M, 1e3);
    const query = {
      status: { $nin: ["resolved", "rejected"] },
      location: { $near: { $geometry: { type: "Point", coordinates: [lng, lat] }, $maxDistance: radius } }
    };
    if (category && category in CATEGORY_META) {
      const dept = CATEGORY_META[category].department;
      const related = Object.keys(CATEGORY_META).filter((c) => CATEGORY_META[c].department === dept);
      query.category = { $in: related };
    }
    const issues = await Issue.find(query).limit(6).lean();
    const here2 = { type: "Point", coordinates: [lng, lat] };
    res.json({
      items: issues.map((i) => ({
        ...issueSummary(i, { viewerAt: here2 }),
        distanceM: Math.round(distanceMeters(here2, i.location))
      }))
    });
  })
);

// apps/api/src/routes/stats.ts
import { Router as Router6 } from "express";
var statsRouter = Router6();
statsRouter.get(
  "/dashboard",
  route(async (_req, res) => {
    const [issues, wards, reportCount, citizens] = await Promise.all([
      Issue.find({}).select("category status wardId department resolvedAt firstReportAt slaDueAt createdAt").lean(),
      Ward.find({}).lean(),
      Report.countDocuments({}),
      User.countDocuments({ role: "citizen" })
    ]);
    const resolved = issues.filter((i) => i.resolvedAt);
    const open = issues.filter((i) => !i.resolvedAt && i.status !== "rejected");
    const hoursFor = (i) => (new Date(i.resolvedAt).valueOf() - new Date(i.firstReportAt).valueOf()) / 36e5;
    const stats = {
      totals: {
        issues: issues.length,
        open: open.length,
        resolved: resolved.length,
        reports: reportCount,
        // The number that makes the product's central claim measurable: how
        // many reports collapsed into a problem that already existed, rather
        // than opening one of their own.
        duplicatesMerged: Math.max(0, reportCount - issues.length),
        citizens
      },
      resolutionRate: issues.length === 0 ? 0 : resolved.length / issues.length,
      medianResolutionHours: median(resolved.map(hoursFor)),
      byCategory: CATEGORIES.map((category) => ({
        category,
        open: open.filter((i) => i.category === category).length,
        resolved: resolved.filter((i) => i.category === category).length
      })).filter((row) => row.open + row.resolved > 0),
      byStatus: STATUSES.map((status) => ({
        status,
        count: issues.filter((i) => i.status === status).length
      })).filter((row) => row.count > 0),
      trend: buildTrend(issues),
      wards: wards.map((w) => {
        const mine = issues.filter((i) => String(i.wardId) === String(w._id));
        const mineResolved = mine.filter((i) => i.resolvedAt);
        return {
          ward: ward(w),
          open: mine.filter((i) => !i.resolvedAt && i.status !== "rejected").length,
          resolved: mineResolved.length,
          total: mine.length,
          resolutionRate: mine.length === 0 ? 0 : mineResolved.length / mine.length,
          medianResolutionHours: median(mineResolved.map(hoursFor)),
          slaBreaches: mine.filter((i) => i.slaDueAt && !i.resolvedAt && new Date(i.slaDueAt) < /* @__PURE__ */ new Date()).length
        };
      }).filter((row) => row.total > 0).sort((a, b) => b.open - a.open),
      departments: DEPARTMENTS.map((department) => {
        const mine = issues.filter((i) => i.department === department);
        const mineResolved = mine.filter((i) => i.resolvedAt);
        return {
          department,
          open: mine.filter((i) => !i.resolvedAt && i.status !== "rejected").length,
          slaBreaches: mine.filter((i) => i.slaDueAt && !i.resolvedAt && new Date(i.slaDueAt) < /* @__PURE__ */ new Date()).length,
          medianResolutionHours: median(mineResolved.map(hoursFor))
        };
      }).filter((row) => row.open > 0 || row.medianResolutionHours !== null)
    };
    res.json(stats);
  })
);
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? 0;
  return Math.round(value * 10) / 10;
}
function buildTrend(issues) {
  const days = [];
  const startOfDay = (d) => {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  const today = startOfDay(/* @__PURE__ */ new Date());
  for (let back = 29; back >= 0; back -= 1) {
    const day = new Date(today.valueOf() - back * 864e5);
    const next = new Date(day.valueOf() + 864e5);
    const inDay = (value) => value != null && new Date(value) >= day && new Date(value) < next;
    days.push({
      date: day.toISOString().slice(0, 10),
      reported: issues.filter((i) => inDay(i.createdAt)).length,
      resolved: issues.filter((i) => inDay(i.resolvedAt)).length
    });
  }
  return days;
}
statsRouter.get(
  "/wards",
  route(async (_req, res) => {
    const wards = await Ward.find({}).lean();
    res.json({
      items: wards.map((w) => ({ ...ward(w), boundary: w.boundary, center: w.center }))
    });
  })
);

// apps/api/src/index.ts
var app = express();
app.set("trust proxy", 1);
app.use(
  helmet({
    // The API only serves JSON and images; the web app is a separate origin.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false
  })
);
app.use(cors({ origin: env.WEB_ORIGIN.split(",").map((o) => o.trim()), credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use(
  morgan(":method :url :status :response-time ms", {
    stream: { write: (line) => log.debug(line.trim()) },
    skip: (req) => req.path === "/health"
  })
);
app.use(attachUser);
if (storage.driver === "local") {
  app.use("/uploads", express.static(uploadRoot, { maxAge: "30d", immutable: true, fallthrough: true }));
}
app.get("/health", async (_req, res) => {
  const ai = await aiHealth();
  res.json({
    ok: true,
    service: "amar-shohor-api",
    env: env.NODE_ENV,
    storage: storage.driver,
    queueDepth: queueDepth(),
    ai,
    mail: { configured: mailerConfigured(), accounts: mailerStatus() }
  });
});
app.use("/v1/auth", authRouter);
app.use("/v1/media", mediaRouter);
app.use("/v1/reports", reportsRouter);
app.use("/v1/issues", issuesRouter);
app.use("/v1/authority", authorityRouter);
app.use("/v1/stats", statsRouter);
app.use((_req, res) => res.status(404).json({ error: "not_found", message: "No such endpoint" }));
app.use(errorHandler);
async function main() {
  await connectDb();
  void verifyAccounts();
  const server = app.listen(env.PORT, () => {
    log.info("api listening", { port: env.PORT, url: env.API_PUBLIC_URL, uploads: path3.relative(process.cwd(), uploadRoot) });
  });
  const shutdown = (signal) => {
    log.info("shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 1e4).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
void main();
