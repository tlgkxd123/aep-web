"""How a particle looks over its flight, as the app draws it (sample.ts): light = amplitude * z^-lightDepth *
opacity(age / life) and size = size * z^-sizeDepth, z its depth relative to its birth. Robust regressions over
every point of every particle: per-particle intercepts (its amplitude and size), shared depth exponents, and
an opacity curve over life that only particles seen from birth to death inform.

Both regressions are linear in their parameters, so iteratively reweighted least squares solves their Huber
losses exactly: the per-particle intercepts are profiled out (each is its points' weighted mean residual), which
leaves a small system for the shared parameters."""

from __future__ import annotations

from dataclasses import dataclass

import torch

from .motion import Clock
from .population import Population

#: Samples of the opacity-over-life curve, birth to death (model.ts LIFE_SAMPLES).
LIFE_SAMPLES = 32
#: Huber threshold of the regressions, in natural-log units of light and size.
DELTA = 0.1


@dataclass
class Appearance:
    size_depth: float
    light_depth: float
    #: Opacity at LIFE_SAMPLES evenly spaced shares of life, peak 1.
    opacity: torch.Tensor
    #: Per particle: light at depth 1 and full opacity, and size (px) at depth 1.
    amplitude: torch.Tensor
    size: torch.Tensor
    #: Points of particles seen from birth to death, which informed the curve.
    curve_points: int


def interpolate(curve: torch.Tensor, u: torch.Tensor) -> torch.Tensor:
    x = u.clamp(0, 1) * (curve.numel() - 1)
    k = x.floor().long().clamp(max=curve.numel() - 2)
    return curve[k] + (curve[k + 1] - curve[k]) * (x - k)


def huber_regression(y: torch.Tensor, g: torch.Tensor, owner: torch.Tensor, count: int, penalty: torch.Tensor, iterations: int = 25) -> tuple[torch.Tensor, torch.Tensor]:
    """Per-group intercepts and shared coefficients minimizing Σ ρ(y - α[owner] - g θ) + θᵀ penalty θ, with
    ρ(r) = r² within DELTA and 2 DELTA |r| - DELTA² beyond (each iteration weights a point by min(1, DELTA / |r|))."""
    w = torch.ones_like(y)
    theta = torch.zeros(g.shape[1], dtype=y.dtype, device=y.device)
    alpha = torch.zeros(count, dtype=y.dtype, device=y.device)
    for _ in range(iterations):
        weight = torch.zeros(count, dtype=y.dtype, device=y.device).index_add_(0, owner, w).clamp(min=1e-12)
        y_mean = torch.zeros(count, dtype=y.dtype, device=y.device).index_add_(0, owner, w * y) / weight
        g_mean = torch.zeros(count, g.shape[1], dtype=y.dtype, device=y.device).index_add_(0, owner, w[:, None] * g) / weight[:, None]
        yt = y - y_mean[owner]
        gt = g - g_mean[owner]
        theta = torch.linalg.solve((gt * w[:, None]).T @ gt + penalty, (gt * w[:, None]).T @ yt)
        alpha = y_mean - g_mean @ theta
        residual = y - alpha[owner] - g @ theta
        w = torch.clamp(DELTA / residual.abs().clamp(min=1e-12), max=1)
    return alpha, theta


def fit_appearance(population: Population, clock: Clock, smoothness: float = 0.02) -> Appearance:
    tracks, fits = population.tracks, population.fits
    o = tracks.owner
    a = clock.at(tracks.frame) - fits.tau0[o]
    z = population.depth(a, o)
    u = ((a - population.birth[o]) / population.life[o]).clamp(0, 1)
    ok = (tracks.peak > 0) & (tracks.spread > 0) & (z > 0)
    o, z, u = o[ok], z[ok], u[ok]
    log_peak, log_spread, log_z = tracks.peak[ok].log(), tracks.spread[ok].log(), z.log()
    full = population.fully_seen[o]
    count = tracks.count
    n = len(log_peak)
    dtype, device = log_peak.dtype, log_peak.device

    # Light: columns -log z, then the curve's knots (linear interpolation, only for particles seen whole).
    x = u * (LIFE_SAMPLES - 1)
    k = x.floor().long().clamp(max=LIFE_SAMPLES - 2)
    f = (x - k) * full
    knots = torch.zeros(n, LIFE_SAMPLES, dtype=dtype, device=device)
    knots[torch.arange(n, device=device), k] = (1 - (x - k)) * full
    knots[torch.arange(n, device=device), k + 1] += f
    g = torch.cat([-log_z[:, None], knots], 1)
    bend = torch.zeros(LIFE_SAMPLES - 2, LIFE_SAMPLES, dtype=dtype, device=device)
    for i in range(LIFE_SAMPLES - 2):
        bend[i, i : i + 3] = torch.tensor([1.0, -2.0, 1.0], dtype=dtype, device=device)
    penalty = torch.zeros(LIFE_SAMPLES + 1, LIFE_SAMPLES + 1, dtype=dtype, device=device)
    # The curve's level is the intercepts' (a tiny ridge pins it); its bends cost `smoothness` per point.
    penalty[1:, 1:] = n * smoothness * bend.T @ bend + 1e-6 * n * torch.eye(LIFE_SAMPLES, dtype=dtype, device=device)
    _, light = huber_regression(log_peak, g, o, count, penalty)
    light_depth = float(light[0].clamp(-1, 2))
    curve = light[1:] - light[1:].max() if bool(full.any()) else torch.zeros(LIFE_SAMPLES, dtype=dtype, device=device)

    _, size = huber_regression(log_spread, -log_z[:, None], o, count, torch.zeros(1, 1, dtype=dtype, device=device))
    size_depth = float(size[0].clamp(-1, 2))

    # Every particle's amplitude at full opacity, its opacity read from its (extrapolated) share of life.
    amplitude = per_track_median(log_peak - interpolate(curve, u) + light_depth * log_z, o, count).exp()
    grown = per_track_median(log_spread + size_depth * log_z, o, count).exp()
    return Appearance(size_depth, light_depth, curve.exp().float(), amplitude, grown, int(full.sum()))


def per_track_median(values: torch.Tensor, owner: torch.Tensor, count: int) -> torch.Tensor:
    order = torch.argsort(values, stable=True)
    order = order[torch.argsort(owner[order], stable=True)]
    sizes = torch.bincount(owner, minlength=count)
    start = torch.cumsum(sizes, 0) - sizes
    return values[order][(start + sizes // 2).clamp(max=len(values) - 1)]
