"""
YouTube video downloader using yt-dlp.
Downloads to /tmp, uploads to S3/MinIO, then deletes the local file.
"""
import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import TypedDict

from config import settings
from services import s3_client


class DownloadResult(TypedDict):
    s3_key: str
    duration: float          # seconds
    title: str
    thumbnail_url: str


async def download_video(url: str, video_id: str):
    """
    Download a YouTube video via yt-dlp, upload to S3, clean up /tmp.
    Yields progress floats (0.0 to 100.0).
    Yields final DownloadResult dict at the end.

    Raises:
        ValueError: if the URL is invalid or the video exceeds limits
        RuntimeError: if yt-dlp or ffprobe fails
    """
    tmp_path = f"/tmp/{video_id}.mp4"
    s3_key = f"source/{video_id}/{video_id}.mp4"

    try:
        async for progress in _run_ytdlp(url, tmp_path):
            yield progress
            
        metadata = await _probe_metadata(tmp_path)

        # Enforce duration limit
        if metadata["duration"] > settings.max_video_seconds:
            raise ValueError(
                f"Video duration {metadata['duration']:.0f}s exceeds limit "
                f"of {settings.max_video_seconds}s (15 min)"
            )

        # Upload to S3/MinIO
        await asyncio.to_thread(s3_client.upload_file, tmp_path, s3_key)

    finally:
        # Always clean up /tmp — even on error
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    yield {
        "s3_key": s3_key,
        "duration": metadata["duration"],
        "title": metadata["title"],
        "thumbnail_url": metadata["thumbnail_url"],
    }


async def _run_ytdlp(url: str, output_path: str):
    """Run yt-dlp as a subprocess. Yields progress floats. Raises RuntimeError on failure."""
    import re
    
    cmd = [
        "yt-dlp",
        # Cap at 480p to stay within memory budget on 1GB RAM
        "--format", "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]",
        "--merge-output-format", "mp4",
        f"--max-filesize", f"{settings.max_filesize_mb}m",
        "--no-playlist",
        "--no-warnings",
        "--newline", # Ensure progress is printed on newlines, not carriage returns
        "-o", output_path,
        url,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    
    # yt-dlp progress looks like: [download]   5.0% of ...
    progress_pattern = re.compile(r'\[download\]\s+(\d+\.\d+)%')
    
    current_stream = 0
    last_pct = 0.0
    
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
            
        decoded = line.decode('utf-8', errors='replace').strip()
        match = progress_pattern.search(decoded)
        if match:
            try:
                pct = float(match.group(1))
                
                # Detect stream change (e.g., video finishes at 100%, audio starts at 0%)
                if pct < last_pct and (last_pct - pct) > 50.0:
                    current_stream += 1
                
                last_pct = pct
                
                if current_stream == 0:
                    # First stream (usually video) takes 0 -> 80%
                    yield pct * 0.8
                elif current_stream == 1:
                    # Second stream (usually audio) takes 80 -> 95%
                    yield 80.0 + (pct * 0.15)
                else:
                    # Any further streams max out at 95%
                    yield 95.0
            except ValueError:
                pass

    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(
            f"yt-dlp failed (exit {proc.returncode}): {stderr.decode('utf-8', errors='replace')[:500]}"
        )


async def _probe_metadata(file_path: str) -> dict:
    """Extract duration, title, and thumbnail URL using ffprobe."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        file_path,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()

    if proc.returncode != 0:
        # Fallback: file exists but metadata unavailable
        stat = os.stat(file_path)
        return {"duration": 0.0, "title": "Unknown", "thumbnail_url": ""}

    data = json.loads(stdout)
    fmt = data.get("format", {})
    tags = fmt.get("tags", {})

    return {
        "duration": float(fmt.get("duration", 0)),
        "title": tags.get("title", tags.get("TITLE", "Untitled")),
        "thumbnail_url": "",  # yt-dlp thumbnail is a separate download; skip for prototype
    }
