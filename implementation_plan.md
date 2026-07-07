# Video Editor Mini App — Implementation Plan

Build a web-based prototype where users paste a YouTube URL, select clip time ranges, apply transitions, and download a merged `.mp4` — running on 0.5 vCPU / 1 GB RAM.

---

## Assumptions I'm Making

> [!IMPORTANT]
> Please confirm or correct these before I start coding:

1. **Max source length**: YouTube videos ≤ 15 minutes (longer = OOM risk at 480p on 1GB)
2. **No auth required**: Single-user prototype, no login
3. **Ephemeral storage**: Job history and files do NOT persist across container restarts
4. **Output format**: MP4 H.264 (most compatible)
5. **Slide transition**: CPU-intensive — I'll stub it as "coming soon" and implement fade + cut only
6. **480p cap on download**: To stay within memory budget (you can raise this if more RAM is available)

---

## Open Questions

> [!WARNING]
> These need answers before implementation. I've noted my recommendations.

| # | Question | My Recommendation |
|---|---|---|
| 1 | Max YouTube video length to support? | ≤ 15 min |
| 2 | Should we implement "slide" transition? | No — stub it, too CPU-heavy |
| 3 | Should job history persist across restarts? | No — ephemeral is fine for prototype |
| 4 | Is 480p resolution cap acceptable? | Yes — required for 1GB RAM |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Compose                           │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │
│  │   Frontend   │   │   NestJS     │   │   Python     │   │
│  │  React/Vite  │──▶│    API       │──▶│   Worker     │   │
│  │  :5173       │   │   :3000      │   │  FastAPI     │   │
│  └──────────────┘   └──────┬───────┘   │   :8000      │   │
│                             │           └──────┬───────┘   │
│                      ┌──────▼───────┐          │           │
│                      │   Redis      │   FFmpeg + yt-dlp    │
│                      │  (BullMQ)    │   on shared volume   │
│                      └──────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

**Request flow:** User pastes URL → NestJS enqueues download job (BullMQ) → Python worker downloads via yt-dlp → User selects clips in timeline → NestJS calls Python `/merge` → Python runs FFmpeg concat+xfade → NestJS streams output file → file deleted after download.

---

## Proposed Changes

### Phase 0 — Infrastructure

#### [NEW] `docker-compose.yml`
5 services: `frontend`, `backend`, `worker`, `redis`, shared volume `/app/storage`

#### [NEW] `.env.example`
Environment variable template

#### [NEW] `README.md`
Placeholder; filled in during Phase 4

---

### Phase 1 — Python Worker (FastAPI + FFmpeg + yt-dlp)

#### [NEW] `worker/Dockerfile`
Python 3.11-slim + FFmpeg + yt-dlp + pip dependencies

#### [NEW] `worker/requirements.txt`
`fastapi`, `uvicorn`, `yt-dlp`, `pydantic`

#### [NEW] `worker/main.py`
FastAPI app with 4 routes: `GET /health`, `POST /download`, `POST /clip`, `POST /merge`

#### [NEW] `worker/services/downloader.py`
yt-dlp wrapper — saves to `/app/storage/{uuid}.mp4`, returns metadata

#### [NEW] `worker/services/clipper.py`
FFmpeg `-ss -to` to extract a time range; `-threads 1`

#### [NEW] `worker/services/merger.py`
FFmpeg concat with `xfade` filter for fade; direct concat for cut; slide stubbed

#### [NEW] `worker/services/storage.py`
Path helpers + cleanup cron (delete files > 1 hour old)

#### [NEW] `worker/tests/test_*.py`
pytest tests for each service using small sample clips

---

### Phase 2 — NestJS API

#### [NEW] `backend/` (NestJS scaffold)
`nest new backend` output + custom modules

#### [NEW] `backend/src/videos/`
`POST /videos` — validates YouTube URL, enqueues download job
`GET /videos/:id` — returns metadata when download complete

#### [NEW] `backend/src/jobs/`
BullMQ integration, job status tracking, download processor (calls Python worker)

#### [NEW] `backend/src/exports/`
`POST /exports` — calls Python worker `/clip` then `/merge`
`GET /exports/:id/download` — streams output file, deletes after send

---

### Phase 3 — React Frontend

#### [NEW] `frontend/` (Vite scaffold)
React 18 + TypeScript + Vite 5

#### [NEW] `frontend/src/components/UrlInput.tsx`
YouTube URL form with client-side validation

#### [NEW] `frontend/src/components/VideoPlayer.tsx`
HTML5 `<video>` element using backend proxy URL

#### [NEW] `frontend/src/components/Timeline.tsx`
Dual-handle range slider per clip (custom or `react-range`)

#### [NEW] `frontend/src/components/ClipList.tsx`
List of selected clips with add/remove

#### [NEW] `frontend/src/components/TransitionPicker.tsx`
fade / cut / slide (slide disabled with tooltip)

#### [NEW] `frontend/src/components/ExportPanel.tsx`
Progress indicator + download link when job done

#### [NEW] `frontend/src/hooks/useJob.ts`
Polls `/jobs/:id` every 2s, stops on done/error

#### [NEW] `frontend/src/styles/index.css`
Dark-theme design system

---

### Phase 4 — Integration & Polish

#### [MODIFY] `docker-compose.yml`
Add memory/CPU limits matching Fargate: `mem_limit: 1g`, `cpus: 0.5`

#### [NEW] `README.md` (complete)
Architecture diagram, stack rationale, resource management, scaling answer (1000 concurrent users)

---

## Resource Management Strategy

| Risk | Mitigation |
|---|---|
| OOM on yt-dlp | Cap at 480p: `--format "bestvideo[height<=480]+bestaudio"` |
| FFmpeg CPU spike | `-threads 1` on all FFmpeg calls |
| Concurrent requests | BullMQ `concurrency: 1`; return HTTP 429 if queue full |
| Disk exhaustion | Delete source after clipping; delete output after download; 1hr TTL sweep |

---

## Verification Plan

### Automated Tests
```bash
cd worker && pytest                    # Python unit tests
cd backend && npm test                 # NestJS unit + e2e
cd frontend && npm test                # React component tests
```

### Manual Verification
1. `docker compose up --build` — all 5 services healthy
2. Paste a real YouTube URL → video downloads within 60s
3. Select 2 clips using timeline → both appear in ClipList
4. Choose "fade" transition → export → download the .mp4
5. Verify output plays correctly in VLC/browser
6. Run with Docker memory limit, check `docker stats` — no OOM kills

---

## Files Summary

| Path | Purpose |
|---|---|
| [spec.md](/.agent/tasks/spec.md) | Full specification (6 core areas) |
| [plan.md](/.agent/tasks/plan.md) | Technical plan with phase details |
| [todo.md](/.agent/tasks/todo.md) | Ordered task checklist |
