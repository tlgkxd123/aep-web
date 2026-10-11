"""Weights for the bank so that its particles move as the reference's do: over their whole lives (rendered
at clock speed 1, inside the analysed region and bright enough to be found), the bank's outward steps over
two frames are spread over radius and speed as all the reference's tracks' steps are. Each round multiplies a
particle's weight by the geometric mean, over the frames it spends in each bin, of the reference's share of
steps there over the bank's (as the browser's calibration does with rendered frames, src/extra/pmatch/
calibrate.ts), mirrored pairs together; the browser then only corrects what its detector adds."""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch

from .appearance import interpolate
from .generator import LOG_AMPLITUDE, LOG_LIFE, OX, OY, VX, VY, VZ

#: Particles closer to the camera than this are not drawn (model.ts NEAR_Z).
NEAR_Z = 0.05


@dataclass
class Matching:
    weights: torch.Tensor
    #: Total variation distance between the bank's step histogram and the reference's, before and after.
    distance_before: float
    distance_after: float


def bank_occupancy(bank: torch.Tensor, r_edges: torch.Tensor, s_edges: torch.Tensor, height: float, center: tuple[float, float], region: tuple[float, float, float, float], light_depth: float, opacity: torch.Tensor, min_light: float, frame_rate: float = 60.0, chunk: int = 256) -> torch.Tensor:
    """Frames each bank particle spends in each (radius, outward speed) bin of two-frame steps."""
    bins = (len(r_edges) + 1) * (len(s_edges) + 1)
    out = torch.zeros(len(bank), bins, dtype=torch.float64, device=bank.device)
    dt = 1 / frame_rate
    cx, cy = center
    rx, ry, rw, rh = region
    curve = opacity.to(device=bank.device, dtype=torch.float64)
    b = bank.double()
    for begin in range(0, len(b), chunk):
        p = b[begin : begin + chunk]
        life = torch.exp(p[:, LOG_LIFE])
        ages = torch.arange(0, float(life.max()) + dt, dt, dtype=torch.float64, device=b.device)[None, :]
        vx, vy, vz, ox, oy = (p[:, i : i + 1] for i in (VX, VY, VZ, OX, OY))

        def at(a: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
            z = 1 + vz * a
            return height * (ox + vx * a) / z, height * (oy + vy * a) / z, z

        x0, y0, z0 = at(ages)
        x1, y1, z1 = at(ages + 2 * dt)
        alive = (ages + 2 * dt <= life[:, None]) & (z0 >= NEAR_Z) & (z1 >= NEAR_Z)
        inside = (x0 + cx >= rx) & (x0 + cx < rx + rw) & (y0 + cy >= ry) & (y0 + cy < ry + rh)
        light = torch.exp(p[:, LOG_AMPLITUDE])[:, None] * z0.clamp(min=NEAR_Z) ** -light_depth * interpolate(curve, (ages / life[:, None]).clamp(0, 1))
        keep = alive & inside & (light >= min_light)
        r0, r1 = torch.hypot(x0, y0), torch.hypot(x1, y1)
        which = torch.bucketize(0.5 * (r0 + r1), r_edges) * (len(s_edges) + 1) + torch.bucketize(0.5 * (r1 - r0), s_edges)
        rows = torch.arange(len(p), device=b.device)[:, None].expand_as(which)
        out[begin : begin + len(p)].index_put_((rows[keep], which[keep]), torch.ones(int(keep.sum()), dtype=torch.float64, device=b.device), accumulate=True)
    return out


def match_steps(occupancy: torch.Tensor, reference: torch.Tensor, pairs: bool, rounds: int = 60, max_step: float = 3.0, limit: float = 30.0) -> Matching:
    """Bank weights (mean 1, within 1 / limit .. limit of each other) whose step histogram matches `reference` (shares)."""
    n = len(occupancy)
    weights = torch.ones(n, dtype=torch.float64, device=occupancy.device)
    group = 2 if pairs and n % 2 == 0 else 1
    seen = occupancy.sum(1)

    def histogram(w: torch.Tensor) -> torch.Tensor:
        h = (w[:, None] * occupancy).sum(0)
        return h / h.sum().clamp(min=1e-12)

    def distance(w: torch.Tensor) -> float:
        return float(0.5 * (histogram(w) - reference).abs().sum())

    before = distance(weights)
    best = (before, weights.clone())
    for _ in range(rounds):
        ratio = torch.log((reference + 1e-4) / (histogram(weights) + 1e-4)).clamp(-math.log(max_step), math.log(max_step))
        score = (occupancy * ratio[None, :]).reshape(n // group, group, -1).sum((1, 2))
        total = seen.reshape(n // group, group).sum(1)
        factor = torch.where(total > 0, torch.exp(score / total.clamp(min=1e-12)), torch.ones_like(total))
        weights = weights * factor.repeat_interleave(group)
        weights = weights / weights.mean()
        weights = weights.clamp(weights.median() / limit, weights.median() * limit)
        weights = weights / weights.mean()
        d = distance(weights)
        if d < best[0]:
            best = (d, weights.clone())
    return Matching(best[1], before, best[0])
