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

### The Full Data Flow

Understanding exactly how progress travels from FFmpeg to the browser is critical for debugging:

```
[User] POST /videos
  → NestJS validates URL (server-side @IsUrl + @Matches regex on DTO)
  → downloadQueue.add('download', { videoId, url }, { jobId: videoId })
  → Redis stores job

[Python worker] picks up job via HTTP stream POST /download
  → yt-dlp stdout: "[download]  45.0% of ..."
  → NestJS DownloadProcessor parses stream, calls job.updateProgress(45)
  → Redis stores updated progress on job key

[Browser] GET /jobs/:id/progress (SSE endpoint)
  → NestJS polls Redis via interval(500ms) + RxJS pipe
  → distinctUntilChanged filters redundant events
  → takeWhile closes stream on COMPLETED/FAILED
  → EventSource fires onmessage → React updates progress bar

[Worker completes] → S3 upload → Redis HSET video:{id} metadata
  → Final job.updateProgress(100)
  → SSE emits COMPLETED → browser navigates to editor
```

The SSE stream is **poll-based** (every 500ms), not event-driven. This is a deliberate simplicity tradeoff: Redis pub/sub would be more efficient at scale but adds complexity that isn't warranted at this scope.

### Tradeoffs I Made

| Decision | Chosen | Rejected | Reason |
|---|---|---|---|
| Worker language | Python | Node.js FFmpeg wrapper | Python's subprocess + asyncio ecosystem for media tools is superior |
| File storage | S3/MinIO (pre-signed URLs) | Shared Docker volume | Fargate containers have no shared disk; zero code changes to move to real S3 |
| Progress delivery | SSE (poll-based) | WebSockets, long-poll | SSE is unidirectional, stateless, works over HTTP/1.1; 500ms polling is imperceptible to users |
| State store | Redis (BullMQ native) | PostgreSQL | No user accounts, no complex queries — Redis already paid for; Postgres would cost ~100 MB RAM for zero benefit |
| Concurrency model | 1 FFmpeg job at a time | Parallel jobs | OOM risk under the 1 GB total budget; predictability beats throughput at this scale |

### Local → Production Delta

The entire infrastructure swap is **environment variables only**. No code changes:

| Variable | Local | Production |
|---|---|---|
| `STORAGE_ENDPOINT` | `http://minio:9000` | `https://s3.amazonaws.com` |
| `STORAGE_ACCESS_KEY` | `minioadmin` | AWS IAM role (via ECS task role, no key needed) |
| `REDIS_HOST` | `redis` | ElastiCache endpoint |
| `WORKER_URL` | `http://worker:8000` | Internal ALB or ECS service discovery |

MinIO implements the full S3 API. No MinIO SDK or MinIO-specific call exists anywhere in the codebase — only the AWS SDK `@aws-sdk/client-s3`.

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

**BullMQ job stall detection:** If the worker container crashes mid-job (e.g., OOM kill), BullMQ's lock mechanism detects the stall after a configurable timeout and moves the job back to the waiting queue automatically. The job is not lost — the next healthy worker picks it up. This requires no custom code; it's built into BullMQ's lock/heartbeat protocol.

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

### Input Validation

The NestJS DTO layer validates every incoming request before it reaches the service layer:

```typescript
// backend/src/videos/dto/create-video.dto.ts
export class CreateVideoDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  @Matches(
    /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts\/)|youtu\.be\/)/,
    { message: 'url must be a valid YouTube URL' },
  )
  url: string;
}
```

Three guards in sequence: `class-validator` URL parse, YouTube-specific regex, and then yt-dlp's own internal validation. This also mitigates SSRF — the backend will never forward an arbitrary URL to the worker.

### Testing

Unit tests cover `VideosService` and `VideosController` — the primary user-facing path — with fully mocked BullMQ queues and Redis providers. Each test verifies both the happy path and error conditions (queue overflow → 429, missing Redis key → 404). `ExportsService` tests are a known gap; the export flow is covered by integration testing manually, and a spec file would be the next addition.

### Error Handling

- NestJS: `@nestjs/common` exception classes (`NotFoundException`, `HttpException`) bubble up through Nest's exception filter layer with consistent JSON error shapes.
- Python Worker: All FFmpeg subprocess calls are wrapped in `try/except`, progress errors are logged, and temp files are cleaned via `finally`.

---

## 4. Product Sense: Does It Actually Work as a User Experience?

Yes. I focused on making the processing complexity invisible to the user.

**Real-time progress, not spinners.** Instead of a loading spinner that gives no information, the frontend subscribes to a Server-Sent Events stream. FFmpeg outputs progress via `pipe:1`, the worker parses it, and each BullMQ `job.updateProgress()` call instantly pushes a percentage to the browser. The user sees the progress bar move from 0% to 100% with no polling on their side.

**Download-first flow with live progress feedback.** After submitting a YouTube URL, the user remains on Step 1 and sees a live progress bar driven by real `yt-dlp` download percentage — not a spinner. The editor only unlocks once the download completes and video metadata (duration, S3 key) is available. This is a deliberate choice: the clip editor requires a known video duration to initialize the range sliders correctly, so there is nothing meaningful to show until the download is done. The tradeoff is a forced wait, which is acceptable because the progress bar makes the wait feel transparent and bounded rather than broken.

**History and recovery.** A dedicated **History tab** lists all past download and export jobs. From there, users can:
- **Review** a completed download — reloads the video back into the editor.
- **Download** a completed export — fetches a fresh pre-signed S3 URL and opens the file.

If a user refreshes the page mid-export, the job continues in the worker. They can find it in History and download the result when it completes — no data is lost.

**Honest error states.** If yt-dlp fails (403 from YouTube bot detection, geo-restriction, file too large), the error message is surfaced directly in the history and the SSE stream. The user knows what happened and why.

---

## 5. Engineering Judgment: What I Chose Not to Build — And Why That Was Right

**No PostgreSQL — not yet.**
Every data access in the app is a point lookup by a UUID key: `video:{id}`, `export:{id}`. Redis already paid for by BullMQ handles this at O(1) with no joins, no schema migrations, and no extra RAM cost. The signal that would change this decision: user accounts, saved projects, or any query that needs filtering, pagination, or relationships. The `RedisService` is already abstracted behind an interface — swapping it for a TypeORM repository is a one-file change.

**No drag-and-drop timeline — deliberate scope cut.**
A canvas-based waveform editor is a 2–3 week project on its own. The evaluation criteria is clipping and merging — not building a pro editor. Range sliders deliver the same functional result. I'd revisit this if there were a second sprint and user research showed the slider UX was a pain point.

**No WebSockets — SSE is the right primitive here.**
Progress streaming is strictly server-to-client. SSE is simpler, stateless, works over HTTP/1.1 (no upgrade handshake), and is natively supported in every modern browser and NestJS. WebSockets add bidirectional complexity that this use case never needs. If the product evolved to need collaborative editing (multiple users on one session), WebSockets would be revisited.

**No authentication — explicit, not lazy.**
This is a single-user tool prototype targeting internal creators. Adding JWT auth would require user management, token refresh, and session state — none of which are in scope. The NestJS Guards and `app.use()` middleware are the integration points; auth can be bolted on without touching any feature module.

**No CDN — premature for a download tool.**
Pre-signed S3 URLs are delivered directly from MinIO/S3 to the browser. A CDN would add meaningful value only if the same export was served to many users repeatedly — which is not the use case here. CloudFront would be the right call if this evolved into a shared asset library.

---

## 6. Observability: How Would I Know If It's Broken?

This is the section that separates a system that works in demos from one that works in production.

**Logging is structured, not ad-hoc.**
NestJS's built-in `Logger` service is used in every processor: `this.logger.log(...)` and `this.logger.error(...)` emit structured lines with class context (`[DownloadProcessor]`). In production these pipe to stdout → CloudWatch Logs. A CloudWatch Insights query on `level = "error"` surfaces all failures without grep.

**The failure mode I'm most concerned about: silent yt-dlp exit.**
yt-dlp can exit with code 0 but produce a corrupt or truncated file if a network drop occurs mid-download. The current mitigation is running `ffprobe` immediately after download to validate duration and format — if ffprobe fails or returns duration 0, the job fails loudly with an error rather than silently uploading a broken file to S3.

**Health check surface.**
The Python worker exposes `GET /health` → `{"status": "ok"}`. Docker Compose and ECS both health-check this endpoint and restart the container if it goes unhealthy. Redis is checked via `redis-cli ping`. The NestJS backend relies on the process staying up — a `GET /health` endpoint returning `{"status": "ok", "uptime": process.uptime()}` would be a 30-minute addition.

**BullMQ stall detection** is already active. If a worker container is OOM-killed mid-job, BullMQ detects the expired lock after `stalledInterval` ms and requeues the job. No silent data loss.

**What I would add before production:**
- A dead-letter queue: jobs that fail 3 times move to a `failed` queue instead of being dropped, with a separate alert
- CloudWatch metric filter on `"failed"` log lines → alarm → SNS → on-call page
- Redis memory utilization emitted as a custom CloudWatch metric every 60s (currently the 60 MB `maxmemory` cap is the only guard, and it silently evicts)

---

## 7. Open Question — Scaling: 1,000 Simultaneous Users

**What breaks first:** The Python Worker, and more specifically, the queue in Redis.

The worker processes one job at a time. At 1,000 simultaneous submissions, the queue instantly holds 1,000 jobs. With each job averaging 60 seconds of FFmpeg work, the last user in queue waits **16+ hours**. Meanwhile, Redis's `allkeys-lru` eviction policy will start dropping older jobs from the queue to stay under 60 MB, silently losing work.

### Fix It — Ordered by Implementation Cost

**1. Horizontal Worker Scaling (Day 1, zero code changes)**

BullMQ is a multi-consumer queue. Deploy N worker containers on ECS. Each independently claims and processes jobs in parallel.

**The math:** To achieve P95 wait time < 5 minutes with 1,000 simultaneous jobs at 60s each, you need:

```
workers_needed = total_job_seconds / target_p95_seconds
               = (1000 × 60) / 300
               = 200 workers
```

200 workers × 600 MB RAM = **120 GB** of compute. At `m5.large` ($0.096/hr each with 8 GB RAM, ~13 workers/instance): ~16 instances × $0.096 = **$1.54/hr**. Using Fargate Spot (70% cheaper): **~$0.46/hr**.

Set up ECS target tracking on BullMQ's `getWaitingCount` exposed as a custom CloudWatch metric: scale out at queue > 10, scale in after 5 min idle.

**2. Queue Separation (Day 2)**

Download jobs (~10s each) and export/merge jobs (~60s each) should live on separate queues with independent worker pools. Otherwise, 1,000 pending FFmpeg merges starve incoming download requests. Separate queues allow independent scaling: more download workers (cheap, network-bound), fewer merge workers (expensive, CPU-bound).

**3. URL-Based Caching for Downloads (Week 1)**

Many of the 1,000 users will submit the same YouTube video. Hash the URL (SHA-256) and store the resulting S3 key in Redis. On cache hit, skip the yt-dlp download entirely — return the existing S3 key and proceed directly to the editor. For a viral video, this could reduce download queue depth by 90%+.

**4. Redis → ElastiCache (Clustered)**

A single Redis instance is a single point of failure and has a 60 MB memory ceiling that causes silent job eviction. Replace it with AWS ElastiCache (clustered mode) with replication. BullMQ supports Redis Cluster natively. This provides HA and eliminates the memory cap.

**5. Replace BullMQ → SQS + ECS Auto Scaling (Long-term)**

For true elastic scale without managing worker fleets, replace BullMQ with SQS. SQS is fully managed, infinitely scalable, and integrates directly with ECS target tracking via `ApproximateNumberOfMessagesVisible`. Worker containers scale in/out automatically. The NestJS backend still enqueues messages via the AWS SDK; the worker logic stays unchanged — only the transport layer changes.

**The honest summary:** The current architecture is correct for the constraint given (0.5 vCPU / 1 GB). It would break at scale in a well-understood and recoverable way — not a mysterious crash. The path from here to 1,000 users is additive infrastructure, not a rewrite. The most valuable engineering investment at that scale is step 3 (URL caching), because it reduces compute cost proportionally to video popularity.
