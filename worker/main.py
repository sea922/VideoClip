"""
Python Worker — FastAPI service
Handles video download (yt-dlp → S3) and processing (FFmpeg clip/merge → S3).
Called internally by the NestJS backend; not exposed to the public internet.
"""
import asyncio
import os
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

from services import s3_client
from services.downloader import download_video
from services.clipper import extract_clips
from services.merger import merge_clips, TransitionNotSupportedError

app = FastAPI(title="Video Editor Worker", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────
# Health check
# ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}


# ─────────────────────────────────────────────────────────────
# Download endpoint
# POST /download
# ─────────────────────────────────────────────────────────────
class DownloadRequest(BaseModel):
    url: str
    video_id: str

    @field_validator("url")
    @classmethod
    def validate_youtube_url(cls, v: str) -> str:
        if not (
            "youtube.com/watch" in v
            or "youtu.be/" in v
            or "youtube.com/shorts/" in v
        ):
            raise ValueError("URL must be a valid YouTube URL")
        return v


class DownloadResponse(BaseModel):
    s3_key: str
    duration: float
    title: str
    thumbnail_url: str


from fastapi.responses import StreamingResponse
import json

@app.post("/download")
async def download(req: DownloadRequest):
    async def generate():
        try:
            async for item in download_video(req.url, req.video_id):
                if isinstance(item, float):
                    yield json.dumps({"progress": item}) + "\n"
                elif isinstance(item, dict):
                    yield json.dumps({"result": item}) + "\n"
        except ValueError as e:
            yield json.dumps({"error": str(e), "status_code": 422}) + "\n"
        except RuntimeError as e:
            yield json.dumps({"error": str(e), "status_code": 500}) + "\n"
        except Exception as e:
            yield json.dumps({"error": str(e), "status_code": 500}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ─────────────────────────────────────────────────────────────
# Process (clip + merge) endpoint
# POST /process
# ─────────────────────────────────────────────────────────────
class ClipInput(BaseModel):
    start: float
    end: float

    @field_validator("end")
    @classmethod
    def end_after_start(cls, v: float, info) -> float:
        if "start" in info.data and v <= info.data["start"]:
            raise ValueError("end must be greater than start")
        return v


class ProcessRequest(BaseModel):
    video_id: str
    export_id: str
    clips: list[ClipInput]
    transition: str = "cut"


@app.post("/process")
async def process(req: ProcessRequest):
    """
    Returns a StreamingResponse yielding NDJSON with progress updates,
    and finally the result.
    """
    async def generate():
        tmp_dir = f"/tmp/{req.export_id}"
        source_path = f"{tmp_dir}/source.mp4"
        output_path = f"{tmp_dir}/output.mp4"
        source_s3_key = f"source/{req.video_id}/{req.video_id}.mp4"
        export_s3_key = f"exports/{req.export_id}/output.mp4"

        Path(tmp_dir).mkdir(parents=True, exist_ok=True)

        try:
            # 1. Download source from S3
            yield json.dumps({"progress": 0.0, "status": "Downloading source"}) + "\n"
            await asyncio.to_thread(
                s3_client.download_file, source_s3_key, source_path
            )

            # 2. Extract clips
            clips_dicts = [{"start": c.start, "end": c.end} for c in req.clips]
            clip_paths = []
            
            from services.clipper import extract_clip
            for i, clip in enumerate(clips_dicts):
                # Calculate progress: 5% up to 25% for extraction
                pct = 5.0 + (i / len(clips_dicts)) * 20.0
                yield json.dumps({"progress": pct, "status": f"Extracting clip {i+1}/{len(clips_dicts)}"}) + "\n"
                
                out = os.path.join(tmp_dir, f"clip_{i:03d}.mp4")
                await extract_clip(
                    source_path=source_path,
                    start=float(clip["start"]),
                    end=float(clip["end"]),
                    output_path=out,
                )
                clip_paths.append(out)

            # 3. Merge
            try:
                # Merge takes 25% to 95% of progress
                async for p in merge_clips(clip_paths, req.transition, output_path, tmp_dir):
                    if isinstance(p, float):
                        mapped_progress = 25.0 + (p * 0.7)
                        yield json.dumps({"progress": mapped_progress, "status": "Merging clips"}) + "\n"
            except TransitionNotSupportedError as e:
                yield json.dumps({"error": str(e), "status_code": 422}) + "\n"
                return

            # 4. Upload to S3
            yield json.dumps({"progress": 95.0, "status": "Uploading result"}) + "\n"
            await asyncio.to_thread(
                s3_client.upload_file, output_path, export_s3_key
            )
            
            yield json.dumps({"result": {"s3_key": export_s3_key}}) + "\n"

        except FileNotFoundError as e:
            yield json.dumps({"error": str(e), "status_code": 404}) + "\n"
        except ValueError as e:
            yield json.dumps({"error": str(e), "status_code": 422}) + "\n"
        except RuntimeError as e:
            yield json.dumps({"error": str(e), "status_code": 500}) + "\n"
        except Exception as e:
            yield json.dumps({"error": str(e), "status_code": 500}) + "\n"
        finally:
            # Always clean up /tmp regardless of success or failure
            shutil.rmtree(tmp_dir, ignore_errors=True)

    return StreamingResponse(generate(), media_type="application/x-ndjson")
