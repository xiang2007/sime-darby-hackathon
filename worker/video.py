"""Turn a walk-through video into the photos the worker measures from.

Mirrors the in-browser capture checks in web/index.html (checkImage and the QC thresholds): a frame is kept
only if it is sharp, neither too dark nor overexposed, and not a blank wall. Frames that barely differ from the
last kept one (the phone was held still) are dropped, and the rest are thinned evenly down to max_frames.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

# Same values as QC in web/index.html.
SHARP, DARK, BRIGHT, TEXTURE, MIN_SIDE = 80, 45, 235, 0.035, 480
SAME_AS_LAST = 0.97     # correlation of 32×24 thumbnails above which a frame adds nothing new
MAX_SIDE = 2048         # photos from the app are resized to this before upload


class VideoError(Exception):
    pass


def check_frame(im):
    """Quality checks for one BGR frame, on a 640 px copy like the app. Returns (reasons, thumbnail)."""
    h0, w0 = im.shape[:2]
    s = min(1.0, 640 / max(w0, h0))
    small = cv2.resize(im, (round(w0 * s), round(h0 * s)), interpolation=cv2.INTER_AREA) if s < 1 else im
    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lap = g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:] - 4 * g[1:-1, 1:-1]
    sharp = float(lap.var())
    edges = (np.abs(g[1:-1, 2:] - g[1:-1, :-2]) + np.abs(g[2:, 1:-1] - g[:-2, 1:-1])) > 40
    reasons = []
    if sharp < SHARP:
        reasons.append("blurry")
    if g.mean() < DARK:
        reasons.append("too dark")
    if g.mean() > BRIGHT:
        reasons.append("overexposed")
    if edges.mean() < TEXTURE:
        reasons.append("blank wall")
    if min(w0, h0) < MIN_SIDE:
        reasons.append("too small")
    thumb = cv2.cvtColor(cv2.resize(im, (32, 24), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    return reasons, thumb.ravel(), sharp


def _ncc(a, b):
    a, b = a - a.mean(), b - b.mean()
    return float((a @ b) / (np.sqrt((a @ a) * (b @ b)) or 1.0))


def find_ffmpeg(given=None):
    """ffmpeg from --ffmpeg, then PATH, then the copy bundled with the imageio-ffmpeg package."""
    if given:
        return given
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise VideoError("ffmpeg wasn't found. Run pip install -r requirements.txt (it bundles one), install it "
                         "(https://ffmpeg.org/download.html), or pass --ffmpeg /path/to/ffmpeg.") from None


def extract_frames(video, *, fps=2.0, max_frames=80, ffmpeg=None, log=print):
    """Returns (files, stats): files is [(name, jpeg bytes)] ready for floorplan.prepare_images.
    stats["times"] maps each file name to its time in the video, in seconds."""
    video = Path(video)
    if not video.is_file():
        raise VideoError(f"{video} isn't a file.")
    exe = find_ffmpeg(ffmpeg)
    vf = f"fps={fps},scale='if(gt(iw,ih),min({MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min({MAX_SIDE},ih))'"
    with tempfile.TemporaryDirectory(prefix="ucampass-frames-") as tmp:
        cmd = [exe, "-v", "error", "-nostdin", "-i", str(video), "-an", "-vf", vf, "-q:v", "2", str(Path(tmp) / "%05d.jpg")]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode:
            raise VideoError(f"ffmpeg couldn't read {video.name}: {(r.stderr.strip().splitlines() or ['unknown error'])[-1]}")
        paths = sorted(Path(tmp).glob("*.jpg"))
        if not paths:
            raise VideoError(f"No frames came out of {video.name}.")
        kept, last, tally = [], None, {}
        for n, p in enumerate(paths):
            data = p.read_bytes()
            im = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if im is None:
                continue
            reasons, thumb, _ = check_frame(im)
            if reasons:
                for why in reasons:
                    tally[why] = tally.get(why, 0) + 1
                continue
            if last is not None and _ncc(last, thumb) > SAME_AS_LAST:
                tally["same view"] = tally.get("same view", 0) + 1
                continue
            kept.append((data, round(n / fps, 2)))
            last = thumb
    usable = len(kept)
    if usable > max_frames:
        kept = [kept[round(i * (usable - 1) / (max_frames - 1))] for i in range(max_frames)]
    files = [(f"{i:03d}.jpg", d) for i, (d, _) in enumerate(kept)]
    stats = {"extracted": len(paths), "usable": usable, "kept": len(kept), "dropped": tally,
             "times": {f"{i:03d}.jpg": t for i, (_, t) in enumerate(kept)}}
    log(f"{video.name}: {stats['extracted']} frames at {fps:g}/s, {usable} usable, using {len(kept)}"
        + (f" (dropped: {', '.join(f'{n} {w}' for w, n in sorted(tally.items()))})" if tally else ""))
    return files, stats
