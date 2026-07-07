# Design Decisions & Evaluation Write-up

This document explains the technical reasoning, tradeoffs, and product decisions made while building this Video Editor Mini App. 

---

## 1. System Design: Breaking Down the Problem

**How did you break down the problem? What tradeoffs did you make?**

The problem requires a web interface for users to select video clips, combined with heavy background processing to download videos and run FFmpeg.

**The Breakdown:**
- **Frontend (React/Vite)**: A lightweight, responsive SPA for video playback and clip selection. It communicates via REST and subscribes to Server-Sent Events (SSE) for real-time progress.
- **Backend (NestJS)**: Acts as an API gateway, orchestrating jobs and managing the state. It handles the API routes and pushes SSE updates, keeping the Node.js event loop free from heavy lifting.
- **Worker (Python FastAPI)**: Handles the CPU-intensive tasks (yt-dlp, FFmpeg). Python was chosen due to its robust ecosystem around video processing and subprocess management.
- **Message Broker (BullMQ + Redis)**: Decouples the fast backend from the slow worker. Redis stores job states and transient video metadata.
- **Object Storage (MinIO)**: Simulates AWS S3 locally. Since Fargate is ephemeral, persistent storage is delegated to S3.

**Tradeoffs:**
- **Microservices vs. Monolith**: Splitting the Node.js backend and Python worker adds operational complexity (more containers, message broker) but was necessary. Running FFmpeg in Node.js would block the event loop and make resource accounting impossible.
- **MinIO/S3 vs. Local Volume**: Writing to `/tmp` and immediately uploading to S3 adds latency and network overhead compared to a shared Docker volume. However, it ensures the architecture is fully stateless and ready for AWS ECS Fargate, where containers scale independently and don't share disks.

---

## 2. Resource Management

**How does your system behave under the memory/CPU constraint (0.5 vCPU, 1GB RAM)? What would break first, and how did you design around it?**

The strict constraint forces us to limit concurrency and memory footprint.
- **CPU Constraint (0.5 vCPU)**: FFmpeg is heavily multi-threaded by default and will consume all available CPU. I explicitly added `-threads 1` to all FFmpeg commands. This ensures it doesn't starve the FastAPI health checks or cause ECS to throttle the container.
- **RAM Constraint (1GB)**: Downloading massive 4K videos would overwhelm the disk and memory. I configured `yt-dlp` with `--format "bestvideo[height<=480]+bestaudio"` and `--max-filesize 500m`. We never load video chunks into memory; everything is streamed to `/tmp`, processed, and then streamed to S3.

**What would break first?** 
The Worker. With `concurrency: 1` configured in BullMQ, the worker can only process one video at a time to prevent OOM errors. Under load, the queue depth will spike, and users will experience long wait times.

**Design Around It:** 
The backend actively monitors the queue depth (`getWaitingCount()`). If the queue exceeds 10 jobs, the API returns an `HTTP 429 Too Many Requests`. This implements backpressure, protecting the system from cascading failure at the cost of rejecting new work.

---

## 3. Code Quality

**Is the code readable, structured, and maintainable?**

- **Type Safety**: The entire stack (Frontend + NestJS) uses strict TypeScript. Data contracts (like `ExportRequest` and `JobState`) are strongly typed, preventing runtime integration errors.
- **Modular Structure**: The NestJS backend is divided into logical feature modules (`VideosModule`, `ExportsModule`, `JobsModule`). Each module isolates its controllers, services, and DTOs.
- **Clean Interfaces**: The Python worker communicates strictly via BullMQ payloads and S3 object keys. There is no tight coupling or shared database schema between the Node.js and Python worlds.
- **Error Handling**: Standardized HTTP exception filters in NestJS, and robust `try/finally` blocks in Python to guarantee `/tmp` file cleanup even if FFmpeg crashes.

---

## 4. Product Sense

**Does the result actually work as a user experience?**

Yes. The interface focuses on hiding the complexity of video processing:
- **Real-time Feedback**: Instead of polling, Server-Sent Events (SSE) push live percentage updates from FFmpeg straight to the React UI.
- **Optimistic UI**: The editor allows the user to start creating clips immediately while the video is still downloading in the background.
- **History Tracking**: Users have a dedicated History tab to view past tasks, review previously downloaded videos, and download finalized exports without re-processing.
- **State Persistence**: By persisting job IDs and states in Redis, users can refresh the page and their exports will continue seamlessly.

---

## 5. Engineering Judgment

**What did you choose not to build, and why?**

- **No PostgreSQL/Relational Database**: I opted to use Redis (which was already required for BullMQ) as our primary data store using `HSET` with a 2-hour TTL. Since there are no user accounts, no long-term project saving, and all queries are simple key-value lookups, adding Postgres would have cost ~100MB of our precious 1GB RAM budget for zero tangible benefit.
- **No Complex Video Editor**: I didn't build a timeline with drag-and-drop waveforms. Instead, I built a functional list of clips with simple range sliders. This delivers the core value (clipping and merging) without getting bogged down in weeks of canvas/WebGL UI development.
- **No Websockets**: I used Server-Sent Events (SSE) instead of WebSockets. SSE is strictly unidirectional (Server -> Client), which perfectly maps to our use case of streaming progress updates, requires less overhead, and is natively supported over standard HTTP/1.1.

---

## 6. OPEN QUESTION — SCALING

**If 1,000 users submitted videos simultaneously, what would break first in your system — and how would you fix it?**

### What breaks first:
The Python Worker container. Currently, to stay within the 1GB RAM limit, the BullMQ worker is configured to process exactly one job at a time (`concurrency: 1`). If 1,000 users submit jobs simultaneously, the queue will instantly spike to 1,000. 
- The backend will start rejecting requests (due to our 429 backpressure).
- Jobs at the back of the queue would take hours to process.
- The Redis instance holding the queue might experience memory pressure if job payloads are large.

### How I would fix it (in order of implementation):

1. **Horizontal Scaling (Immediate Fix)**
   - BullMQ supports multiple consumers out-of-the-box. I would configure AWS ECS to use an Auto Scaling Group for the worker task.
   - We scale from 1 worker to 50 workers. Because we rely on S3 for state, workers are completely stateless and can process jobs in parallel with zero code changes.

2. **Split the Queues (Mid-term Fix)**
   - Downloading a video takes ~10 seconds, but merging with FFmpeg takes ~60 seconds. 
   - I would split `downloadQueue` and `exportQueue` into separate worker pools. This prevents fast download jobs from getting stuck behind slow export jobs.

3. **Client-Side Uploads / Caching (Long-term Fix)**
   - Instead of our server downloading the YouTube video, I would hash the YouTube URL. If another user has already requested it, we instantly serve the S3 link.
   - For custom videos, we would use S3 Pre-Signed Upload URLs so the client uploads bytes directly to S3, bypassing our infrastructure entirely and saving massive amounts of bandwidth and compute.

4. **Swap Redis for AWS SQS**
   - For true enterprise scale, I would replace BullMQ/Redis with AWS SQS. SQS is fully managed, infinitely scalable, and ties directly into ECS target tracking scaling policies based on queue depth.
