# Plan: Video Editor Mini App

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                         Docker Compose (local)                        │
│                                                                       │
│  ┌─────────────┐     ┌───────────────┐     ┌──────────────────────┐  │
│  │  Frontend   │     │   NestJS API  │     │   Python Worker      │  │
│  │ React/Vite  │────▶│   (NestJS 10) │────▶│   FastAPI :8000      │  │
│  │   :5173     │     │    :3000      │     │ FFmpeg + yt-dlp      │  │
│  └─────────────┘     └──────┬────────┘     └──────────┬───────────┘  │
│                              │                          │              │
│                    ┌─────────▼──────────┐              │              │
│                    │      Redis          │              │              │
│                    │   BullMQ + State    │              │              │
│                    │      :6379          │              │              │
│                    └─────────────────────┘              │              │
│                                                         │              │
│                    ┌────────────────────────────────────▼────────┐    │
│                    │        MinIO  (S3-compatible)  :9000        │    │
│                    │   Bucket: video-editor-storage              │    │
│                    │   source/{videoId}.mp4                      │    │
│                    │   exports/{exportId}.mp4                    │    │
│                    └─────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────┘
```

**In production (AWS):** Replace MinIO with AWS S3 — zero code change, only env vars differ.

---

## Storage Strategy: MinIO (Local) → S3 (Production)

### Why Object Storage Instead of Shared Docker Volume

| Criterion | Docker Volume | Object Storage (MinIO/S3) |
|---|---|---|
| Multi-instance scaling | ❌ Only one node can write | ✅ All instances share same store |
| Fargate compatibility | ❌ Fargate tasks share no local disk | ✅ Native fit for stateless tasks |
| File TTL / lifecycle | ❌ Manual cron only | ✅ S3 Lifecycle Rules built-in |
| Pre-signed URLs | ❌ Must proxy through app | ✅ Direct browser download, 0 server load |
| Local dev parity | — | ✅ MinIO is 100% S3 API compatible |
| Resume-ability | ❌ Lost on crash | ✅ Persists independently of containers |

### Object Layout in the Bucket

```
video-editor-storage/
├── source/
│   └── {videoId}/{videoId}.mp4          ← downloaded from YouTube
├── clips/
│   └── {exportId}/clip_{n}.mp4          ← intermediate clip segments
└── exports/
    └── {exportId}/output.mp4            ← final merged result
```

### File Lifecycle

```
[Download] → source/{videoId}.mp4  ─────────────────────┐
                                                          │  TTL: 2 hours
[Clip]     → clips/{exportId}/clip_*.mp4  ───────────────┤  (MinIO expiry policy
                                                          │   or S3 Lifecycle Rule)
[Merge]    → exports/{exportId}/output.mp4  ─────────────┘
                                       ↓
                              Pre-signed GET URL (15 min TTL)
                                       ↓
                              User downloads directly from MinIO/S3
                              (no backend bandwidth used)
```

### SDK: `boto3` (Python) + `@aws-sdk/client-s3` (NestJS)

Both services use the same AWS SDK pointed at `STORAGE_ENDPOINT` env var:
- **Local:** `http://minio:9000`
- **Staging/Prod:** `https://s3.amazonaws.com`

---

## Why No Database — Explicit Decision Record

> **Decision:** Use Redis (BullMQ's built-in store) as the only stateful data layer. No PostgreSQL, MongoDB, or SQLite.

### Reasoning

1. **What data would a DB store?** Job status, video metadata (duration, title), clip selections. Every one of these is either:
   - Already stored in BullMQ's Redis job record (status, progress, return value), or
   - Reconstructable from S3 object metadata (file size, custom headers like `x-amz-meta-title`)

2. **Job lifecycle is short.** A video is downloaded, clipped, merged, downloaded by the user, then deleted. There is no need to query historical jobs, run analytics, or join data. A DB adds operational cost with zero benefit here.

3. **Redis IS a database** — it's a persistent key-value store. BullMQ stores each job as a Redis hash containing: `{ id, name, data, opts, progress, returnvalue, failedReason, timestamp, processedOn, finishedOn }`. This is sufficient for status polling.

4. **Prototype constraint:** Adding PostgreSQL would require schema migrations, a connection pool, an ORM, and either Docker Compose config or a managed RDS instance. All of that complexity is eliminated.

5. **What we *do* store in Redis:**
   ```
   Key: bull:download-queue:{jobId}          ← BullMQ auto-managed
   Key: video:{videoId}                      ← Hash { s3Key, duration, title, thumbnail }
   Key: export:{exportId}                    ← Hash { status, presignedUrl, createdAt }
   TTL on all custom keys: 2 hours
   ```

6. **If persistence across restarts were required:** We would add DynamoDB (for Fargate/AWS) or PostgreSQL. The service interfaces are already abstracted behind repository classes — swapping the backing store is a one-file change. But for this prototype, it is not required.

### What Redis Replaces

| Need | Redis Solution |
|---|---|
| Job status tracking | BullMQ native job state machine |
| Video metadata (after download) | `HSET video:{id} duration title s3Key` |
| Export output reference | `HSET export:{id} s3Url presignedUrl` |
| Rate limiting | `INCR` + `EXPIRE` on IP key |
| Queue depth check | `LLEN bull:download-queue:wait` |

---

## Request Flow (Updated)

```
1.  User pastes URL
        → POST /videos { url }
        → NestJS validates URL regex + YouTube domain
        → Enqueues BullMQ job { videoId, url }
        → Returns { videoId, jobId, status: "queued" }

2.  BullMQ download processor runs:
        → Calls Python Worker POST /download { url, videoId }
        → Worker: yt-dlp → tmp → boto3.upload_file → S3 source/{videoId}.mp4
        → Worker: extracts duration/title via ffprobe
        → Worker returns { s3Key, duration, title, thumbnailUrl }
        → NestJS stores in Redis: HSET video:{videoId} ...
        → BullMQ job marked complete

3.  Frontend polls GET /jobs/{jobId} every 2s
        → Returns { status, progress }
        → On complete: GET /videos/{videoId} → returns metadata

4.  User scrubs timeline, selects clips
        → State managed in React (no server call needed)

5.  User clicks Export
        → POST /exports { videoId, clips: [{start, end}], transition }
        → NestJS enqueues export job, returns { exportId, jobId }

6.  BullMQ export processor runs:
        → Calls Python Worker POST /process { videoId, clips, transition, exportId }
        → Worker: download source from S3 to ephemeral /tmp
        → Worker: FFmpeg extract each clip → /tmp/clip_n.mp4
        → Worker: FFmpeg concat + xfade → /tmp/output.mp4
        → Worker: boto3.upload_file → S3 exports/{exportId}/output.mp4
        → Worker: delete all /tmp files
        → Worker returns { s3Key }
        → NestJS generates pre-signed URL (15 min expiry)
        → NestJS stores in Redis: HSET export:{exportId} presignedUrl ...
        → BullMQ job marked complete

7.  Frontend polls GET /jobs/{jobId}
        → On complete: GET /exports/{exportId}
        → Returns { presignedUrl }
        → Browser redirects to presignedUrl → direct S3/MinIO download
        → No backend bandwidth consumed
```

---

## Implementation Order

```
Phase 0: Infrastructure
  Docker Compose: frontend, backend, worker, redis, minio
  MinIO bucket creation + lifecycle policy
        ↓
Phase 1: Python Worker
  FastAPI + boto3 S3 client
  yt-dlp download → S3 upload
  FFmpeg clip → FFmpeg merge
  /tmp ephemeral scratch, never kept
        ↓
Phase 2: NestJS API
  BullMQ + Redis
  VideosModule, JobsModule, ExportsModule
  Pre-signed URL generation (AWS SDK)
        ↓
Phase 3: React Frontend
  URL input → polling → timeline → export → download
        ↓
Phase 4: Integration + Polish
  End-to-end test under memory/CPU constraints
  README complete
```

---

## Phase 0 — Infrastructure

**Goal:** Running Docker Compose with MinIO configured and bucket created.

**Files:**
- `docker-compose.yml` — 6 services: `frontend`, `backend`, `worker`, `redis`, `minio`, `minio-init`
- `.env.example` — all env vars documented
- `README.md` — placeholder

**MinIO setup:**
```yaml
minio:
  image: minio/minio
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: minioadmin
    MINIO_ROOT_PASSWORD: minioadmin
  ports: ["9000:9000", "9001:9001"]

minio-init:
  image: minio/mc
  depends_on: [minio]
  entrypoint: >
    /bin/sh -c "
    mc alias set local http://minio:9000 minioadmin minioadmin &&
    mc mb local/video-editor-storage --ignore-existing &&
    mc ilm add --expiry-days 1 local/video-editor-storage
    "
```

**Environment variables:**
```env
# Storage
STORAGE_ENDPOINT=http://minio:9000
STORAGE_BUCKET=video-editor-storage
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
AWS_REGION=us-east-1
PRESIGNED_URL_EXPIRY_SECONDS=900

# Worker
WORKER_URL=http://worker:8000

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Limits
MAX_VIDEO_DURATION_SECONDS=900
MAX_CONCURRENT_JOBS=1
QUEUE_MAX_DEPTH=10
```

---

## Phase 1 — Python Worker

**Goal:** FastAPI service that downloads, clips, merges, and stores in S3/MinIO.

**Endpoints:**
```
GET  /health
POST /download   { url, video_id }          → { s3_key, duration, title, thumbnail_url }
POST /process    { video_id, clips, transition, export_id }  → { s3_key }
```

**Key implementation details:**

```python
# downloader.py — yt-dlp → /tmp → S3
async def download_video(url: str, video_id: str) -> DownloadResult:
    tmp_path = f"/tmp/{video_id}.mp4"
    cmd = [
        "yt-dlp",
        "--format", "bestvideo[height<=480]+bestaudio/best[height<=480]",
        "--merge-output-format", "mp4",
        "--max-filesize", "500m",
        "-o", tmp_path,
        url
    ]
    proc = await asyncio.create_subprocess_exec(*cmd)  # Never shell=True
    await proc.wait()
    metadata = await probe_metadata(tmp_path)          # ffprobe
    s3_key = f"source/{video_id}/{video_id}.mp4"
    await s3_client.upload_file(tmp_path, BUCKET, s3_key)
    os.unlink(tmp_path)                                # Clean up /tmp
    return DownloadResult(s3_key=s3_key, **metadata)

# merger.py — clip + concat with xfade in /tmp
# All intermediate files written to /tmp/{export_id}/
# Entire /tmp/{export_id}/ directory deleted on completion or error
```

**Transitions:**
- `cut` → FFmpeg concat demuxer (lossless, fast)
- `fade` → FFmpeg `xfade=fade:duration=0.5` filter (requires re-encode)
- `slide` → ⚠️ Stubbed; returns 422 with `{"detail": "slide transition not yet supported"}`

**Resource constraints:**
- `-threads 1` on all FFmpeg encode operations
- `--max-filesize 500m` on yt-dlp
- Raise `HTTP 503` if total `/tmp` usage exceeds 800MB (headroom for OS)

---

## Phase 2 — NestJS API

**Goal:** Orchestration layer — enqueues jobs, tracks state in Redis, generates pre-signed URLs.

**Endpoints:**
```
POST   /videos                    → { videoId, jobId }
GET    /videos/:videoId           → { duration, title, thumbnailUrl, s3Key }
GET    /jobs/:jobId               → { status, progress, error? }
POST   /exports                   → { exportId, jobId }
GET    /exports/:exportId         → { presignedUrl } (only when done)
```

**Module breakdown:**

```
VideosModule
  ├── VideosController  — validates DTO, calls VideosService
  ├── VideosService     — enqueues download job; reads video Redis hash on GET
  └── DownloadProcessor — @Process('download'): calls worker /download, writes to Redis

JobsModule
  ├── JobsController  — reads BullMQ job state, maps to API response
  └── JobsService     — thin wrapper: getJob(id), enqueueJob(name, data)

ExportsModule
  ├── ExportsController  — validates DTO, calls ExportsService
  ├── ExportsService     — enqueues export job; generates pre-signed URL; reads Redis on GET
  └── ExportProcessor    — @Process('export'): calls worker /process, stores presigned URL
```

**Redis schema (no DB):**
```typescript
// Written by DownloadProcessor after worker responds
await redis.hset(`video:${videoId}`, {
  s3Key: result.s3Key,
  duration: result.duration,
  title: result.title,
  thumbnailUrl: result.thumbnailUrl,
});
await redis.expire(`video:${videoId}`, 7200); // 2 hour TTL

// Written by ExportProcessor after worker responds
const presignedUrl = await s3.getSignedUrlPromise('getObject', {
  Bucket: BUCKET,
  Key: result.s3Key,
  Expires: 900, // 15 min
});
await redis.hset(`export:${exportId}`, { presignedUrl, status: 'done' });
await redis.expire(`export:${exportId}`, 7200);
```

**Input validation (class-validator):**
```typescript
export class CreateVideoDto {
  @IsUrl({ require_protocol: true })
  @Matches(/^https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/)
  url: string;
}

export class CreateExportDto {
  @IsUUID() videoId: string;
  @IsArray() @ArrayMinSize(1) clips: ClipDto[];
  @IsEnum(Transition) transition: Transition;
}
```

**Queue safety:**
```typescript
// Return 429 if queue is too deep
const waitingCount = await downloadQueue.getWaitingCount();
if (waitingCount >= MAX_QUEUE_DEPTH) {
  throw new HttpException('Server busy, try again later', 429);
}
```

---

## Phase 3 — React Frontend

**Goal:** Polished dark-theme SPA — URL → preview → clip timeline → export → direct S3 download.

**Component tree:**
```
App
├── StepIndicator          (Step 1 / 2 / 3)
├── Step 1: UrlInput
│     └── ValidationFeedback
├── Step 2: VideoEditor    (shown after download completes)
│     ├── VideoPlayer      (HTML5 <video> with backend /stream/:videoId proxy)
│     ├── Timeline         (dual-handle range slider, one per clip)
│     ├── ClipList         (selected ranges, deletable)
│     └── TransitionPicker (fade | cut | slide[disabled])
└── Step 3: ExportPanel
      ├── JobProgressBar   (polls /jobs/:jobId)
      └── DownloadButton   (opens presignedUrl when done)
```

**Hooks:**
```typescript
// useJob.ts — polls until terminal state
function useJob(jobId: string | null) {
  const [job, setJob] = useState<JobStatus | null>(null);
  useEffect(() => {
    if (!jobId) return;
    const id = setInterval(async () => {
      const data = await api.getJob(jobId);
      setJob(data);
      if (['completed', 'failed'].includes(data.status)) clearInterval(id);
    }, 2000);
    return () => clearInterval(id);
  }, [jobId]);
  return job;
}
```

**Video streaming:** Backend exposes `GET /videos/:id/stream` which generates a short-lived pre-signed URL and redirects (302) — so the `<video>` src attribute hits S3/MinIO directly. No video bytes flow through NestJS.

---

## Phase 4 — Integration & Polish

**Goal:** End-to-end verified, README complete, resource limits enforced.

**docker-compose.yml resource limits:**
```yaml
services:
  backend:
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.1"
  worker:
    deploy:
      resources:
        limits:
          memory: 600M
          cpus: "0.35"
  redis:
    deploy:
      resources:
        limits:
          memory: 64M
          cpus: "0.02"
  minio:
    deploy:
      resources:
        limits:
          memory: 80M
          cpus: "0.02"
# Total: ~1000MB, 0.5 vCPU — matches Fargate target
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| yt-dlp fails on URL (age-restricted, private) | Medium | High | Validate URL format + domain before enqueue; return structured 422 error |
| OOM during FFmpeg merge | Medium | High | `-threads 1`; 480p cap; monitor `/tmp` before starting; 600MB worker limit |
| MinIO disk full (local dev) | Low | High | `mc ilm` 1-day expiry; delete `/tmp` files after S3 upload |
| Python worker timeout on large video | Medium | Medium | NestJS HTTP timeout 5 min; BullMQ job timeout 6 min; frontend spinner |
| Pre-signed URL expires before user clicks download | Low | Low | 15-min TTL is generous; can regenerate on GET /exports/:id |
| Concurrent requests (1000 users, scaling Q) | High | High | BullMQ concurrency=1; 429 beyond depth-10; scale by adding worker replicas + Redis as shared queue |
| S3 credential leak | Low | Critical | Secrets in `.env` (gitignored); pre-signed URLs are scoped and time-limited |

---

## Scaling Answer (1,000 Concurrent Users)

> **What breaks first:** The Python Worker. It has `concurrency=1` — all users queue behind one FFmpeg process.

**Fix in order of cost:**
1. **Scale workers horizontally** — BullMQ supports multiple consumers on the same Redis queue. Spin up N worker replicas on Fargate; each independently claims and processes a job.
2. **Decouple download from merge** — Put download jobs and export jobs on separate queues with independent concurrency settings.
3. **Move to async S3 upload/download** — Pre-signed URLs offload bandwidth from app servers.
4. **Add SQS** — Replace BullMQ with AWS SQS for managed, infinitely scalable queue (no Redis to manage).
5. **ECS Auto Scaling** — Scale worker task count based on SQS `ApproximateNumberOfMessagesVisible` metric.

---

## Verification Plan

| Phase | Command | Expected |
|---|---|---|
| 0 | `docker compose up` | All 6 services healthy; MinIO bucket created |
| 1 | `pytest worker/tests/ -v` | All pass; S3 upload/download mocked |
| 2 | `cd backend && npm test` | Unit + e2e pass; pre-signed URL generation tested |
| 3 | `cd frontend && npm test` | Components render; polling hook tested with mock |
| 4 | Manual E2E + `docker stats` | Full flow completes; no OOM kill under 1g/0.5cpu |
