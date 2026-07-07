# Design Decisions & Evaluation Write-up

This document provides a summary of the implementation, design decisions, and scaling considerations for the Video Editor Mini App case study.

---

## 1. System Design: How Did I Break Down the Problem?

### The Core Problem

The request is deceptively simple: "paste a YouTube URL, clip it, download it." But the moment you add the constraint of 0.5 vCPU and 1 GB of shared RAM, it becomes a resource orchestration problem. You can't run FFmpeg inside a Node.js web server — it'll block the event loop, memory limits will be uncontrollable, and the UX will feel broken. So the first design decision was: **separate the I/O-bound API from the CPU-bound processing work.**

### How I Broke It Down

| Layer | Responsibility | Technology |
|---|---|---|
| **Frontend** | User interaction, clip selection, progress display | React + Vite (TypeScript) |
| **Backend** | REST API, job orchestration, SSE push | NestJS (TypeScript) |
| **Worker** | Video download (yt-dlp), clip + merge (FFmpeg) | Python + FastAPI |
| **Message Broker** | Decouples API from worker; stores job state | BullMQ on Redis |
| **Object Storage** | Persistent stateless file storage | MinIO (local) / S3 (prod) |

The key insight: **NestJS never touches a video byte.** Its only job is to enqueue work, stream job status back to the browser, and serve pre-signed URLs. All heavy compute is isolated inside the Python worker container.

### Tradeoffs I Made

| Decision | Chosen | Rejected | Reason |
|---|---|---|---|
| Worker language | Python | Node.js FFmpeg wrapper | Python's subprocess + asyncio ecosystem for media tools is superior |
| File storage | S3/MinIO (pre-signed URLs) | Shared Docker volume | Fargate containers have no shared disk; this architecture requires zero changes to move to real S3 |
| Progress delivery | SSE | WebSockets, polling | SSE is unidirectional (perfect for this), lower overhead, and works over plain HTTP/1.1 |
| State store | Redis (BullMQ native) | PostgreSQL | No user accounts, no complex queries — Redis already paid for; Postgres would cost ~100 MB RAM for zero benefit |
| Concurrency model | 1 FFmpeg job at a time | Parallel jobs | OOM risk under the 1 GB total budget; predictability beats throughput at this scale |

---

## 2. Resource Management: Staying Inside 0.5 vCPU / 1 GB RAM

### Memory Budget

| Service | RAM limit | CPU limit | Rationale |
|---|---|---|---|
| worker | 600 MB | 0.35 vCPU | FFmpeg + yt-dlp peak during processing |
| backend | 256 MB | 0.10 vCPU | Node.js event loop — mostly I/O, low RSS |
| redis | 64 MB | 0.02 vCPU | Metadata + job queue, capped with `maxmemory` policy |
| minio | 80 MB | 0.02 vCPU | Lightweight local S3; not present in real AWS deployments |
| **Total** | **~1000 MB** | **~0.49 vCPU** | ✅ Within constraint |

### What Would Break First — And How I Designed Around It

**The bottleneck is the Worker.**

FFmpeg, by default, spawns threads equal to CPU core count. On a 0.35 vCPU Fargate slice that number is unpredictable and will saturate available CPU, causing process throttling and audio/video desync. I applied:

- **`-threads 1`** on every FFmpeg invocation — deterministic single-core encoding.
- **`--format "bestvideo[height<=480]+bestaudio"`** on yt-dlp — caps download size to ~200 MB/video.
- **`--max-filesize 500m`** — hard limit to prevent runaway downloads.
- **`concurrency: 1` in BullMQ** (default via `MAX_CONCURRENT_JOBS` env var) — only one job per processor runs at a time, preventing memory spikes from parallel FFmpeg processes writing to `/tmp`. This can be raised to 2–3 if the worker RAM limit is increased.

**Backpressure mechanism:** Before accepting any new job, the NestJS backend calls `queue.getWaitingCount()`. If the queue depth reaches 10, it returns `HTTP 429 Too Many Requests`. This protects the system from cascading failure: the queue never becomes unbounded, Redis never runs out of memory, and the user gets a clear actionable error instead of a silent timeout.

**File cleanup:** Every `/tmp` file created during download or export is wrapped in a `try/finally` block. Even if FFmpeg crashes mid-encode, the temp files are deleted immediately after the S3 upload completes. This prevents disk exhaustion, which would otherwise bring down the entire container.

---

## 3. Code Quality: Readability, Structure, Maintainability

### Architecture

The NestJS backend uses the official **Module / Controller / Service / DTO** pattern:
- `VideosModule` — handles YouTube URL submission and video metadata.
- `ExportsModule` — handles clip-merge job submission and result retrieval.
- `JobsModule` — provides the SSE stream and a unified history view across both queues.

No cross-module coupling: each module only imports what it explicitly needs. The `RedisService` and `StorageService` are shared infrastructure, injected as NestJS providers — not global singletons.

### Type Safety End-to-End

`JobState` is defined as the shared contract between the backend and frontend, with no loose string literals anywhere in the codebase. The backend uses a TypeScript `enum`; the frontend mirrors it as a `const` object + `type` to satisfy `verbatimModuleSyntax` (which forbids `enum` in `.tsx` files):

```typescript
// backend/src/jobs/jobs.enum.ts
export enum JobState {
  WAITING = 'waiting', ACTIVE = 'active', COMPLETED = 'completed',
  FAILED = 'failed', DELAYED = 'delayed', UNKNOWN = 'unknown'
}

// frontend/src/api/client.ts
export const JobState = { WAITING: 'waiting', ACTIVE: 'active', ... } as const;
export type JobState = typeof JobState[keyof typeof JobState];
```

The values are identical strings — the compiler enforces the contract on both sides.

### Testing

Unit tests cover `VideosService` and `VideosController` — the primary user-facing path — with fully mocked BullMQ queues and Redis providers. Each test verifies both the happy path and error conditions (queue overflow → 429, missing Redis key → 404). `ExportsService` tests are a known gap; the export flow is covered by integration testing manually, and a spec file would be the next addition.

### Error Handling

- NestJS: `@nestjs/common` exception classes (`NotFoundException`, `HttpException`) bubble up through Nest's exception filter layer with consistent JSON error shapes.
- Python Worker: All FFmpeg subprocess calls are wrapped in `try/except`, progress errors are logged, and temp files are cleaned via `finally`.

---

## 4. Product Sense: Does It Actually Work as a User Experience?

Yes. I focused on making the processing complexity invisible to the user.

**Real-time progress, not spinners.** Instead of a loading spinner that gives no information, the frontend subscribes to a Server-Sent Events stream. FFmpeg outputs progress via `pipe:1`, the worker parses it, and each BullMQ `job.updateProgress()` call instantly pushes a percentage to the browser. The user sees the progress bar move from 0% to 100% with no polling.

**Download-first flow with live progress feedback.** After submitting a YouTube URL, the user remains on Step 1 and sees a live progress bar driven by real `yt-dlp` download percentage — not a spinner. The editor only unlocks once the download completes and video metadata (duration, S3 key) is available. This is a deliberate choice: the clip editor requires a known video duration to initialize the range sliders correctly, so there is nothing meaningful to show until the download is done. The tradeoff is a forced wait, which is acceptable because the progress bar makes the wait feel transparent and bounded rather than broken.

**History and recovery.** A dedicated **History tab** lists all past download and export jobs. From there, users can:
- **Review** a completed download — reloads the video back into the editor.
- **Download** a completed export — fetches a fresh pre-signed S3 URL and opens the file.

If a user refreshes the page mid-export, the job continues in the worker. They can find it in History and download the result when it completes — no data is lost.

**Honest error states.** If yt-dlp fails (403 from YouTube bot detection, geo-restriction, file too large), the error message is surfaced directly in the history and the SSE stream. The user knows what happened and why.

---

## 5. Engineering Judgment: What I Chose Not to Build

**No PostgreSQL.** Redis is already required for BullMQ. Every data access pattern in this app is a point lookup (`video:{id}`, `export:{id}`). Adding PostgreSQL would cost ~100 MB RAM — 10% of the total budget — for no functional gain at this scope. I have abstracted the data access layer (`RedisService`) so it could be swapped for a DB-backed service in one file if requirements grow.

**No drag-and-drop timeline editor.** I built a functional range-slider clip selector instead. A canvas-based waveform timeline is a multi-week UI project that would have consumed all implementation time without adding more capability for this use case: selecting start/end times for multiple clips. The sliders deliver the same result.

**No WebSockets.** SSE handles the one use case (server-to-client progress) with less code and less overhead. WebSockets are bidirectional — that complexity is only justified when the client needs to push real-time data back to the server.

**No authentication.** Out of scope for this prototype. The architecture supports adding JWT-based auth in a single NestJS middleware layer if needed — no architectural changes required.

**No CDN / transcoding pipeline.** Pre-signed URL delivery from S3 is sufficient for a single-session download. A CDN (CloudFront) and multi-resolution HLS transcode would make sense for a multi-user streaming product, not a personal download tool.

---

## 6. Open Question — Scaling: 1,000 Simultaneous Users

**What breaks first:** The Python Worker, and more specifically, the queue in Redis.

The worker processes one job at a time. At 1,000 simultaneous submissions, the queue instantly holds 1,000 jobs. With each job averaging 60 seconds of FFmpeg work, the last user in queue waits **16+ hours**. Meanwhile, Redis's `allkeys-lru` eviction policy will start dropping older jobs from the queue to stay under 60 MB, silently losing work.

### Fix It — Ordered by Implementation Cost

**1. Horizontal Worker Scaling (Day 1, zero code changes)**

BullMQ is a multi-consumer queue. Deploy 20 worker containers on ECS. Each independently claims and processes jobs in parallel. Set up an ECS Auto Scaling policy on the `ApproximateNumberOfMessagesVisible` CloudWatch metric (or BullMQ's `getWaitingCount`): scale out when queue > 5, scale in when queue = 0.

**2. Queue Separation (Day 2)**

Download jobs (~10s each) and export/merge jobs (~60s each) should live on separate queues with independent worker pools. Otherwise, 1,000 pending FFmpeg merges starve incoming download requests. Separate queues also allow independent scaling policies: more download workers, fewer merge workers.

**3. URL-Based Caching for Downloads (Week 1)**

Many of the 1,000 users will submit the same YouTube video. Hash the URL and store the resulting S3 key in Redis. On cache hit, skip the yt-dlp download entirely — return the existing S3 key and proceed directly to the editor. This cuts download queue depth dramatically for popular videos.

**4. Redis → ElastiCache (Clustered)**

A single Redis instance is a single point of failure and has a memory ceiling. Replace it with AWS ElastiCache (clustered mode) with replication. BullMQ supports Redis Cluster. This provides HA and eliminates the 60 MB memory cap that would cause silent job loss.

**5. Replace BullMQ → SQS + Lambda (Long-term)**

For true elastic scale without managing worker fleets, replace BullMQ with SQS and trigger ECS Fargate Spot tasks (or Lambda for short jobs) per message. SQS is fully managed, infinitely scalable, and has at-least-once delivery guarantees. The NestJS backend still enqueues messages; the worker logic stays unchanged — only the transport layer changes.

**The honest summary:** The current architecture is correct for the constraint given (0.5 vCPU / 1 GB). It would break at scale in a well-understood and recoverable way. The path from here to 1,000 users is additive infrastructure — not a rewrite.
