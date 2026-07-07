# Video Editor Mini App

A web-based video editing prototype for internal content creators. Paste a YouTube URL, select clip time ranges, apply transitions, and download a merged `.mp4` — no command line required.

---

## Quick Start

```bash
cp .env.example .env
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173)

MinIO console (inspect files): [http://localhost:9001](http://localhost:9001) — login: `minioadmin / minioadmin`

---

## Architecture

```
┌─────────────┐     ┌───────────────┐     ┌──────────────────────┐
│  Frontend   │     │   NestJS API  │     │   Python Worker      │
│ React/Vite  │────▶│    :3000      │────▶│   FastAPI :8000      │
│   :5173     │     │ BullMQ jobs   │     │ FFmpeg + yt-dlp      │
└─────────────┘     └──────┬────────┘     └──────────┬───────────┘
                            │                          │
                  ┌─────────▼──────────┐              │
                  │   Redis :6379      │              │
                  │  job queues        │              │
                  │  + metadata hashes │              │
                  └────────────────────┘              │
                                                       │
                  ┌────────────────────────────────────▼──────┐
                  │   MinIO :9000  (S3-compatible)            │
                  │   source/{videoId}/{videoId}.mp4          │
                  │   exports/{exportId}/output.mp4           │
                  └───────────────────────────────────────────┘
```

---

## Stack & Design Decisions

### Why NestJS + Python Worker (not a monolith)?

FFmpeg is CPU and memory intensive. Running it inside the Node.js process would block the event loop and make memory accounting impossible. A separate Python FastAPI service lets us:
- Set precise Docker memory limits per service
- Scale workers independently
- Use Python's superior FFmpeg/subprocess ecosystem

### Why MinIO (local) → S3 (production)?

Fargate tasks run on isolated ephemeral compute — there is no shared filesystem between tasks. S3-compatible object storage is the correct primitive for stateless Fargate workloads. MinIO implements the full S3 API locally, so **zero code changes** are needed when switching to real S3: just change `STORAGE_ENDPOINT` in the environment.

Files are delivered via **pre-signed URLs** — the browser downloads directly from MinIO/S3, no video bytes ever flow through NestJS.

### Why no database?

Redis (already required for BullMQ) is the only stateful dependency. Here's why that's sufficient:

| Data need | Redis solution |
|---|---|
| Job status & progress | BullMQ native job state machine |
| Video metadata (duration, title) | `HSET video:{id} duration title s3Key` — 2h TTL |
| Export result URL | `HSET export:{id} presignedUrl status` — 2h TTL |

Adding PostgreSQL would cost ~50–100 MB RAM (20% of our 1 GB budget) for no benefit: there are no user accounts, no saved project history, and every access is a point lookup. If this system evolved to need user accounts or job history, PostgreSQL would be the right call — and the repository interfaces are already abstracted for a one-file swap.

---

## Resource Management

Total Fargate budget: **0.5 vCPU / 1 GB RAM**

| Service | RAM limit | CPU limit | Rationale |
|---|---|---|---|
| worker | 600 MB | 0.35 vCPU | FFmpeg is the heaviest process |
| backend | 256 MB | 0.10 vCPU | Node.js event loop, mostly I/O |
| redis | 64 MB | 0.02 vCPU | Metadata + queue only |
| minio | 80 MB | 0.02 vCPU | Lightweight object store |
| **Total** | **~1000 MB** | **~0.49 vCPU** | Within target |

Key constraints applied:
- yt-dlp: `--format "bestvideo[height<=480]+bestaudio"` + `--max-filesize 500m`
- FFmpeg: `-threads 1` on all encode operations
- BullMQ: `concurrency: 1` — one FFmpeg job at a time; HTTP 429 when queue depth ≥ 10
- All `/tmp` files deleted immediately after S3 upload (inside `finally` blocks)

---

## Scaling Answer: 1,000 Concurrent Users

**What breaks first:** The Python Worker. It processes one FFmpeg job at a time (`concurrency: 1`). All 1,000 users queue behind a single process.

**How to fix it, in order of cost:**

1. **Scale workers horizontally** — BullMQ supports multiple consumers on the same Redis queue. Deploy N worker tasks on Fargate; each independently claims and processes jobs. This alone gets you to ~N× throughput with zero code changes.

2. **Separate download and export queues** — Currently one queue handles both yt-dlp (fast, ~10s) and FFmpeg merge (slow, ~30–60s). Separate queues with independent concurrency settings prevent fast download jobs from being starved by slow export jobs.

3. **Replace Redis with SQS** — For true scale, swap BullMQ for AWS SQS. SQS is managed, infinitely scalable, and integrates natively with ECS Auto Scaling via the `ApproximateNumberOfMessagesVisible` metric. Worker tasks scale in/out automatically based on queue depth.

4. **Restrict source video size more aggressively** — At scale, downloads become the bottleneck. Enforce a 5-min / 360p cap and cache previously-downloaded videos by URL hash to avoid re-downloading the same video.

5. **Pre-signed upload URLs for source video** — Skip the yt-dlp download entirely: let the client send the YouTube URL, have the worker download directly to S3 using streaming upload. This removes the double-write of download → /tmp → S3.
