import numpy as np
import torch

from pmatch.geometry import Tracks, fit_tracks
from pmatch.motion import fit_clock


DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def make_tracks(points: list[np.ndarray]) -> Tracks:
    """Tracks from per-track arrays of (frame, x, y) relative to the emitter."""
    sizes = torch.as_tensor([len(p) for p in points], device=DEVICE)
    flat = torch.as_tensor(np.concatenate(points), dtype=torch.float64, device=DEVICE)
    return Tracks(
        frame=flat[:, 0].round().long(),
        x=flat[:, 1],
        y=flat[:, 2],
        peak=torch.ones(len(flat), dtype=torch.float64, device=DEVICE),
        spread=torch.ones(len(flat), dtype=torch.float64, device=DEVICE),
        owner=torch.repeat_interleave(torch.arange(len(points), device=DEVICE), sizes),
        count=len(points),
        sources=[[i] for i in range(len(points))],
    )


def flight(a: np.ndarray, A: np.ndarray, B: np.ndarray, w: float) -> np.ndarray:
    d = 1 - w * a
    return (A[None, :] + B[None, :] * a[:, None]) / d[:, None]


def test_projective_fit_recovers_known_tracks():
    rng = np.random.default_rng(1)
    truth, points = [], []
    for _ in range(300):
        frames = int(rng.integers(10, 60))
        start = int(rng.integers(0, 200))
        a = np.arange(frames) / 60.0
        A = rng.uniform(-300, 300, 2)
        B = rng.uniform(-20, 20, 2)
        w = rng.uniform(0.0, 0.8 / a[-1])
        xy = flight(a, A, B, w)
        points.append(np.column_stack([start + np.arange(frames), xy]))
        truth.append((A, B, w))
    tracks = make_tracks(points)
    fits = fit_tracks(tracks, tracks.frame.double() / 60.0)
    assert bool(fits.valid.all())
    assert float(fits.rms.max()) < 1e-6
    for i, (A, B, w) in enumerate(truth):
        assert abs(float(fits.ax[i]) - A[0]) < 1e-5 and abs(float(fits.by[i]) - B[1]) < 1e-4 and abs(float(fits.w[i]) - w) < 1e-6


def test_clock_fit_recovers_a_known_clock():
    rng = np.random.default_rng(2)
    frames = 600
    k = np.arange(frames)
    speed = 1 + 0.5 * np.sin(2 * np.pi * k / 90) + 0.3 * np.sin(2 * np.pi * k / 23)
    speed /= speed[1:].mean()
    tau = np.concatenate([[0.0], np.cumsum(speed[1:] / 60.0)])
    points = []
    while len(points) < 2500:
        born = int(rng.integers(0, frames - 20))
        length = int(rng.integers(20, 120))
        span = np.arange(born, min(frames, born + length))
        a = tau[span] - tau[span[0]]
        angle = rng.uniform(0, 2 * np.pi)
        A = rng.uniform(40, 250) * np.array([np.cos(angle), np.sin(angle)])
        B = rng.normal(0, 8, 2)
        w = rng.uniform(0.05, 0.6)
        keep = 1 - w * a > 0.2
        xy = flight(a[keep], A, B, w) + rng.normal(0, 0.3, (int(keep.sum()), 2))
        if keep.sum() >= 10:
            points.append(np.column_stack([span[keep], xy]))
    tracks = make_tracks(points)
    # The early-stopped default, and the joint refinement run to convergence on these well-specified tracks.
    default = fit_clock(tracks, first=0, frames=frames, frame_rate=60.0)
    assert np.corrcoef(default.clock.speed.cpu().numpy()[2:], speed[2:])[0, 1] > 0.97
    converged = fit_clock(tracks, first=0, frames=frames, frame_rate=60.0, refine=150)
    assert np.corrcoef(converged.clock.speed.cpu().numpy()[2:], speed[2:])[0, 1] > 0.99
    assert float((converged.clock.tau.cpu() - torch.as_tensor(tau)).abs().max()) < 0.05
    assert abs(float(converged.clock.tau[-1]) - (frames - 1) / 60.0) < 1e-9
