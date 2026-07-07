"""
FFmpeg clip merger with transition effects.

Supported transitions:
  - cut:  Direct concat via concat demuxer (lossless, fastest)
  - fade: xfade filter with 0.5s crossfade (requires re-encode)
  - slide: NOT SUPPORTED — raises HTTP 422

All intermediate files are written to a caller-provided tmp_dir.
The caller is responsible for cleaning up tmp_dir.
"""
import asyncio
import os
from enum import Enum


class Transition(str, Enum):
    CUT = "cut"
    FADE = "fade"
    SLIDE = "slide"


class TransitionNotSupportedError(Exception):
    """Raised when a requested transition is not implemented."""


async def merge_clips(
    clip_paths: list[str],
    transition: str,
    output_path: str,
    tmp_dir: str,
):
    """
    Merge a list of clip files into a single output video.
    Yields progress floats (0.0 to 100.0).
    Yields final output_path at the end.

    Args:
        clip_paths:  Ordered list of local .mp4 paths to merge.
        transition:  One of 'cut', 'fade', 'slide'.
        output_path: Destination path for the merged file.
        tmp_dir:     Directory for intermediate files.

    Raises:
        TransitionNotSupportedError: if transition == 'slide'
        ValueError: if fewer than 1 clip provided
        RuntimeError: if FFmpeg fails
    """
    if not clip_paths:
        raise ValueError("At least one clip is required")

    transition = transition.lower()

    if transition == Transition.SLIDE:
        raise TransitionNotSupportedError(
            "The 'slide' transition is not yet supported. "
            "Please use 'cut' or 'fade'."
        )

    if len(clip_paths) == 1:
        # Nothing to merge — just copy
        import shutil
        shutil.copy2(clip_paths[0], output_path)
        yield 100.0
        yield output_path
        return

    if transition == Transition.CUT:
        async for p in _merge_cut(clip_paths, output_path, tmp_dir):
            yield p
    elif transition == Transition.FADE:
        async for p in _merge_fade(clip_paths, output_path, tmp_dir):
            yield p
    else:
        raise ValueError(f"Unknown transition: {transition!r}")


async def _merge_cut(clip_paths: list[str], output_path: str, tmp_dir: str):
    """Concat clips with no transition. Yields progress. Yields output_path."""
    n = len(clip_paths)
    inputs = []
    total_duration = 0.0
    
    for p in clip_paths:
        inputs += ["-i", p]
        total_duration += await _get_duration(p)

    filter_complex = "".join(f"[{i}:v][{i}:a]" for i in range(n))
    filter_complex += f"concat=n={n}:v=1:a=1[outv][outa]"

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-threads", "1",
        "-preset", "ultrafast",
        output_path,
    ]

    async for p in _run_ffmpeg(cmd, total_duration):
        yield p
        
    yield output_path


async def _merge_fade(clip_paths: list[str], output_path: str, tmp_dir: str):
    """Merge clips with 0.5s crossfade. Yields progress. Yields output_path."""
    fade_duration = 0.5

    durations = []
    for path in clip_paths:
        dur = await _get_duration(path)
        durations.append(dur)

    n = len(clip_paths)
    inputs = []
    for p in clip_paths:
        inputs += ["-i", p]
        
    total_duration = sum(durations) - (n - 1) * fade_duration

    filter_parts = []
    video_labels = [f"[{i}:v]" for i in range(n)]
    audio_labels = [f"[{i}:a]" for i in range(n)]

    cumulative_offset = 0.0
    prev_v = video_labels[0]
    prev_a = audio_labels[0]

    for i in range(1, n):
        cumulative_offset += durations[i - 1] - fade_duration
        out_v = f"[xv{i}]" if i < n - 1 else "[outv]"
        out_a = f"[xa{i}]" if i < n - 1 else "[outa]"

        filter_parts.append(
            f"{prev_v}{video_labels[i]}xfade=transition=fade"
            f":duration={fade_duration}:offset={cumulative_offset:.3f}{out_v}"
        )
        filter_parts.append(
            f"{prev_a}{audio_labels[i]}acrossfade=d={fade_duration}{out_a}"
        )

        prev_v = f"[xv{i}]"
        prev_a = f"[xa{i}]"

    filter_complex = ";".join(filter_parts)

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-threads", "1",
        "-preset", "ultrafast",
        output_path,
    ]

    async for p in _run_ffmpeg(cmd, total_duration):
        yield p
        
    yield output_path


async def _get_duration(file_path: str) -> float:
    """Return video duration in seconds using ffprobe."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        file_path,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    try:
        return float(stdout.decode().strip())
    except ValueError:
        return 0.0


def _parse_ffmpeg_time(time_str: str) -> float:
    """Convert HH:MM:SS.ms to seconds."""
    try:
        h, m, s = time_str.split(':')
        return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return 0.0

async def _run_ffmpeg(cmd: list[str], total_duration: float):
    """Run FFmpeg and yield progress %. Raises RuntimeError on failure."""
    import re
    
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    
    # ffmpeg progress output contains: time=00:00:10.50
    time_pattern = re.compile(r'time=(\d{2}:\d{2}:\d{2}\.\d+)')
    
    full_stderr = []
    
    while True:
        line = await proc.stderr.readline()
        if not line:
            break
            
        decoded = line.decode('utf-8', errors='replace')
        full_stderr.append(decoded)
        
        match = time_pattern.search(decoded)
        if match and total_duration > 0:
            current_time = _parse_ffmpeg_time(match.group(1))
            pct = min((current_time / total_duration) * 100, 100.0)
            yield pct

    await proc.wait()

    if proc.returncode != 0:
        stderr_text = "".join(full_stderr)[-500:]
        raise RuntimeError(
            f"FFmpeg failed (exit {proc.returncode}): {stderr_text}"
        )
