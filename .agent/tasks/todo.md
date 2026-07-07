# TODO: Video Editor Mini App

## Phase 0 — Infrastructure

- [ ] Task: Create Docker Compose skeleton with all 6 services
  - Acceptance: `docker compose up` starts `frontend`, `backend`, `worker`, `redis`, `minio`, `minio-init` without errors; all show healthy
  - Verify: `docker compose ps` — all 6 services running
  - Files: `docker-compose.yml`, `.env.example`

- [ ] Task: Configure MinIO bucket + lifecycle policy
  - Acceptance: `minio-init` service creates bucket `video-editor-storage` with 2h expiry on all objects; bucket layout `source/` and `exports/` confirmed via MinIO console at `:9001`
  - Verify: Open `http://localhost:9001` → bucket exists with lifecycle rule
  - Files: `docker-compose.yml` (minio-init entrypoint), `.env.example`

- [ ] Task: Create project directory structure
  - Acceptance: All top-level dirs exist (`frontend/`, `backend/`, `worker/`, `tasks/`)
  - Verify: `ls` shows expected layout
  - Files: directory scaffolding only

- [ ] Task: Create placeholder README
  - Acceptance: README exists with section headings: Architecture, Stack Decisions, Storage Design, No-DB Rationale, Resource Management, Scaling Answer
  - Verify: File readable; headings all present
  - Files: `README.md`

---

## Phase 1 — Python Worker

- [ ] Task: Bootstrap FastAPI project + Dockerfile
  - Acceptance: `docker compose up worker` starts FastAPI on `:8000`; `GET /health` returns `{"status":"ok"}`
  - Verify: `curl http://localhost:8000/health`
  - Files: `worker/main.py`, `worker/requirements.txt`, `worker/Dockerfile`

- [ ] Task: Implement `s3_client.py` (boto3 wrapper)
  - Acceptance: `upload_file(local_path, s3_key)`, `download_file(s3_key, local_path)`, `generate_presigned_url(s3_key, expiry)` all work against MinIO; S3 operations mocked in tests via `moto`
  - Verify: `pytest worker/tests/test_s3_client.py`
  - Files: `worker/services/s3_client.py`, `worker/tests/test_s3_client.py`

- [ ] Task: Implement `downloader.py` with yt-dlp → S3
  - Acceptance: `POST /download {"url":"...", "video_id":"..."}` downloads video to `/tmp/{video_id}.mp4` (480p cap), uploads to `source/{video_id}/{video_id}.mp4` in MinIO, deletes `/tmp` file, returns `{s3_key, duration, title, thumbnail_url}`
  - Verify: `pytest worker/tests/test_downloader.py` (yt-dlp and S3 mocked)
  - Files: `worker/services/downloader.py`, `worker/tests/test_downloader.py`

- [ ] Task: Implement `clipper.py` with FFmpeg
  - Acceptance: Extracts a time range from a local file using `ffmpeg -ss {start} -to {end} -threads 1`; output is a valid `.mp4`; always runs inside a `try/finally` that cleans `/tmp`
  - Verify: `pytest worker/tests/test_clipper.py` (uses a small synthetic test video)
  - Files: `worker/services/clipper.py`, `worker/tests/test_clipper.py`

- [ ] Task: Implement `merger.py` with FFmpeg concat + transitions
  - Acceptance: `fade` transition uses `xfade=fade:duration=0.5`; `cut` uses FFmpeg concat demuxer (no re-encode); `slide` returns `{"detail": "slide transition not yet supported"}` with HTTP 422; output uploaded to `exports/{export_id}/output.mp4`
  - Verify: `pytest worker/tests/test_merger.py`
  - Files: `worker/services/merger.py`, `worker/tests/test_merger.py`

- [ ] Task: Wire all routes in `main.py`
  - Acceptance: `GET /health`, `POST /download`, `POST /process` all respond correctly; each endpoint has Pydantic request/response models; subprocess calls never use `shell=True`
  - Verify: `curl` smoke test against running container
  - Files: `worker/main.py`

---

## Phase 2 — NestJS API

- [ ] Task: Bootstrap NestJS project + Dockerfile
  - Acceptance: `docker compose up backend` starts on `:3000`; `GET /` returns 200
  - Verify: `curl http://localhost:3000/`
  - Files: `backend/` (NestJS scaffold), `backend/Dockerfile`

- [ ] Task: Implement `StorageService` (AWS SDK S3 pre-signed URLs)
  - Acceptance: `generatePresignedUrl(key, expiry)` returns a valid URL pointing to MinIO; `STORAGE_ENDPOINT` env var switches between MinIO and real S3; unit tested with SDK mock
  - Verify: `npm test` — StorageService spec passes
  - Files: `backend/src/common/storage.service.ts`, `backend/src/common/storage.service.spec.ts`

- [ ] Task: Implement `RedisService` (metadata store — no DB)
  - Acceptance: `hset(key, data)`, `hgetall(key)`, `expire(key, ttl)` work against Redis; all keys get 2h TTL; unit tested with `ioredis-mock`
  - Verify: `npm test` — RedisService spec passes
  - Files: `backend/src/common/redis.service.ts`, `backend/src/common/redis.service.spec.ts`

- [ ] Task: Add BullMQ + Redis connection + JobsModule
  - Acceptance: BullMQ connects to Redis service on startup; `JobsService.enqueue(name, data)` and `JobsService.getJob(id)` work; `GET /jobs/:id` returns `{status, progress, error?}`
  - Verify: `npm test` — JobsModule unit + e2e pass
  - Files: `backend/src/jobs/jobs.module.ts`, `backend/src/jobs/jobs.service.ts`, `backend/src/jobs/jobs.controller.ts`

- [ ] Task: Implement `VideosModule` + download processor
  - Acceptance:
    - `POST /videos { url }` validates YouTube URL (regex), enqueues BullMQ download job, returns `{ videoId, jobId }`
    - `DownloadProcessor` calls worker `POST /download`, stores `HSET video:{videoId} ...` in Redis with 2h TTL
    - `GET /videos/:id` reads from Redis, returns `{ duration, title, thumbnailUrl }`
    - `GET /videos/:id/stream` generates pre-signed URL and redirects (302) to MinIO
  - Verify: `npm test` + Supertest e2e for all 3 endpoints
  - Files: `backend/src/videos/videos.controller.ts`, `backend/src/videos/videos.service.ts`, `backend/src/jobs/processors/download.processor.ts`

- [ ] Task: Implement `ExportsModule` + export processor
  - Acceptance:
    - `POST /exports { videoId, clips[], transition }` validates DTO, enqueues BullMQ export job, returns `{ exportId, jobId }`
    - `ExportProcessor` calls worker `POST /process`, generates pre-signed URL (15 min), stores `HSET export:{exportId} presignedUrl status` in Redis with 2h TTL
    - `GET /exports/:id` reads Redis, returns `{ presignedUrl }` (or 404 if not yet complete)
    - Returns HTTP 429 when BullMQ queue depth ≥ 10
  - Verify: `npm test` + Supertest e2e
  - Files: `backend/src/exports/exports.controller.ts`, `backend/src/exports/exports.service.ts`, `backend/src/jobs/processors/export.processor.ts`

---

## Phase 3 — React Frontend

- [ ] Task: Bootstrap React + Vite project + Dockerfile
  - Acceptance: `docker compose up frontend` serves on `:5173`; page loads without console errors; TypeScript strict mode enabled
  - Verify: Open browser; check console
  - Files: `frontend/` (Vite scaffold), `frontend/Dockerfile`

- [ ] Task: Build `api/client.ts` — typed API wrappers
  - Acceptance: Functions for `submitVideo(url)`, `getJob(id)`, `getVideo(id)`, `submitExport(data)`, `getExport(id)` all typed with request/response interfaces; handles non-2xx as thrown errors
  - Verify: Unit test each function with `msw` mocking
  - Files: `frontend/src/api/client.ts`, `frontend/src/api/client.test.ts`

- [ ] Task: Build `useJob` hook
  - Acceptance: Polls `/jobs/:id` every 2s; stops automatically on `completed` or `failed`; returns `{ status, progress, error }`
  - Verify: Vitest test with fake timers + mock fetch
  - Files: `frontend/src/hooks/useJob.ts`, `frontend/src/hooks/useJob.test.ts`

- [ ] Task: Build `UrlInput` component (Step 1)
  - Acceptance: Validates YouTube URL client-side before submit; shows inline error on invalid URL; shows loading spinner while job is `waiting`/`active`; advances to Step 2 when job `completed`
  - Verify: Component test — renders, validates, shows error, shows spinner
  - Files: `frontend/src/components/UrlInput.tsx`, `frontend/src/components/UrlInput.test.tsx`

- [ ] Task: Build `VideoPlayer` component
  - Acceptance: Renders HTML5 `<video>` with `src` pointed at backend `/videos/:id/stream` (which 302-redirects to MinIO pre-signed URL); does not load video bytes through NestJS
  - Verify: Component test (mock src); verify `<video>` element has correct src
  - Files: `frontend/src/components/VideoPlayer.tsx`, `frontend/src/components/VideoPlayer.test.tsx`

- [ ] Task: Build `Timeline` + `ClipList` components + `useClips` hook
  - Acceptance: Dual-handle range slider for selecting start/end time per clip; "Add Clip" adds another range; each clip in `ClipList` shows start/end and a delete button; clips state managed in `useClips` hook
  - Verify: Vitest component test — add clip, delete clip, range updates
  - Files: `frontend/src/components/Timeline.tsx`, `frontend/src/components/ClipList.tsx`, `frontend/src/hooks/useClips.ts`

- [ ] Task: Build `TransitionPicker` + `ExportPanel` components (Step 3)
  - Acceptance: `TransitionPicker` renders fade/cut as selectable, slide as visually disabled with tooltip "Not yet supported"; `ExportPanel` shows progress bar while export job runs, then shows download button that opens the pre-signed URL directly
  - Verify: Component test — picker selection state; export panel shows correct states (loading, done, error)
  - Files: `frontend/src/components/TransitionPicker.tsx`, `frontend/src/components/ExportPanel.tsx`

- [ ] Task: Assemble `App.tsx` step flow + global styles
  - Acceptance: Full 3-step UI is navigable (URL Input → Video Editor → Export); dark theme; step indicator shows current step; no routing library needed (single page)
  - Verify: Manual walkthrough through all 3 steps
  - Files: `frontend/src/App.tsx`, `frontend/src/styles/index.css`

---

## Phase 4 — Integration & Polish

- [ ] Task: End-to-end Docker Compose integration test
  - Acceptance: `docker compose up --build` — all 6 services start; full user flow completes with a real YouTube URL (paste → download → select clips → export → download result); pre-signed URL opens directly in browser
  - Verify: Manual walkthrough in browser; check MinIO console for file presence during flow
  - Files: `docker-compose.yml` (final review)

- [ ] Task: Add Fargate resource limits to docker-compose.yml
  - Acceptance: `deploy.resources.limits` set on all services totalling ≤ 1GB RAM / 0.5 vCPU; `docker stats` shows no service exceeds limit; full export flow completes without OOM kill
  - Verify: `docker stats` during an active export job; no OOM events in `docker compose logs`
  - Files: `docker-compose.yml`

- [ ] Task: Complete README
  - Acceptance: README covers: (1) architecture diagram, (2) stack choices with rationale, (3) storage design: MinIO locally → S3 in production, why not shared volume, (4) no-DB rationale: what Redis stores, why it's sufficient, when a DB would be added, (5) resource management strategy per-service, (6) scaling answer: what breaks first at 1000 concurrent users and how to fix it
  - Verify: Human review — all 6 sections present and substantive
  - Files: `README.md`
