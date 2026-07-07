"""
Tests for merger.py.
Uses synthetic tiny video files created with FFmpeg (if available),
otherwise skips FFmpeg-dependent tests gracefully.
"""
import asyncio
import os
import shutil
import subprocess
import tempfile

import pytest


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def create_test_video(path: str, duration: float = 3.0) -> None:
    """Create a minimal synthetic video using FFmpeg for testing."""
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=blue:size=320x240:rate=25:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-c:a", "aac",
        "-threads", "1",
        path,
    ]
    subprocess.run(cmd, capture_output=True, check=True)


@pytest.fixture
def tmp_dir(tmp_path):
    d = tmp_path / "work"
    d.mkdir()
    return str(d)


# ──────────────────────────────────────────────
# TransitionNotSupportedError
# ──────────────────────────────────────────────
def test_slide_transition_raises():
    from services.merger import merge_clips, TransitionNotSupportedError

    async def run():
        with pytest.raises(TransitionNotSupportedError):
            await merge_clips(["a.mp4"], "slide", "out.mp4", "/tmp")

    asyncio.run(run())


def test_unknown_transition_raises():
    from services.merger import merge_clips

    async def run():
        with pytest.raises(ValueError, match="Unknown transition"):
            await merge_clips(["a.mp4"], "wipe", "out.mp4", "/tmp")

    asyncio.run(run())


def test_empty_clips_raises():
    from services.merger import merge_clips

    async def run():
        with pytest.raises(ValueError, match="At least one clip"):
            await merge_clips([], "cut", "out.mp4", "/tmp")

    asyncio.run(run())


# ──────────────────────────────────────────────
# FFmpeg-dependent tests (skipped if no ffmpeg)
# ──────────────────────────────────────────────
@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_merge_single_clip_cut(tmp_dir):
    """Single clip with 'cut' should copy the file."""
    from services.merger import merge_clips

    src = os.path.join(tmp_dir, "clip_000.mp4")
    out = os.path.join(tmp_dir, "output.mp4")
    create_test_video(src, duration=2.0)

    async def run():
        result = await merge_clips([src], "cut", out, tmp_dir)
        return result

    result = asyncio.run(run())
    assert os.path.exists(result)
    assert os.path.getsize(result) > 0


@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_merge_two_clips_cut(tmp_dir):
    """Two clips merged with 'cut' should produce a valid file."""
    from services.merger import merge_clips

    clip1 = os.path.join(tmp_dir, "clip_000.mp4")
    clip2 = os.path.join(tmp_dir, "clip_001.mp4")
    out = os.path.join(tmp_dir, "output.mp4")

    create_test_video(clip1, duration=2.0)
    create_test_video(clip2, duration=2.0)

    async def run():
        return await merge_clips([clip1, clip2], "cut", out, tmp_dir)

    result = asyncio.run(run())
    assert os.path.exists(result)
    assert os.path.getsize(result) > 1000


@pytest.mark.skipif(not has_ffmpeg(), reason="FFmpeg not installed")
def test_merge_two_clips_fade(tmp_dir):
    """Two clips merged with 'fade' transition should produce a valid file."""
    from services.merger import merge_clips

    clip1 = os.path.join(tmp_dir, "clip_000.mp4")
    clip2 = os.path.join(tmp_dir, "clip_001.mp4")
    out = os.path.join(tmp_dir, "output.mp4")

    create_test_video(clip1, duration=3.0)
    create_test_video(clip2, duration=3.0)

    async def run():
        return await merge_clips([clip1, clip2], "fade", out, tmp_dir)

    result = asyncio.run(run())
    assert os.path.exists(result)
    assert os.path.getsize(result) > 1000
