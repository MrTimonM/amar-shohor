import mongoose, { Schema, type Model, type Types } from 'mongoose';
import { CATEGORIES, DEPARTMENTS, ROLES, STATUSES } from '@amar/shared';
import type { Category, Department, GeoPoint, Role, Status } from '@amar/shared';

/**
 * Phase 03 — the data model.
 *
 * The distinction the whole product rests on: a `Report` is one citizen
 * submission, an `Issue` is the verified cluster those reports collapse into.
 * `StatusEvent` is append-only — the public timeline and the audit log are the
 * same rows, so there is no way to quietly rewrite history.
 *
 * Document shapes are written out as interfaces rather than derived with
 * mongoose's InferSchemaType. Inference on schemas this size costs several
 * gigabytes of compiler heap and produces types nobody can read in an editor
 * tooltip; declaring them is cheaper and self-documenting.
 */

// --- shared field shapes ----------------------------------------------------

export interface PhotoDoc {
  id: string;
  key: string;
  url: string;
  thumbUrl: string;
  width?: number;
  height?: number;
  bytes?: number;
  /**
   * Kept for the phase 09 integrity checks, never served publicly — the
   * serialiser in serialize.ts drops it.
   */
  exif?: {
    capturedAt?: Date;
    lat?: number;
    lng?: number;
    make?: string;
    model?: string;
  };
}

export interface PriorityFactorDoc {
  key: string;
  label: string;
  value: number;
  weight: number;
  points: number;
  detail: string;
}

export interface AiVerdictDoc {
  model?: string;
  category?: Category;
  categoryConfidence?: number;
  severity?: number;
  relevant?: boolean;
  embedding?: number[];
  integrity?: {
    exifGpsDriftM?: number;
    captureToSubmitMinutes?: number;
    screenshotSuspected?: boolean;
    reusedImage?: boolean;
  };
  overriddenByUser?: boolean;
  at?: Date;
}

const geoPoint = {
  type: { type: String, enum: ['Point'], required: true, default: 'Point' },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator: (v: number[]) => v.length === 2,
      message: 'coordinates must be [lng, lat]',
    },
  },
};

const photoSchema = new Schema<PhotoDoc>(
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
      model: String,
    },
  },
  { _id: false },
);

// --- Ward -------------------------------------------------------------------

export interface WardDoc {
  name: string;
  nameBn: string;
  cityCorporation: string;
  densityPerKm2: number;
  center?: GeoPoint;
  /** Polygon, so a report is stamped with its ward on write, not on read. */
  boundary?: { type: 'Polygon'; coordinates: number[][][] };
  createdAt?: Date;
  updatedAt?: Date;
}

const wardSchema = new Schema<WardDoc>(
  {
    name: { type: String, required: true },
    nameBn: { type: String, required: true },
    cityCorporation: { type: String, required: true },
    densityPerKm2: { type: Number, required: true },
    center: geoPoint,
    boundary: {
      type: { type: String, enum: ['Polygon'], default: 'Polygon' },
      coordinates: { type: [[[Number]]] },
    },
  },
  { timestamps: true },
);
wardSchema.index({ boundary: '2dsphere' });
wardSchema.index({ center: '2dsphere' });

// --- User -------------------------------------------------------------------

export interface UserDoc {
  /**
   * Email is the only sign-in identifier. Phone is kept as a contact detail
   * for the phase 13 SMS notifications and is never used to authenticate.
   */
  phone?: string;
  email: string;
  emailVerifiedAt?: Date;
  name: string;
  role: Role;
  department?: Department;
  wardIds?: Types.ObjectId[];
  /**
   * Phase 04 — rises with confirmed reports, falls with rejected ones. Used to
   * weight verification votes so a fresh account cannot swing an issue alone.
   */
  trust: number;
  reportCount: number;
  verifiedCount: number;
  lastSeenAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    // Sparse, because most accounts have no phone number at all and a plain
    // `unique` index would collide every such row on null.
    phone: { type: String, unique: true, sparse: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerifiedAt: Date,
    name: { type: String, required: true },
    role: { type: String, enum: ROLES, default: 'citizen', index: true },
    department: { type: String, enum: DEPARTMENTS },
    wardIds: [{ type: Schema.Types.ObjectId, ref: 'Ward' }],
    trust: { type: Number, default: 1, min: 0, max: 5 },
    reportCount: { type: Number, default: 0 },
    verifiedCount: { type: Number, default: 0 },
    lastSeenAt: Date,
  },
  { timestamps: true },
);

// --- Login challenge --------------------------------------------------------

/**
 * One row per sign-in attempt, holding both routes: a six-digit code and a
 * magic-link token. Whoever reads their mail on the same device taps the link;
 * whoever is signing in on a phone types the code. Consuming either one marks
 * the row used, so the other stops working — a link that stays live after the
 * code has been used is a second, quieter way in.
 *
 * Only hashes are stored. A leaked database should not hand out logins.
 */
export interface LoginChallengeDoc {
  /** The email address this challenge was issued to. */
  identifier: string;
  codeHash: string;
  magicHash?: string;
  /** Name typed at request time, applied on whichever route completes. */
  requestedName?: string;
  expiresAt: Date;
  attempts: number;
  consumedAt?: Date;
  consumedBy?: 'code' | 'link';
  requestedIp?: string;
}

const loginChallengeSchema = new Schema<LoginChallengeDoc>({
  identifier: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  magicHash: { type: String, index: true },
  requestedName: String,
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  consumedAt: Date,
  consumedBy: { type: String, enum: ['code', 'link'] },
  requestedIp: String,
});
// Mongo drops the document itself once it expires — no cleanup job needed.
loginChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// --- Upload -----------------------------------------------------------------

export interface UploadDoc {
  photo: PhotoDoc;
  ownerId: Types.ObjectId;
  claimedAt?: Date;
  expiresAt: Date;
}

/**
 * A photo that has been stored but not yet attached to a report. The client
 * submits photo *ids*, never URLs, so a forged URL cannot end up on the map.
 * Unclaimed rows expire on their own.
 */
const uploadSchema = new Schema<UploadDoc>({
  photo: { type: photoSchema, required: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  claimedAt: Date,
  expiresAt: { type: Date, required: true },
});
uploadSchema.index({ 'photo.id': 1 }, { unique: true });
uploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// --- Report -----------------------------------------------------------------

export interface ReportDoc {
  ref: string;
  category: Category;
  severity: number;
  description?: string;
  location: GeoPoint;
  accuracy?: number;
  address?: string;
  photos: PhotoDoc[];
  reporterId?: Types.ObjectId;
  wardId?: Types.ObjectId;
  ai?: AiVerdictDoc;
  /** Set once dedup attached it. Null means it is still in the review queue. */
  issueId?: Types.ObjectId | null;
  mergeConfidence?: number;
  mergeDecision?: 'auto' | 'reviewed' | 'new' | 'pending';
  queuedOffline?: boolean;
  capturedAt?: Date;
  rejectedReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const aiVerdictSchema = new Schema<AiVerdictDoc>(
  {
    model: String,
    category: { type: String, enum: CATEGORIES },
    categoryConfidence: Number,
    severity: Number,
    relevant: Boolean,
    embedding: { type: [Number], default: undefined },
    integrity: {
      exifGpsDriftM: Number,
      captureToSubmitMinutes: Number,
      screenshotSuspected: Boolean,
      reusedImage: Boolean,
    },
    overriddenByUser: Boolean,
    at: Date,
  },
  { _id: false },
);

const reportSchema = new Schema<ReportDoc>(
  {
    ref: { type: String, required: true, unique: true },
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    severity: { type: Number, min: 1, max: 5, default: 3 },
    description: String,
    location: geoPoint,
    accuracy: Number,
    address: String,
    photos: { type: [photoSchema], default: [] },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    wardId: { type: Schema.Types.ObjectId, ref: 'Ward', index: true },
    ai: aiVerdictSchema,
    issueId: { type: Schema.Types.ObjectId, ref: 'Issue', index: true },
    mergeConfidence: Number,
    mergeDecision: {
      type: String,
      enum: ['auto', 'reviewed', 'new', 'pending'],
      default: 'pending',
      index: true,
    },
    queuedOffline: Boolean,
    capturedAt: Date,
    rejectedReason: String,
  },
  { timestamps: true },
);
reportSchema.index({ location: '2dsphere' });
reportSchema.index({ createdAt: -1 });

// --- Issue ------------------------------------------------------------------

export interface IssueDoc {
  ref: string;
  title: string;
  category: Category;
  status: Status;
  severity: number;
  description?: string;
  /** The centroid of the merged reports, recomputed on every merge. */
  location: GeoPoint;
  address?: string;
  wardId?: Types.ObjectId;

  reportIds: Types.ObjectId[];
  reportCount: number;
  photos: PhotoDoc[];
  proofPhotos: PhotoDoc[];

  /** Denormalised so the map can sort by priority without recomputing. */
  priorityScore: number;
  priorityBand: 'critical' | 'high' | 'medium' | 'low';
  priorityFactors: PriorityFactorDoc[];

  /** Mean of the merged reports' image embeddings — the dedup anchor. */
  embedding?: number[];

  confirms: number;
  disputes: number;
  weightedConfirms: number;
  weightedDisputes: number;

  assigneeId?: Types.ObjectId;
  department?: Department;
  slaDueAt?: Date;
  assignedAt?: Date;
  verifiedAt?: Date;
  resolvedAt?: Date;
  firstReportAt: Date;
  /** Only a reporter's own sign-off counts toward resolution statistics. */
  citizenSignedOffAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const priorityFactorSchema = new Schema<PriorityFactorDoc>(
  { key: String, label: String, value: Number, weight: Number, points: Number, detail: String },
  { _id: false },
);

const issueSchema = new Schema<IssueDoc>(
  {
    ref: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    status: { type: String, enum: STATUSES, default: 'reported', index: true },
    severity: { type: Number, min: 1, max: 5, default: 3 },
    description: String,
    location: geoPoint,
    address: String,
    wardId: { type: Schema.Types.ObjectId, ref: 'Ward', index: true },

    reportIds: [{ type: Schema.Types.ObjectId, ref: 'Report' }],
    reportCount: { type: Number, default: 1, index: true },
    photos: { type: [photoSchema], default: [] },
    proofPhotos: { type: [photoSchema], default: [] },

    priorityScore: { type: Number, default: 0, index: true },
    priorityBand: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'low',
      index: true,
    },
    priorityFactors: { type: [priorityFactorSchema], default: [] },

    embedding: { type: [Number], default: undefined },

    confirms: { type: Number, default: 0 },
    disputes: { type: Number, default: 0 },
    weightedConfirms: { type: Number, default: 0 },
    weightedDisputes: { type: Number, default: 0 },

    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    department: { type: String, enum: DEPARTMENTS, index: true },
    slaDueAt: Date,
    assignedAt: Date,
    verifiedAt: Date,
    resolvedAt: Date,
    firstReportAt: { type: Date, required: true },
    citizenSignedOffAt: Date,
  },
  { timestamps: true },
);
issueSchema.index({ location: '2dsphere' });
issueSchema.index({ status: 1, priorityScore: -1 });
issueSchema.index({ department: 1, status: 1, slaDueAt: 1 });

// --- StatusEvent (append-only) ---------------------------------------------

export interface StatusEventDoc {
  issueId: Types.ObjectId;
  status: Status;
  from?: Status;
  note?: string;
  actorId?: Types.ObjectId;
  actorName?: string;
  actorRole?: Role;
  proofPhotos?: PhotoDoc[];
  at?: Date;
}

const statusEventSchema = new Schema<StatusEventDoc>({
  issueId: { type: Schema.Types.ObjectId, ref: 'Issue', required: true, index: true },
  status: { type: String, enum: STATUSES, required: true },
  from: { type: String, enum: STATUSES },
  note: String,
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorName: String,
  actorRole: { type: String, enum: ROLES },
  proofPhotos: { type: [photoSchema], default: [] },
  at: { type: Date, default: () => new Date(), index: true },
});

// Refuse updates and deletes at the model layer, not just by convention.
const APPEND_ONLY = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;
for (const op of APPEND_ONLY) {
  statusEventSchema.pre(op as 'updateOne', function () {
    throw new Error('StatusEvent is append-only: the public timeline and the audit log are the same data');
  });
}

// --- Verification -----------------------------------------------------------

export interface VerificationDoc {
  issueId: Types.ObjectId;
  userId: Types.ObjectId;
  vote: 'confirm' | 'dispute';
  /** Snapshot of the voter's trust at vote time, so history stays reproducible. */
  weight: number;
  distanceM?: number;
  note?: string;
  at?: Date;
}

const verificationSchema = new Schema<VerificationDoc>({
  issueId: { type: Schema.Types.ObjectId, ref: 'Issue', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  vote: { type: String, enum: ['confirm', 'dispute'], required: true },
  weight: { type: Number, default: 1 },
  distanceM: Number,
  note: String,
  at: { type: Date, default: () => new Date() },
});
verificationSchema.index({ issueId: 1, userId: 1 }, { unique: true });

// --- Exports ----------------------------------------------------------------

const m = <T>(name: string, schema: Schema<T>): Model<T> =>
  (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);

export const Ward = m<WardDoc>('Ward', wardSchema);
export const User = m<UserDoc>('User', userSchema);
export const LoginChallenge = m<LoginChallengeDoc>('LoginChallenge', loginChallengeSchema);
export const Upload = m<UploadDoc>('Upload', uploadSchema);
export const Report = m<ReportDoc>('Report', reportSchema);
export const Issue = m<IssueDoc>('Issue', issueSchema);
export const StatusEvent = m<StatusEventDoc>('StatusEvent', statusEventSchema);
export const Verification = m<VerificationDoc>('Verification', verificationSchema);
