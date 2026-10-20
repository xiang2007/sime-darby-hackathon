"""Run COLMAP's two slowest steps, finding and matching features, on an NVIDIA graphics card.

The pycolmap package from pip has no GPU support on Windows or macOS, but COLMAP's own Windows
download (colmap-x64-windows-cuda.zip from https://github.com/colmap/colmap/releases) does. When the
worker is given that download with --colmap, it runs these two steps through it and then carries on
with pycolmap exactly as before. Both must be the same COLMAP version (see requirements.txt), since
they share the feature database.

On the GPU, COLMAP uses plain SIFT features. The CPU path also estimates each feature's slant
(affine shape) and pools it over several sizes, which helps with walls seen at a sharp angle but is
CPU only.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

import pycolmap

_exe: str | None = None


def find(path: str) -> str:
    """The COLMAP program inside a download folder, or the file itself."""
    p = Path(path).expanduser()
    if p.is_dir():
        for c in ("COLMAP.bat", "bin/colmap.exe", "colmap.exe", "bin/colmap", "colmap"):
            if (p / c).is_file():
                return str(p / c)
        raise FileNotFoundError(f"No COLMAP.bat or colmap.exe in {p}")
    if p.is_file():
        return str(p)
    raise FileNotFoundError(f"{p} doesn't exist")


def setup(path: str | None, log=print) -> bool:
    """Use the COLMAP program at path (or $COLMAP_PATH) for feature finding and matching. True if it's usable."""
    global _exe
    _exe = None
    path = path or os.environ.get("COLMAP_PATH")
    if not path:
        return False
    try:
        exe = find(path)
        out = subprocess.run([exe, "-h"], capture_output=True, text=True, timeout=60)
        text = out.stdout + out.stderr
    except (OSError, subprocess.SubprocessError) as e:
        log(f"Can't run COLMAP at {path} ({e}); using the CPU instead.")
        return False
    m = re.search(r"COLMAP (\d+\.\d+(?:\.\d+)?)", text)
    if not m:
        log(f"{exe} doesn't look like COLMAP; using the CPU instead.")
        return False
    if "without CUDA" in text:
        log(f"COLMAP {m.group(1)} at {exe} was built without GPU support (use the -cuda download); using the CPU instead.")
        return False
    want = ".".join(pycolmap.__version__.split(".")[:2])
    if not m.group(1).startswith(want):
        log(f"Warning: COLMAP {m.group(1)} doesn't match pycolmap {pycolmap.__version__}. "
            f"Download COLMAP {pycolmap.__version__} if matching fails.")
    _exe = exe
    log(f"Finding and matching features on the GPU with COLMAP {m.group(1)}.")
    return True


def enabled() -> bool:
    return _exe is not None


def _run(step: str, args: list[str], log) -> None:
    out = subprocess.run([_exe, step, *args], capture_output=True, text=True)
    if out.returncode != 0:
        tail = "\n".join((out.stderr or out.stdout).strip().splitlines()[-5:])
        raise RuntimeError(f"colmap {step} failed: {tail}")


def extract_and_match(db: Path, image_dir: Path, names: list[str], exhaustive: bool, log=print) -> None:
    """The same settings as the CPU path in floorplan.run_sfm, except the CPU-only SIFT options."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write("\n".join(names) + "\n")
        image_list = f.name
    try:
        _run("feature_extractor", [
            "--database_path", str(db), "--image_path", str(image_dir), "--image_list_path", image_list,
            "--ImageReader.camera_model", "SIMPLE_RADIAL", "--ImageReader.single_camera_per_folder", "1",
            "--ImageReader.default_focal_length_factor", "0.8",
            "--SiftExtraction.use_gpu", "1", "--SiftExtraction.max_image_size", "2048",
            "--SiftExtraction.max_num_features", "8192",
            "--SiftExtraction.estimate_affine_shape", "0", "--SiftExtraction.domain_size_pooling", "0",
        ], log)
    finally:
        os.unlink(image_list)
    log("Matching photos on the GPU…")
    common = ["--database_path", str(db), "--SiftMatching.use_gpu", "1", "--SiftMatching.guided_matching", "1"]
    if exhaustive:
        _run("exhaustive_matcher", common, log)
    else:
        _run("sequential_matcher", [*common, "--SequentialMatching.overlap", "20",
                                    "--SequentialMatching.quadratic_overlap", "1"], log)
