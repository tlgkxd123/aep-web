"""Tracks as straight flights seen through a pinhole. Relative to the emitter a track's points follow
q(a) = (A + B a) / (1 - w a), with a the particle time since the track's first point, A its offset
there, B its sideways velocity and w its approach rate. Many tracks are fitted at once, in float64."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .dataset import FRAME, PEAK, SPREAD, X, Y, Analysis

#: The particle stays in front of the camera over its track: 1 - w a >= this.
MIN_DEPTH = 0.1
#: Prior on B for extrapolating a track: (point noise / spread of B)^2, the noise about 0.6 px and B within
#: about 20 px per clock second. Over a short track an outward step is explained as well by B as by approach,
#: and only the prior tells them apart. The clock is fitted without it.
B_PRIOR = (0.6 / 20) ** 2


@dataclass
class Tracks:
    """Points of many tracks, concatenated in track order: owner[p] is point p's track."""

    frame: torch.Tensor
    #: Position relative to the emitter, frame pixels.
    x: torch.Tensor
    y: torch.Tensor
    peak: torch.Tensor
    spread: torch.Tensor
    owner: torch.Tensor
    count: int
    #: Ids of the analysis's tracks each track is made of (one, or a stitched chain).
    sources: list[list[int]]

    @property
    def device(self) -> torch.device:
        return self.frame.device

    @property
    def first(self) -> torch.Tensor:
        return self.start[:-1]

    @property
    def last(self) -> torch.Tensor:
        return self.start[1:] - 1

    @property
    def start(self) -> torch.Tensor:
        sizes = torch.bincount(self.owner, minlength=self.count)
        return torch.cat([sizes.new_zeros(1), torch.cumsum(sizes, 0)])

    @property
    def sizes(self) -> torch.Tensor:
        return torch.bincount(self.owner, minlength=self.count)

    def sum(self, values: torch.Tensor) -> torch.Tensor:
        """Per-track sums of per-point values."""
        out = values.new_zeros((self.count,) + values.shape[1:])
        return out.index_add_(0, self.owner, values)

    def path_speed(self) -> torch.Tensor:
        """Mean distance a track's particle moves per frame (px)."""
        step = torch.hypot(self.x[1:] - self.x[:-1], self.y[1:] - self.y[:-1])
        same = self.owner[1:] == self.owner[:-1]
        path = self.x.new_zeros(self.count).index_add_(0, self.owner[1:][same], step[same])
        frames = (self.frame[self.last] - self.frame[self.first]).clamp(min=1)
        return path / frames

    @staticmethod
    def from_analysis(analysis: Analysis, center: tuple[float, float], device: torch.device) -> "Tracks":
        p = torch.as_tensor(analysis.points, dtype=torch.float64, device=device)
        sizes = torch.as_tensor(np.diff(analysis.track_start), device=device)
        owner = torch.repeat_interleave(torch.arange(len(sizes), device=device), sizes)
        return Tracks(
            frame=p[:, FRAME].round().long(),
            x=p[:, X] - center[0],
            y=p[:, Y] - center[1],
            peak=p[:, PEAK],
            spread=p[:, SPREAD],
            owner=owner,
            count=len(sizes),
            sources=[[i] for i in range(len(sizes))],
        )

    def chains(self, chains: list[list[int]]) -> "Tracks":
        """Tracks made by joining these tracks' points, chain by chain, in order."""
        start = self.start.tolist()
        index = [torch.arange(start[i], start[i + 1], device=self.device) for chain in chains for i in chain]
        order = torch.cat(index) if index else self.owner.new_zeros(0)
        lengths = torch.as_tensor([sum(start[i + 1] - start[i] for i in chain) for chain in chains], device=self.device)
        return Tracks(
            frame=self.frame[order],
            x=self.x[order],
            y=self.y[order],
            peak=self.peak[order],
            spread=self.spread[order],
            owner=torch.repeat_interleave(torch.arange(len(chains), device=self.device), lengths),
            count=len(chains),
            sources=[[s for i in chain for s in self.sources[i]] for chain in chains],
        )

    def select(self, keep: torch.Tensor) -> "Tracks":
        ids = torch.nonzero(keep).flatten().tolist()
        return self.chains([[i] for i in ids])


@dataclass
class Fits:
    ax: torch.Tensor
    ay: torch.Tensor
    bx: torch.Tensor
    by: torch.Tensor
    w: torch.Tensor
    #: Clock time of the first point and the track's clock duration.
    tau0: torch.Tensor
    span: torch.Tensor
    #: Root mean square distance of the points from the fit (px).
    rms: torch.Tensor
    valid: torch.Tensor

    def position(self, a: torch.Tensor, index: torch.Tensor | None = None) -> tuple[torch.Tensor, torch.Tensor]:
        ax, ay, bx, by, w = (v if index is None else v[index] for v in (self.ax, self.ay, self.bx, self.by, self.w))
        d = 1 - w * a
        return (ax + bx * a) / d, (ay + by * a) / d

    def velocity(self, a: torch.Tensor, index: torch.Tensor | None = None) -> tuple[torch.Tensor, torch.Tensor]:
        """dq/dτ at particle time a since the first point."""
        ax, ay, bx, by, w = (v if index is None else v[index] for v in (self.ax, self.ay, self.bx, self.by, self.w))
        d = 1 - w * a
        return (bx + w * ax) / (d * d), (by + w * ay) / (d * d)


def fit_tracks(tracks: Tracks, tau: torch.Tensor, ridge: float = 0.0) -> Fits:
    """Least-squares projective fits of every track at once, with clock time `tau` per point and a ridge on B.

    The unknowns enter linearly through q = A + B a + w a q. Particles fly toward the camera or across,
    never away (slowing down is the clock's), so w is held to [0, (1 - MIN_DEPTH) / span] and A, B are
    refitted where it had to be clamped.
    """
    o = tracks.owner
    tau0 = tau[tracks.first]
    span = tau[tracks.last] - tau0
    a = tau - tau0[o]
    x, y = tracks.x, tracks.y
    one = torch.ones_like(a)
    # Rows (1, 0, a, 0, a x) -> x and (0, 1, 0, a, a y) -> y: their normal equations need these sums.
    a2 = a * a
    rr = x * x + y * y
    n, sa, saa, sx, sy, sax, say, saax, saay, saarr, sarr = tracks.sum(torch.stack([one, a, a2, x, y, a * x, a * y, a2 * x, a2 * y, a2 * rr, a * rr], 1)).unbind(1)
    zero = torch.zeros_like(n)
    m = torch.stack(
        [
            torch.stack([n, zero, sa, zero, sax], 1),
            torch.stack([zero, n, zero, sa, say], 1),
            torch.stack([sa, zero, saa + ridge, zero, saax], 1),
            torch.stack([zero, sa, zero, saa + ridge, saay], 1),
            torch.stack([sax, say, saax, saay, saarr], 1),
        ],
        1,
    )
    v = torch.stack([sx, sy, sax, say, sarr], 1)
    solution, info = torch.linalg.solve_ex(m, v)
    valid = (info == 0) & (span > 1e-6) & torch.isfinite(solution).all(1)
    solution = torch.where(valid[:, None], solution, torch.zeros_like(solution))
    ax, ay, bx, by, w = solution.unbind(1)

    limit = (1 - MIN_DEPTH) / span.clamp(min=1e-9)
    clamped = (w < 0) | (w > limit)
    w = torch.where(w < 0, torch.zeros_like(w), torch.minimum(w, limit))
    # With w held, q (1 - w a) = A + B a per axis: sums of x d = x - w a x and x d a = a x - w a² x.
    ridged = saa + ridge
    det = n * ridged - sa * sa
    good = det.abs() > 1e-12
    det = torch.where(good, det, torch.ones_like(det))
    refit = []
    for s, sc, sac in ((sx, sax, saax), (sy, say, saay)):
        s0 = s - w * sc
        s1 = sc - w * sac
        refit.append(((ridged * s0 - sa * s1) / det, (n * s1 - sa * s0) / det))
    (ax2, bx2), (ay2, by2) = refit
    ax = torch.where(clamped, ax2, ax)
    bx = torch.where(clamped, bx2, bx)
    ay = torch.where(clamped, ay2, ay)
    by = torch.where(clamped, by2, by)
    valid = valid & (~clamped | good)

    fits = Fits(ax, ay, bx, by, w, tau0, span, torch.zeros_like(span), valid)
    qx, qy = fits.position(a, o)
    rms = torch.sqrt(tracks.sum((x - qx) ** 2 + (y - qy) ** 2) / n)
    fits.valid = valid & torch.isfinite(rms)
    fits.rms = torch.where(fits.valid, rms, torch.full_like(rms, float("inf")))
    return fits


def fits_well(tracks: Tracks, fits: Fits, max_rms: float, max_lag: float) -> torch.Tensor:
    """Fits close enough to their tracks: within max_rms px, or within max_lag frames of the particle's
    motion (errors in the clock move fast particles off their fits in proportion to their speed)."""
    return fits.valid & (fits.rms <= torch.clamp(max_lag * tracks.path_speed(), min=max_rms))


def clock_at(tau: torch.Tensor, frame: torch.Tensor, first: int) -> torch.Tensor:
    """Clock time at each frame index (held at the window's ends)."""
    return tau[(frame - first).clamp(0, len(tau) - 1)]
