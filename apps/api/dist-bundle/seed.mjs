// apps/api/src/seed.ts
import mongoose2 from "mongoose";

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

// apps/api/src/http.ts
import { ZodError } from "zod";
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
  const ward = report.wardId ? await Ward.findById(report.wardId).lean() : await nearestWard(report.location);
  const meta = CATEGORY_META[report.category];
  const priority = computePriority({
    category: report.category,
    severity: report.severity ?? 3,
    reportCount: 1,
    wardDensity: ward?.densityPerKm2 ?? 2e4,
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
    wardId: ward?._id,
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
    { $set: { issueId: issue._id, mergeDecision: "new", wardId: ward?._id } }
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
  const alreadyIn = (issue.reportIds ?? []).some((id) => String(id) === String(report._id));
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
  const ward = issue.wardId ? await Ward.findById(issue.wardId).lean() : null;
  const ageHours = (Date.now() - new Date(issue.firstReportAt).valueOf()) / 36e5;
  const priority = computePriority({
    category: issue.category,
    severity: issue.severity ?? 3,
    reportCount: issue.reportCount ?? 1,
    wardDensity: ward?.densityPerKm2 ?? 2e4,
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

// apps/api/src/seed.ts
var rngState = 2654435769;
function rnd() {
  rngState = rngState + 1831565813 | 0;
  let t = Math.imul(rngState ^ rngState >>> 15, 1 | rngState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
var pick = (arr) => arr[Math.floor(rnd() * arr.length)];
var between = (min, max) => min + rnd() * (max - min);
var intBetween = (min, max) => Math.floor(between(min, max + 1));
var WARDS = [
  { name: "Gulshan", nameBn: "\u0997\u09C1\u09B2\u09B6\u09BE\u09A8", cc: "Dhaka North", lat: 23.7925, lng: 90.4142, density: 22e3 },
  { name: "Banani", nameBn: "\u09AC\u09A8\u09BE\u09A8\u09C0", cc: "Dhaka North", lat: 23.7936, lng: 90.4004, density: 26e3 },
  { name: "Uttara", nameBn: "\u0989\u09A4\u09CD\u09A4\u09B0\u09BE", cc: "Dhaka North", lat: 23.8759, lng: 90.3795, density: 19e3 },
  { name: "Mirpur", nameBn: "\u09AE\u09BF\u09B0\u09AA\u09C1\u09B0", cc: "Dhaka North", lat: 23.8223, lng: 90.3654, density: 41e3 },
  { name: "Mohammadpur", nameBn: "\u09AE\u09CB\u09B9\u09BE\u09AE\u09CD\u09AE\u09A6\u09AA\u09C1\u09B0", cc: "Dhaka North", lat: 23.7657, lng: 90.3586, density: 45e3 },
  { name: "Dhanmondi", nameBn: "\u09A7\u09BE\u09A8\u09AE\u09A8\u09CD\u09A1\u09BF", cc: "Dhaka South", lat: 23.7461, lng: 90.3742, density: 3e4 },
  { name: "Tejgaon", nameBn: "\u09A4\u09C7\u099C\u0997\u09BE\u0981\u0993", cc: "Dhaka North", lat: 23.7639, lng: 90.3936, density: 28e3 },
  { name: "Motijheel", nameBn: "\u09AE\u09A4\u09BF\u099D\u09BF\u09B2", cc: "Dhaka South", lat: 23.733, lng: 90.4172, density: 34e3 },
  { name: "Lalbagh", nameBn: "\u09B2\u09BE\u09B2\u09AC\u09BE\u0997", cc: "Dhaka South", lat: 23.7186, lng: 90.3881, density: 52e3 },
  { name: "Jatrabari", nameBn: "\u09AF\u09BE\u09A4\u09CD\u09B0\u09BE\u09AC\u09BE\u09A1\u09BC\u09C0", cc: "Dhaka South", lat: 23.7104, lng: 90.4364, density: 38e3 }
];
var CITIZEN_NAMES = [
  "Rafiq Islam",
  "Nusrat Jahan",
  "Tanvir Ahmed",
  "Sabina Yasmin",
  "Imran Hossain",
  "Mehjabin Chowdhury",
  "Arif Rahman",
  "Farhana Akter",
  "Sohel Rana",
  "Tasnim Reza",
  "Kamrul Hasan",
  "Shirin Sultana",
  "Jubayer Alam",
  "Rumana Haque",
  "Nafis Iqbal",
  "Anika Tabassum",
  "Masud Karim",
  "Priya Das",
  "Rezaul Karim",
  "Ishrat Binte"
];
var DESCRIPTIONS = {
  road_damage: [
    "Deep pothole in the middle of the lane, rickshaws are tipping into it.",
    "The road has broken up badly after the rain. Two wheelers cannot pass safely.",
    "Large crater near the bus stop, it has been growing for weeks."
  ],
  waterlogging: [
    "Knee-deep water outside the school gate every time it rains.",
    "The drain is blocked so the whole lane floods within minutes.",
    "Standing water has not drained for four days now."
  ],
  garbage: [
    "Garbage has piled up at the corner and nobody has collected it.",
    "The bin overflowed days ago, the smell reaches the flats above.",
    "Waste dumped on the footpath, blocking the whole width."
  ],
  streetlight: [
    "Three lights in a row are dead, the stretch is completely dark after 7pm.",
    "The pole light has been off for two weeks. Women avoid this lane at night.",
    "Streetlight flickers all night and then goes out."
  ],
  traffic_signal: [
    "The signal has been dead since Friday and traffic police are managing by hand.",
    "Only the red lamp works, drivers are guessing.",
    "Signal timing is stuck, the crossing never gets a green."
  ],
  sidewalk: [
    "Footpath slabs are missing, an elderly man fell here yesterday.",
    "The sidewalk is broken open over the drain, it is a real hazard at night.",
    "Tiles lifted across the whole stretch, wheelchairs cannot use it."
  ],
  congestion: [
    "This intersection locks up for forty minutes every evening.",
    "Illegal parking on both sides has narrowed the road to one lane.",
    "Bus stand overflow blocks the junction all through the morning."
  ],
  environmental: [
    "Open drain running alongside the footpath, the smell is unbearable.",
    "Construction dust covering the whole block, no screening at all.",
    "Waste being burned in the open at the back of the lane."
  ]
};
var AUTHORITY_STAFF = [
  { name: "Md. Shahjahan Ali", department: "roads" },
  { name: "Nasrin Akhter", department: "water" },
  { name: "Abdul Momen", department: "waste" },
  { name: "Rina Parveen", department: "electrical" },
  { name: "Habibur Rahman", department: "traffic" },
  { name: "Selina Hossain", department: "environment" }
];
var metersToLat = (m2) => m2 / 111320;
var metersToLng = (m2, lat) => m2 / (111320 * Math.cos(lat * Math.PI / 180));
function jitter(lat, lng, meters) {
  const angle = rnd() * Math.PI * 2;
  const dist = rnd() * meters;
  return {
    lat: lat + metersToLat(Math.sin(angle) * dist),
    lng: lng + metersToLng(Math.cos(angle) * dist, lat)
  };
}
function squareBoundary(lat, lng, halfMeters) {
  const dLat = metersToLat(halfMeters);
  const dLng = metersToLng(halfMeters, lat);
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - dLng, lat - dLat],
        [lng + dLng, lat - dLat],
        [lng + dLng, lat + dLat],
        [lng - dLng, lat + dLat],
        [lng - dLng, lat - dLat]
      ]
    ]
  };
}
var photoFor = (category, seed) => {
  const url = `${env.API_PUBLIC_URL}/v1/media/placeholder/${category}/${seed}`;
  return {
    id: `seed-${category}-${seed}`,
    key: `seed/${category}/${seed}`,
    url,
    thumbUrl: url,
    width: 420,
    height: 320,
    bytes: 4200
  };
};
var seedEmail = (name, suffix) => `${name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}@${suffix}.amarshohor.test`;
async function wipe() {
  await Promise.all([
    Ward.deleteMany({}),
    User.deleteMany({}),
    Report.deleteMany({}),
    Issue.deleteMany({}),
    Verification.deleteMany({}),
    Upload.deleteMany({}),
    // StatusEvent refuses updates and deletes through the model, by design —
    // the seed drops the collection directly, which is the one legitimate
    // place to do it.
    StatusEvent.collection.deleteMany({})
  ]);
}
async function main() {
  if (env.NODE_ENV === "production") {
    console.error("Refusing to seed a production database.");
    process.exit(1);
  }
  try {
    await mongoose2.connect(env.MONGO_URL, { serverSelectionTimeoutMS: 8e3 });
  } catch {
    console.error(
      [
        "",
        "Could not reach MongoDB, so there is nothing to seed.",
        "Start one locally, or point MONGO_URL at an Atlas cluster in your .env file.",
        ""
      ].join("\n")
    );
    process.exit(1);
  }
  await mongoose2.connection.syncIndexes();
  log.info("seeding", { db: mongoose2.connection.name });
  await wipe();
  const wards = await Ward.insertMany(
    WARDS.map((w) => ({
      name: w.name,
      nameBn: w.nameBn,
      cityCorporation: w.cc,
      densityPerKm2: w.density,
      center: { type: "Point", coordinates: [w.lng, w.lat] },
      boundary: squareBoundary(w.lat, w.lng, 900)
    }))
  );
  log.info("wards created", { count: wards.length });
  const staffEmails = env.SEED_STAFF_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const adminEmail = env.SEED_ADMIN_EMAIL.trim().toLowerCase() || void 0;
  const admin = await User.create({
    phone: "+8801700000000",
    email: adminEmail ?? seedEmail("City Administrator", "city"),
    emailVerifiedAt: /* @__PURE__ */ new Date(),
    name: "City Administrator",
    role: "admin",
    trust: 5
  });
  const staff = await User.insertMany(
    AUTHORITY_STAFF.map((member, i) => {
      return {
        phone: `+88017111111${String(i).padStart(2, "0")}`,
        email: staffEmails[i] ?? seedEmail(member.name, member.department),
        emailVerifiedAt: /* @__PURE__ */ new Date(),
        name: member.name,
        role: "authority",
        department: member.department,
        trust: 5,
        wardIds: []
      };
    })
  );
  const citizens = await User.insertMany(
    CITIZEN_NAMES.map((name, i) => ({
      phone: `+88018${String(2e7 + i * 7919).padStart(8, "0")}`,
      email: seedEmail(name, "citizen"),
      emailVerifiedAt: /* @__PURE__ */ new Date(),
      name,
      role: i < 4 ? "verifier" : "citizen",
      // A spread of trust, so weighted verification is visibly doing something.
      trust: Number(between(0.6, 3.4).toFixed(2))
    }))
  );
  log.info("users created", { admin: 1, staff: staff.length, citizens: citizens.length });
  const CLUSTERS = 58;
  let photoSeed = 0;
  let reportTotal = 0;
  for (let c = 0; c < CLUSTERS; c += 1) {
    const ward = pick(WARDS);
    const wardDoc = wards.find((w) => w.name === ward.name);
    const category = pick(CATEGORIES);
    const spot = jitter(ward.lat, ward.lng, 780);
    const reportsInCluster = rnd() < 0.42 ? intBetween(2, 5) : 1;
    const firstDaysAgo = between(0.2, 44);
    for (let r = 0; r < reportsInCluster; r += 1) {
      const reporter = pick(citizens);
      const daysAgo = Math.max(0.05, firstDaysAgo - r * between(0.1, 2.2));
      const createdAt = new Date(Date.now() - daysAgo * 864e5);
      const at = jitter(spot.lat, spot.lng, r === 0 ? 4 : between(6, 34));
      photoSeed += 1;
      const doc = await Report.create({
        ref: makeRef("RP"),
        category,
        severity: intBetween(2, 5),
        description: rnd() < 0.8 ? pick(DESCRIPTIONS[category]) : void 0,
        location: { type: "Point", coordinates: [at.lng, at.lat] },
        accuracy: Math.round(between(6, 38)),
        address: `${ward.name}, ${ward.cc}`,
        photos: [photoFor(category, photoSeed)],
        reporterId: reporter._id,
        wardId: wardDoc?._id,
        queuedOffline: rnd() < 0.08,
        mergeDecision: "pending"
      });
      await Report.collection.updateOne(
        { _id: doc._id },
        { $set: { createdAt, updatedAt: createdAt } }
      );
      const fresh = await Report.findById(doc._id).lean();
      if (!fresh) continue;
      if (r === 0) {
        await createIssueFromReport(fresh);
      } else {
        await resolveReport(fresh);
      }
      reportTotal += 1;
    }
    await User.updateOne({ _id: pick(citizens)._id }, { $inc: { reportCount: reportsInCluster } });
  }
  const issues = await Issue.find({});
  log.info("dedup complete", { reports: reportTotal, issues: issues.length, merged: reportTotal - issues.length });
  for (const issue of issues) {
    if (rnd() < 0.12) continue;
    const voters = [...citizens].sort(() => rnd() - 0.5).slice(0, intBetween(2, 9));
    let confirms = 0;
    let disputes = 0;
    let weightedConfirms = 0;
    let weightedDisputes = 0;
    for (const voter of voters) {
      const vote = rnd() < 0.86 ? "confirm" : "dispute";
      const weight = Math.max(0.25, Math.min(voter.trust ?? 1, 5));
      await Verification.create({
        issueId: issue._id,
        userId: voter._id,
        vote,
        weight,
        distanceM: intBetween(20, 380),
        at: new Date(new Date(issue.firstReportAt).valueOf() + between(1, 48) * 36e5)
      });
      if (vote === "confirm") {
        confirms += 1;
        weightedConfirms += weight;
      } else {
        disputes += 1;
        weightedDisputes += weight;
      }
    }
    issue.confirms = confirms;
    issue.disputes = disputes;
    issue.weightedConfirms = weightedConfirms;
    issue.weightedDisputes = weightedDisputes;
    if (weightedConfirms >= env.VERIFY_THRESHOLD && weightedConfirms > weightedDisputes * 2) {
      issue.status = "verified";
      issue.verifiedAt = new Date(new Date(issue.firstReportAt).valueOf() + between(4, 60) * 36e5);
      await StatusEvent.create({
        issueId: issue._id,
        status: "verified",
        from: "reported",
        note: `Confirmed by ${confirms} nearby ${confirms === 1 ? "citizen" : "citizens"}`,
        actorName: "Community",
        actorRole: "verifier",
        at: issue.verifiedAt
      });
    }
    await issue.save();
  }
  const verified = await Issue.find({ status: "verified" });
  for (const issue of verified) {
    const roll = rnd();
    if (roll < 0.18) continue;
    const firstAt = new Date(issue.firstReportAt).valueOf();
    const ageMs = Math.max(36e5, Date.now() - firstAt);
    const at = (fraction) => new Date(firstAt + ageMs * fraction * between(0.85, 1.15));
    const owner = staff.find((s) => s.department === issue.department) ?? pick(staff);
    const assignedAt = at(0.25);
    const slaHours = CATEGORY_META[issue.category].slaHours;
    issue.status = "assigned";
    issue.assigneeId = owner._id;
    issue.assignedAt = assignedAt;
    issue.slaDueAt = new Date(assignedAt.valueOf() + slaHours * 36e5);
    await StatusEvent.create({
      issueId: issue._id,
      status: "assigned",
      from: "verified",
      note: `Assigned to ${owner.name}, ${issue.department}`,
      actorId: admin._id,
      actorName: admin.name,
      actorRole: "admin",
      at: assignedAt
    });
    if (roll < 0.38) {
      await issue.save();
      continue;
    }
    const startedAt = at(0.5);
    issue.status = "in_progress";
    await StatusEvent.create({
      issueId: issue._id,
      status: "in_progress",
      from: "assigned",
      note: pick([
        "Crew scheduled, materials requisitioned.",
        "Work has started on site.",
        "Contractor mobilised this morning."
      ]),
      actorId: owner._id,
      actorName: owner.name,
      actorRole: "authority",
      at: startedAt
    });
    if (roll < 0.58) {
      await issue.save();
      continue;
    }
    photoSeed += 1;
    const resolvedAt = at(0.78);
    issue.status = "resolved";
    issue.resolvedAt = resolvedAt;
    issue.proofPhotos = [photoFor(issue.category, photoSeed)];
    if (rnd() < 0.7) issue.citizenSignedOffAt = at(0.9);
    await StatusEvent.create({
      issueId: issue._id,
      status: "resolved",
      from: "in_progress",
      note: pick([
        "Repair completed and inspected.",
        "Cleared and the site was checked afterwards.",
        "Fixed. Photo of the completed work attached."
      ]),
      actorId: owner._id,
      actorName: owner.name,
      actorRole: "authority",
      proofPhotos: issue.proofPhotos,
      at: resolvedAt
    });
    await issue.save();
  }
  const all = await Issue.find({});
  for (const issue of all) {
    await Issue.collection.updateOne(
      { _id: issue._id },
      { $set: { createdAt: issue.firstReportAt } }
    );
    await recomputePriority(String(issue._id));
  }
  const holdBack = await Report.find({ mergeDecision: "auto" }).limit(3);
  for (const report of holdBack) {
    await Report.updateOne(
      { _id: report._id },
      { $set: { mergeDecision: "pending", issueId: null, mergeConfidence: Number(between(0.52, 0.7).toFixed(3)) } }
    );
    await Issue.updateOne({ _id: report.issueId }, { $pull: { reportIds: report._id }, $inc: { reportCount: -1 } });
  }
  const counts = {
    wards: await Ward.countDocuments(),
    users: await User.countDocuments(),
    reports: await Report.countDocuments(),
    issues: await Issue.countDocuments(),
    resolved: await Issue.countDocuments({ status: "resolved" }),
    inReview: await Report.countDocuments({ mergeDecision: "pending", issueId: null }),
    verifications: await Verification.countDocuments(),
    events: await StatusEvent.countDocuments()
  };
  const statuses = await Issue.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  console.log("\n  Seed complete\n");
  console.table(counts);
  console.table(statuses.map((s) => ({ status: s._id, issues: s.n })));
  const signInLines = [
    adminEmail ? `    Admin      ${adminEmail}` : "    Admin      (set SEED_ADMIN_EMAIL to make this account reachable)",
    ...AUTHORITY_STAFF.map(
      (member, i) => staffEmails[i] ? `    Authority  ${staffEmails[i]}  (${member.department})` : `    Authority  \u2014 no email set \u2014  (${member.department})`
    ).slice(0, Math.max(1, staffEmails.length))
  ];
  console.log(`
  Sign in by email. A code and a magic link are sent to the address; either works.
  Staff accounts (set from SEED_ADMIN_EMAIL / SEED_STAFF_EMAILS):

${signInLines.join("\n")}

  Any other address creates an ordinary citizen account on first sign-in.
`);
  await mongoose2.disconnect();
}
main().catch(async (err) => {
  console.error(err);
  await mongoose2.disconnect().catch(() => {
  });
  process.exit(1);
});
