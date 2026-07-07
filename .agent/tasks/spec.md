# Spec: Video Editor Mini App

## Objective

Build a web-based video editor **prototype** that allows internal content creators to:
1. Paste a YouTube URL → system downloads the video
2. Select one or more time-range clips from that video
3. Merge selected clips into a single output video
4. Apply transition effects (fade, cut) between clips
5. Download the final merged `.mp4`

**User story:** "As a content creator, I paste a YouTube link, trim the parts I want, apply a fade between clips, and download a clean cut — without touching a command line."

**Success looks like:** A user can go from YouTube URL → exported `.mp4` in under 5 minutes, entirely in the browser UI, running reliably on 0.5 vCPU / 1 GB RAM.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React 18 (Vite 5) | Fast dev, component model suits a timeline UI |
| Backend API | NestJS 10 (Node.js 20) | Structured, DI-first, good job-queue ecosystem |
| Video Processing | Python 3.11 (FastAPI) + FFmpeg | FFmpeg is the de-facto standard; separate service keeps NestJS lean and memory isolated |
| Job Queue | BullMQ 5 + Redis 7 | Decouples HTTP response from slow processing; Redis also stores lightweight job metadata |
| File Storage | MinIO (local) → S3 (production) | S3-compatible object store; zero code change between local and prod; handles Fargate's stateless ephemeral filesystem |
| Container | Docker Compose (multi-service) | Reproducible, simulates Fargate constraints locally |
| YouTube Download | yt-dlp | Actively maintained, handles most YouTube URL formats |
| **Database** | **None — Redis only** | See rationale below |

**Dependency versions:**
- Node.js 20 LTS / NestJS 10
- React 18 + Vite 5 + TypeScript 5
- Python 3.11 / FastAPI 0.110 / Pydantic v2
- FFmpeg 6.x (installed in worker Docker image)
- BullMQ 5 / Redis 7 Alpine
- MinIO (latest) / boto3 / `@aws-sdk/client-s3`

---

## Why No Database — Design Decision

> **Decision: Redis is the only stateful dependency. No PostgreSQL, MySQL, MongoDB, or SQLite.**

This decision is intentional and grounded in the specific requirements of this system:

### 1. The Data Model is Ephemeral by Nature

The lifecycle of data in this system is short and linear:

```
URL submitted → video downloaded → clips selected → export processed → file downloaded → data expires
```

There is no entity that needs to persist beyond this session-scoped workflow. There are no "saved projects," no user libraries, no history to query. Every piece of data either disappears or becomes irrelevant once the user downloads their export.

### 2. The Constraint is Memory, Not Persistence

The system must run on **0.5 vCPU / 1 GB RAM**. A database process carries real overhead:

| Service | Approximate RAM |
|---|---|
| PostgreSQL (minimum) | 50–100 MB |
| MongoDB (minimum) | 100–150 MB |
| Redis (what we already need) | 10–30 MB |

We must run Redis regardless — BullMQ requires it. Adding a second database just to store job metadata and video titles burns memory that FFmpeg needs, for no benefit this prototype requires.

### 3. Redis IS a Database — We Are Using One

Redis is a persistent key-value store. We use it for:

```
Key: video:{videoId}         → Hash { s3Key, duration, title, thumbnailUrl }  TTL: 2h
Key: export:{exportId}       → Hash { presignedUrl, status, createdAt }        TTL: 2h
Key: bull:*                  → BullMQ job state machine (auto-managed)
```

This satisfies every data need:
- **Status polling** → BullMQ native job states (`waiting`, `active`, `completed`, `failed`)
- **Video metadata** → `HGET video:{id} duration title` after download
- **Export result** → `HGET export:{id} presignedUrl` for download link
- **Rate limiting** → `INCR ip:{addr}` + `EXPIRE`

No SQL query, join, or schema migration is needed to serve any of these lookups.

### 4. This is an Internal Tool Prototype, Not a Product

The requirements explicitly say *"internal tools"* and *"prototype."* There is no concept of user accounts, saved history, or cross-session data. An internal team member uses the tool, downloads the result, and moves on. A relational database is the right choice when data outlives a session, has relationships, or needs querying — none of which apply here.

### 5. When a Database Would Be Added

If the system evolved to require any of the following, a database (likely PostgreSQL) would be the right call:
- **User accounts** — who submitted which video, access control
- **Project history** — "show me my last 10 exports"
- **Admin dashboard** — aggregate queries, analytics
- **Audit trail** — for compliance or debugging production issues

For the current scope, Redis is correct. The services are already abstracted behind repository interfaces — swapping the backing store in the future is a one-file change.

---

## Commands

```bash
# Start all services (local dev)
docker compose up --build

# Start with resource limits matching Fargate (0.5 vCPU / 1 GB RAM)
docker compose --profile constrained up --build

# Individual services (without Docker)
cd frontend && npm run dev           # React on :5173
cd backend && npm run start:dev      # NestJS on :3000
cd worker && uvicorn main:app --reload  # FastAPI on :8000

# Tests
cd backend && npm test               # Unit + e2e (Jest + Supertest)
cd frontend && npm test              # Component tests (Vitest + RTL)
cd worker && pytest -v               # Python unit tests

# Lint
cd backend && npm run lint
cd frontend && npm run lint
cd worker && ruff check .

# Production build (frontend only)
cd frontend && npm run build
```

---

## Project Structure

```
fullstack-test/
├── docker-compose.yml          # 6 services: frontend, backend, worker, redis, minio, minio-init
├── .env.example                # All environment variables documented
├── README.md                   # Design decisions + scaling answer
├── requirements.md             # Original brief
├── tasks/
│   ├── spec.md                 # This file
│   ├── plan.md                 # Technical plan + request flow
│   └── todo.md                 # Ordered task checklist
│
├── frontend/                   # React + Vite SPA
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── UrlInput.tsx         # YouTube URL form + client-side validation
│       │   ├── VideoPlayer.tsx      # HTML5 video player (streams from MinIO via pre-signed URL)
│       │   ├── Timeline.tsx         # Dual-handle range slider per clip
│       │   ├── ClipList.tsx         # Selected clips management (add/remove)
│       │   ├── TransitionPicker.tsx # Fade | cut | slide (slide disabled)
│       │   └── ExportPanel.tsx      # Job progress + download link
│       ├── hooks/
│       │   ├── useJob.ts            # Polls /jobs/:id every 2s until terminal state
│       │   └── useClips.ts          # Clip selection state
│       ├── api/
│       │   └── client.ts            # Typed fetch wrappers for all endpoints
│       └── styles/
│           └── index.css            # Dark theme design system
│
├── backend/                    # NestJS REST API + BullMQ job orchestration
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts
│       ├── app.module.ts
│       ├── common/
│       │   ├── storage.service.ts   # S3/MinIO pre-signed URL generation (@aws-sdk/client-s3)
│       │   └── redis.service.ts     # Raw Redis HSET/HGET/EXPIRE for metadata
│       ├── videos/
│       │   ├── videos.controller.ts # POST /videos, GET /videos/:id, GET /videos/:id/stream
│       │   ├── videos.service.ts
│       │   └── videos.module.ts
│       ├── jobs/
│       │   ├── jobs.controller.ts   # GET /jobs/:id
│       │   ├── jobs.service.ts      # BullMQ wrapper
│       │   ├── jobs.module.ts
│       │   └── processors/
│       │       ├── download.processor.ts  # Calls worker /download, writes Redis
│       │       └── export.processor.ts    # Calls worker /process, writes Redis, generates pre-signed URL
│       └── exports/
│           ├── exports.controller.ts # POST /exports, GET /exports/:id
│           ├── exports.service.ts
│           └── exports.module.ts
│
└── worker/                     # Python FastAPI video processing service
    ├── Dockerfile               # python:3.11-slim + FFmpeg + yt-dlp
    ├── requirements.txt         # fastapi, uvicorn, boto3, yt-dlp, pydantic
    ├── main.py                  # FastAPI app + router registration
    ├── services/
    │   ├── downloader.py        # yt-dlp → /tmp → S3 upload
    │   ├── clipper.py           # FFmpeg -ss -to clip extraction
    │   ├── merger.py            # FFmpeg concat + xfade transitions
    │   └── s3_client.py         # boto3 wrapper (upload, download, delete)
    └── tests/
        ├── test_downloader.py
        ├── test_clipper.py
        └── test_merger.py
```

---

## Storage Design

**Local dev:** MinIO (S3-compatible, runs in Docker Compose)
**Production:** AWS S3 — only `STORAGE_ENDPOINT` env var changes

**Bucket layout:**
```
video-editor-storage/
├── source/{videoId}/{videoId}.mp4    ← downloaded from YouTube
└── exports/{exportId}/output.mp4    ← final merged result
```

**Why not a shared Docker volume?**
Fargate tasks run on isolated compute — there is no persistent shared filesystem between tasks. Using S3-compatible object storage from day one means the system runs identically locally and on Fargate, with zero code changes. It also allows pre-signed URLs so file downloads go directly from MinIO/S3 to the browser — no video bytes flow through the backend.

**File lifecycle:**
- Source files: deleted from S3 after the export job completes (or 2h TTL via MinIO lifecycle policy)
- Export files: deleted after the pre-signed URL is first used (or 2h TTL)
- `/tmp` on worker: always deleted immediately after S3 upload

---

## Code Style

### TypeScript / NestJS
```typescript
// Constructor DI only; no property injection
// async/await everywhere; no .then() chains
// class-validator DTOs for all request bodies

@Injectable()
export class ExportsService {
  constructor(
    private readonly jobsService: JobsService,
    private readonly storageService: StorageService,
    private readonly redisService: RedisService,
  ) {}

  async getExport(exportId: string): Promise<ExportResult> {
    const data = await this.redisService.hgetall(`export:${exportId}`);
    if (!data?.presignedUrl) throw new NotFoundException('Export not ready');
    return { presignedUrl: data.presignedUrl, status: data.status };
  }
}
```

### Python / FastAPI
```python
# Type hints on all functions
# Pydantic v2 models for request/response
# asyncio.create_subprocess_exec — never shell=True
# All /tmp files wrapped in try/finally for cleanup

@router.post("/process", response_model=ProcessResponse)
async def process_export(req: ProcessRequest) -> ProcessResponse:
    tmp_dir = Path(f"/tmp/{req.export_id}")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        clips = await clipper.extract_all(req.video_id, req.clips, tmp_dir)
        output = await merger.merge(clips, req.transition, tmp_dir)
        s3_key = await s3_client.upload(output, f"exports/{req.export_id}/output.mp4")
        return ProcessResponse(s3_key=s3_key)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
```

### React
```tsx
// Functional components + hooks only
// Co-locate state with the component that owns it
// Lift state to App only when two sibling components share it

export const Timeline: React.FC<TimelineProps> = ({ duration, onClipAdd }) => {
  const [range, setRange] = useState<[number, number]>([0, 10]);
  return <RangeSlider max={duration} value={range} onChange={setRange} />;
};
```

**Naming conventions:**
- Python files: `snake_case.py`
- React components: `PascalCase.tsx`
- NestJS files: `kebab-case.module.ts` / `kebab-case.service.ts`
- Variables: `camelCase` (TS/JS), `snake_case` (Python)
- Constants: `SCREAMING_SNAKE_CASE`
- Docker services: `lowercase-with-hyphens`

---

## Testing Strategy

| Layer | Framework | Location | Coverage Target |
|---|---|---|---|
| Backend unit | Jest | `backend/src/**/*.spec.ts` | 70%+ on services |
| Backend e2e | Jest + Supertest | `backend/test/*.e2e-spec.ts` | Happy path per endpoint |
| Python unit | pytest + moto (mock S3) | `worker/tests/test_*.py` | All FFmpeg wrappers + S3 client |
| Frontend | Vitest + React Testing Library | `frontend/src/**/*.test.tsx` | Component render + hook behaviour |

**What to mock:**
- `boto3` / AWS SDK → use `moto` library (Python) and `@aws-sdk/client-s3-mock` (Node)
- BullMQ → mock queue in unit tests, use real Redis only in e2e
- yt-dlp / FFmpeg binaries → not tested directly; wrap in service interfaces and mock the interface

**What NOT to test:** FFmpeg binary internals, yt-dlp network calls, MinIO networking.

---

## Boundaries

- **Always do:**
  - Validate YouTube URL format and domain before any processing
  - Cap source video: max 15 min duration, max 480p resolution
  - Write all worker temp files to `/tmp/{exportId}/`; delete in `finally` block
  - Use pre-signed URLs for file delivery — never stream video bytes through NestJS
  - Return structured `{ error, message, statusCode }` JSON for all errors
  - Set TTL on all Redis keys (2 hours maximum)

- **Ask first:**
  - Adding npm or pip packages
  - Changing S3 bucket layout or key naming convention
  - Changing the job queue implementation (BullMQ → SQS, etc.)
  - Raising the 480p resolution cap or 15-min duration cap

- **Never do:**
  - Pass user input to shell via `shell=True` or string interpolation
  - Commit `.env` files, video files, or AWS credentials
  - Load full video file into memory (always stream or use pre-signed URLs)
  - Block the Node.js event loop with synchronous I/O or CPU work

---

## Resource Management Strategy

Total budget: **0.5 vCPU / 1 GB RAM** across all services.

| Service | RAM Limit | CPU Limit | Rationale |
|---|---|---|---|
| worker | 600 MB | 0.35 vCPU | FFmpeg is the heaviest process |
| backend | 256 MB | 0.10 vCPU | Node.js event loop, mostly I/O |
| redis | 64 MB | 0.02 vCPU | Metadata + queue only |
| minio | 80 MB | 0.02 vCPU | Lightweight object store |
| **Total** | **~1000 MB** | **~0.49 vCPU** | Within Fargate target |

| Risk | Mitigation |
|---|---|
| OOM during yt-dlp | `--format "bestvideo[height<=480]+bestaudio"` caps resolution; `--max-filesize 500m` |
| OOM during FFmpeg | `-threads 1`; process clips sequentially; check `/tmp` usage before starting |
| Concurrent requests | BullMQ `concurrency: 1` on worker; return HTTP 429 when queue depth ≥ 10 |
| Disk exhaustion | Delete `/tmp` in `finally`; MinIO 2h lifecycle expiry on all objects |
| Redis memory growth | `removeOnComplete: true`, `removeOnFail: true`; 2h TTL on all custom keys |

---

## Success Criteria

- [ ] User pastes a valid YouTube URL; video is downloadable for editing within 60s
- [ ] User can select 2+ time ranges using the timeline UI
- [ ] Merged output video plays correctly in browser after export
- [ ] Fade and cut transitions both work correctly
- [ ] Slide transition is stubbed with a clear "not supported" message (no crash)
- [ ] The complete system runs inside Docker with `--memory=1g --cpus=0.5` without OOM-kill
- [ ] File downloads via pre-signed URL (no video bytes proxied through NestJS)
- [ ] README explains design decisions (storage choice, no-DB rationale, scaling answer)
- [ ] No raw user input is passed to shell commands

---

## Open Questions

1. **Slide transition:** Stub with 422 error, or implement? (Recommending: stub — too CPU-heavy for 0.5 vCPU)
2. **Max video length:** 15 min sufficient? (Recommending: yes — longer videos risk OOM at 480p)
3. **Output format:** MP4 H.264 / AAC assumed — correct?
4. **Multiple concurrent users:** Acceptable to queue and return 429 if busy? (Recommending: yes, correct behaviour for a constrained prototype)
