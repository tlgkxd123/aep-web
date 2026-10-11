"""The browser's analysis of a reference video window (src/extra/pmatch/dataset.ts), as arrays."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import tensors

DATASET_VERSION = 1

# Columns of `points`.
FRAME, X, Y, FLUX, PEAK, SPREAD, WHITENESS, BACK = range(8)


@dataclass
class Shake:
    """How the reference's picture shakes, as the browser measured it (shake.ts)."""

    frequency: float
    x: float
    y: float
    tilt: float
    level: float
    rms: float
    tilt_rms: float
    #: S_Shake Amplitude per analysed frame (1 at its 95th percentile) and whether the frame was measured.
    envelope: np.ndarray
    valid: np.ndarray


@dataclass
class Analysis:
    name: str
    width: int
    height: int
    frame_rate: float
    #: Frame index of the first analysed frame, and how many follow it.
    first: int
    frames: int
    train: tuple[float, float]
    region: tuple[float, float, float, float]
    mirror_axis: float | None
    mirror_score: float
    #: Where the particles stream out of (the tracks' focus of expansion), frame pixels.
    center: tuple[float, float]
    #: Audio features of the whole sound track: feature_rate frames per second.
    features: np.ndarray
    feature_rate: float
    #: Least peak of a detection that counts as a particle.
    min_peak: float
    #: Track points (see the column constants), track i owning points[track_start[i]:track_start[i + 1]].
    points: np.ndarray
    track_start: np.ndarray
    #: Whether the tiles around each track's first and last point were analysed.
    clear: np.ndarray
    #: Sprite crops resampled to a common spread (sprites.ts `canonical`), peak 1, rows top first.
    crop_templates: np.ndarray
    crop_sigma: np.ndarray
    crop_tint: np.ndarray
    #: Frame, x and y of each crop's detection.
    crop_at: np.ndarray
    template_reach: float
    shake: Shake | None

    @property
    def track_count(self) -> int:
        return len(self.track_start) - 1

    def track_of_point(self) -> np.ndarray:
        return np.repeat(np.arange(self.track_count), np.diff(self.track_start))


def load(path: str | Path) -> Analysis:
    arrays, metadata = tensors.read(path)
    meta = json.loads(metadata["pmatch"])
    if meta.get("version") != DATASET_VERSION:
        raise ValueError(f"dataset version {meta.get('version')} is not supported")
    shake = None
    if meta.get("shake"):
        s = meta["shake"]
        shake = Shake(
            frequency=float(s["frequency"]),
            x=float(s["x"]),
            y=float(s["y"]),
            tilt=float(s["tilt"]),
            level=float(s["level"]),
            rms=float(s["rms"]),
            tilt_rms=float(s["tiltRms"]),
            envelope=arrays["shake_envelope"].astype(np.float64),
            valid=arrays["shake_valid"].astype(bool),
        )
    return Analysis(
        name=str(meta["name"]),
        width=int(meta["width"]),
        height=int(meta["height"]),
        frame_rate=float(meta["frameRate"]),
        first=int(meta["first"]),
        frames=int(meta["frames"]),
        train=(float(meta["train"][0]), float(meta["train"][1])),
        region=tuple(float(v) for v in meta["region"]),
        mirror_axis=None if meta["mirrorAxis"] is None else float(meta["mirrorAxis"]),
        mirror_score=float(meta["mirrorScore"]),
        center=(float(meta["center"][0]), float(meta["center"][1])),
        features=arrays["features"].astype(np.float32),
        feature_rate=float(meta["featureRate"]),
        min_peak=float(meta["minPeak"]),
        points=arrays["points"].astype(np.float64),
        track_start=arrays["track_start"].astype(np.int64),
        clear=arrays["clear"].astype(bool),
        crop_templates=arrays["crop_templates"].astype(np.float32),
        crop_sigma=arrays["crop_sigma"].astype(np.float32),
        crop_tint=arrays["crop_tint"].astype(np.float32),
        crop_at=arrays["crop_at"].astype(np.float64),
        template_reach=float(meta["template"]["reach"]),
        shake=shake,
    )
