# Amar Shohor — আমার শহর

Citizens report city problems in under a minute. Duplicate reports collapse into **one verified
problem** on a live map, ranked by an explainable priority score, assigned to an authority, and
tracked in public until it is fixed.

Built from [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md). See
[What is and isn't built](#what-is-and-isnt-built) before demoing — the honest scope matters.

---

## Run it

You need **Node 20+** and a **MongoDB** you can reach. Everything else is npm.

```bash
cp .env.example .env          # then set MONGO_URL (see below)
npm install
npm run seed                  # ~58 problem clusters across 10 Dhaka wards
npm run dev                   # API on :4000, web on :5173
```

Open **http://localhost:5173**.

### Getting a MongoDB

Any one of these; nothing in the code changes between them.

| Option | What to put in `MONGO_URL` |
|---|---|
| **MongoDB Atlas** free tier (no local install) | the SRV string from *Connect → Drivers* |
| Local install ([Community Server](https://www.mongodb.com/try/download/community)) | `mongodb://localhost:27017/amar_shohor` |
| Docker, if you happen to have it | `mongodb://localhost:27017/amar_shohor` after `docker compose up -d mongo` |

Atlas is the least work: create a free M0 cluster, allow your IP, paste the string. The seed
script and the API both print a readable message rather than a stack trace if they cannot connect.

### Signing in

**Email only, and passwordless.** The citizen this is built for will not create and remember a
password, and a forgotten password is a citizen who stops reporting.

One email carries two routes: a **magic link** and a **six-digit code**. That is not indecision —
someone reading their mail on the same device taps the link, while someone signing in on a phone
with their mail open on a laptop types the code. Either one works, and **using one immediately
cancels the other**: a link still live after the code has been used is a second, quieter way in.

Links are single-use, both routes expire in 15 minutes, five wrong codes locks the attempt, and
codes and tokens are stored **only as HMACs** — a leaked database hands out no logins. Nothing is
ever echoed back in an API response; the only way in is the inbox.

Any address creates a citizen account on first sign-in. Staff accounts are seeded from
`SEED_ADMIN_EMAIL` and `SEED_STAFF_EMAILS`, because a role nobody can sign into is a role that
cannot be demonstrated. Seeded people who are not the operator get addresses under the reserved
`.test` TLD, which by RFC 2606 can never resolve — so no seeded row can accidentally mail a real
person.

Sending uses a pool of SMTP accounts in `SMTP_ACCOUNTS` (`user:pass,user:pass`). A send tries them
in order and moves on when one refuses, putting the failed account in a five-minute cooldown and
starting the next send from whichever account last worked. Credentials are checked once at boot, so
a bad password shows up in the log immediately rather than the first time somebody signs in.
Consumer mailboxes rate-limit hard and lock without warning, which is why this is a pool rather than
a single transport — phase 14 should point it at SES.

> **GMX and similar providers refuse SMTP until "access via POP3/IMAP" is enabled** in each
> mailbox's own settings. A `535 Authentication credentials invalid` is almost always that, not a
> wrong password.

**Phone sign-in was removed.** There is no SMS gateway, and a channel that cannot deliver is worse
than one that is absent: the endpoints, schemas and UI are gone rather than left to fail. `phone`
survives on the user record as a contact detail for the phase 13 SMS notifications, and is never
used to authenticate.

### The AI service (optional)

The app works with this switched off — reports still succeed and get enriched later. To run it:

```bash
cd services/ai
python -m venv .venv && .venv/Scripts/activate     # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

`GET /health` reports p50/p95 latency, mean confidence, and the **override rate** — how often a
citizen disagreed with the model, which is the most useful drift signal there is.

---

## Where things are

```
amar-shohor/
├─ packages/shared/          One source of truth for both sides of the wire
│  ├─ domain.ts              8 categories, lifecycle + legal transitions, roles
│  ├─ priority.ts            The explainable score — 5 named factors, weights sum to 100
│  ├─ schemas.ts             Zod request/response shapes
│  └─ types.ts               Response DTOs
├─ apps/api/                 Express + Mongoose
│  ├─ models.ts              Report vs Issue, append-only StatusEvent
│  ├─ dedup.ts               Candidate generation, match scoring, merge
│  ├─ ai.ts                  Async job queue + AI client + vector helpers
│  ├─ storage.ts             StorageAdapter: local now, S3 in phase 14
│  ├─ seed.ts                Deterministic Dhaka data with real duplicate clusters
│  └─ routes/                auth, media, reports, issues, authority, stats
├─ apps/web/                 React + Vite, plain CSS design system
│  ├─ styles/tokens.css      Light / dark / system in one token layer
│  ├─ components/            Icon set, MapCanvas, charts, issue parts
│  └─ pages/                 Map, Issue, Report, Mine, Dashboard, Queue, Review
└─ services/ai/              FastAPI — vision, severity, relevance, embeddings
```

---

## The four things worth looking at

**1 · Deduplication that shows its work.** `apps/api/src/dedup.ts` scores each candidate on
distance, category agreement, time proximity, image-embedding similarity and text overlap, then
renormalises over the factors that actually had data — so a missing embedding does not silently
cap every score. Above `DEDUP_AUTO_MERGE` it merges; between that and `DEDUP_REVIEW` it holds for
a human, because a wrong merge hides a real problem. The **merge proof card** on the issue page
puts "3 reports → 1 problem" on screen with the contributing photos.

**2 · A priority score a citizen can audit.** No black box on a public accountability tool. Every
API response carries the five factors, each with its normalised value, its weight, the points it
contributed, and a plain-language reason. The UI renders exactly that and never recomputes it.

**3 · Dark mode as one system.** `tokens.css` defines the full light palette on bare `:root`,
redefines only tokens under `prefers-color-scheme: dark` (guarded so an explicit light choice wins),
and again under `[data-theme="dark"]`. An inline script in `index.html` applies the stored choice
before first paint. The map basemap swaps with it, so it is part of the design rather than a bright
rectangle punched through a dark page.

**4 · Nothing blocks the citizen.** Submit writes the report and returns; vision analysis and dedup
run in a background job. A dead connection sends the report — photo and all — to IndexedDB, and it
flushes itself on reconnect. `MyReportsPage` lists anything still unsent instead of hiding it.

---

## What is and isn't built

Built and working end to end: phases **01–07** (foundations, design system + dark mode, data model,
auth, report flow, media pipeline, live map), **10** (dedup, explainable priority, moderator
console), **12** (proximity-gated, trust-weighted verification), **13** (authority workspace, SLA
clock, mandatory proof-of-fix, public timeline, citizen sign-off) and the **14** dashboard.

Deliberately incomplete, and marked as such in the code rather than faked:

| Gap | Why, and where it is marked |
|---|---|
| **Vision models are heuristics, not trained** | Phase 09 needs a few thousand labelled Bangladeshi street photos, which do not exist yet. `services/ai/app/registry.py` flags each model `trained: True/False`; the classifier caps its own confidence at 0.62 and the citizen's category always wins. Every citizen override is logged as training signal — that is how the dataset gets built. |
| **Embeddings are a DCT perceptual hash** | Genuinely good at near-duplicates of the same spot, which is what dedup needs today. Phase 09 swaps in DINOv2/CLIP so different angles also match. |
| **Vector search runs in-process** | Cosine over the handful of candidates the geo query returns. Phase 10 moves it to Atlas Vector Search; `cosine()` is the only call site. |
| **S3 driver throws 501** | The interface and the local driver are done; phase 14 fills in presigned uploads. `STORAGE_DRIVER=local` until then. |
| **Predictive hotspots absent** | Needs a full monsoon of history before a forecast means anything. The dashboard says so on the page instead of showing invented numbers. |
| **No SMS, no web push** | Both are gateway integrations. OTP codes are logged and echoed in dev. |
| **Terraform not written** | Phase 14. The local↔AWS mapping it implements is in the plan. |

---

## Verified

Checked by running it, not by inspection:

- `npm run typecheck` — API and web both clean. `vite build` succeeds.
- **Seeded and served for real**: 127 reports collapse into 58 problems (69 duplicates merged) across
  10 Dhaka wards, with a full lifecycle spread — 12 reported, 9 verified, 10 assigned, 9 in progress,
  18 resolved.
- **Dashboard figures are sane**: 31% resolution rate, 12.6-day median fix time, 17 SLA breaches
  across six departments, trend data on 25 of the last 30 days.
- **The app renders end to end** (headless Chrome, zero console errors): top bar, sidebar with 15
  issue rows in Bengali, Leaflet map with tiles, 4 cluster bubbles, priority-band tags, filter chips.
  `/dashboard`, `/signin` and `/report` all render clean too.
- Priority scoring: factor points sum to the reported score; weights total exactly 100.
- Geometry: haversine returns 99.9 m for a computed 100 m offset.
- Lifecycle: `reported→verified` legal; `reported→resolved` and `resolved→rejected` refused.
- Vectors: cosine 1.0 identical, 0 orthogonal, 0 (not a crash) on length mismatch.
- DCT basis is orthonormal and the transform invertible.
- Python service compiles; all three modules import cleanly.
- **Sign-in is email-only**: the phone endpoints return 404, and the page renders one email field
  with no channel toggle and no code echoed anywhere.
- **Email sign-in exercised against real mailboxes**: all three GMX accounts authenticate; a login
  email delivers; a wrong code is rejected; the correct code signs in; the magic link signs in; the
  link is single-use; using the code kills the link and using the link kills the code; a garbage
  token and a malformed address are both refused.
- **Failover proven** by poisoning the first account's password: boot verification caught the 535,
  cooled that account down, and the next send went out through the second account.
- Chart palette run through the colour-vision validator in **both** themes — all six checks pass. The
  obvious green/amber pair failed deuteranopia separation, which is why the trend chart is blue and
  orange.

**Still unverified:** dark mode was checked structurally (token blocks, no colour defined only inside
a media query) but not compared side by side in a browser; the AI service was never run against the
API, so the enrichment path is exercised only by its fallback; and no test suite exists yet — the
checks above were run by hand.

### Bugs this shook out

Worth recording, because each one is a trap that type checking and a green build both miss:

| Symptom | Cause |
|---|---|
| `tsc` exhausted 4 GB of heap | mongoose's `InferSchemaType` on schemas this size. Document shapes are now declared as interfaces. |
| API would not boot | `{ ...geoPoint, required: true }` — spreading a sibling `required` into a nested GeoJSON definition makes mongoose parse `required` as its own schema *path*. |
| Every defaulted query field read as possibly `undefined` | `parse<T>(schema: ZodSchema<T>)` infers Zod's *input* type, where `.default()` fields are still optional. Now inferred from the schema. |
| Blank white page, clean build | `L.map()` with no `maxZoom`. The cluster layer attaches before the tile layer exists and calls `getMaxZoom()`, and Leaflet throws — taking down the whole app, not just the map. Building never executes the module, so the build stayed green. |
| Blank page hid its own cause | The first error handler wrote into `#root`, so React's next commit failed with `removeChild: node is not a child of this node`, which then reported *itself*. The handler now paints an overlay and only reports the first error. |
| Seeded dates all landed on "today" | mongoose strips `createdAt` out of `$set` on any update to a timestamped schema — `{ timestamps: false }` does not change it. The seed backdates through the raw driver. |
| `$geoNear` query failed on a fresh database | The seed connects directly and never built indexes. It now calls `syncIndexes()` before writing. |
| Every `.env` setting was silently ignored | The API runs with `apps/api` as its working directory, so `dotenv/config` looked for `apps/api/.env` and found nothing — every value quietly fell back to its default. Invisible until a setting with no sensible default (SMTP credentials) turned up missing. Config is now resolved relative to the module, loading the workspace file then the repo root. |
| A flag set to `false` in `.env` read as enabled | `z.coerce.boolean()` runs `Boolean(value)`, and `Boolean('false')` is `true`. `AI_ENABLED=false` would have been ignored too. Replaced with a parser that understands true/false/1/0/yes/no/on/off. |
| A name typed at sign-up was lost | The magic link has nowhere to carry one, so an account created by clicking the link got a name derived from the address. The requested name is now stored on the challenge and applied by whichever route completes. |

## Configuration

Everything comes from the environment; nothing in the tree hardcodes a URL, key or bucket. That is
what makes phase 14 a deployment rather than a rewrite. See [`.env.example`](.env.example) — the
tunable behaviour is:

| Variable | Default | What it does |
|---|---|---|
| `DEDUP_AUTO_MERGE` | `0.72` | At or above this match score, merge without asking |
| `DEDUP_REVIEW` | `0.50` | Between the two, hold for the moderator console |
| `DEDUP_RADIUS_M` | `120` | Candidate search radius |
| `VERIFY_THRESHOLD` | `3` | Weighted confirmations needed to mark a problem verified |
| `VERIFY_PROXIMITY_M` | `400` | How close a device must be to vote |
| `AI_ENABLED` | `true` | Set `false` to run without the Python service |

Tune the two dedup thresholds against measured moderator capacity, not by feel: too aggressive
floods the review queue, too loose lets bad merges onto the public map.
