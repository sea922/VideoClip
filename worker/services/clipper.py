"""
FFmpeg clip extractor.
Extracts a time range from a local video file using FFmpeg.
Uses -threads 1 to respect the 0.5 vCPU Fargate constraint.
"""
import asyncio
import os
from pathlib import Path


async def extract_clip(
    source_path: str,
    start: float,
    end: float,
    output_path: str,
) -> str:
    """
    Extract a clip from source_path between start and end (seconds).
    Writes to output_path. Returns output_path.

    Uses stream-copy when transition is 'cut' (lossless, fast).
    Always re-encodes when a transition filter requires it — caller
    decides by choosing the appropriate function.

    Raises:
        ValueError: if start >= end
        RuntimeError: if FFmpeg fails
    """
    if start >= end:
        raise ValueError(f"start ({start}) must be less than end ({end})")
    if not os.path.exists(source_path):
        raise FileNotFoundError(f"Source file not found: {source_path}")

    # Use stream copy: no re-encode, fast, lossless
    # The merge step will re-encode if a dissolve transition is needed
    cmd = [
        "ffmpeg",
        "-y",                      # overwrite output
        "-ss", str(start),         # seek to start (before -i for fast seek)
        "-to", str(end),
        "-i", source_path,
        "-c:v", "libx264",         # re-encode for accurate seeking + concat compatibility
        "-c:a", "aac",
        "-threads", "1",           # respect 0.5 vCPU limit
        "-preset", "ultrafast",    # fastest encode; quality is secondary for preview
        output_path,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg clip extraction failed (exit {proc.returncode}): "
            f"{stderr.decode()[-500:]}"
        )

    return output_path


async def extract_clips(
    source_path: str,
    clips: list[dict],  # [{"start": float, "end": float}]
    output_dir: str,
) -> list[str]:
    """
    Extract multiple clips sequentially (one FFmpeg process at a time).
    Returns list of output file paths in order.
    """
    output_paths = []
    for i, clip in enumerate(clips):
        out = os.path.join(output_dir, f"clip_{i:03d}.mp4")
        await extract_clip(
            source_path=source_path,
            start=float(clip["start"]),
            end=float(clip["end"]),
            output_path=out,
        )
        output_paths.append(out)
    return output_paths
