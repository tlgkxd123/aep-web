"""The clock: how much particle time each frame of the reference advances.

A first estimate alternates track fits and per-frame steps: a frame's step is the one that best explains
all particle steps of that frame given their tracks' fits (Huber-weighted). That alternation does not
minimize one objective and drifts along warps of the clock that short tracks cannot tell apart, so the
estimate is then refined jointly: L-BFGS on the per-frame steps, minimizing the robust distance of every
track point from its track's fit, with each fit solved in closed form inside the loss. The refinement is
stopped early: run to convergence on real footage its steps take up tracker errors and the clock stops
following the music (on the reference protocol's window the audio network explains 0.94 of the held-back
clock after 20 iterations, 0.87 after 70 and 0.19 after 150), while synthetic tracks converge to the truth.

Tracks never determine the clock completely: warping it by τ -> τ / (1 + γτ) moves every particle exactly
as much as its own approach rate can make up for. The clock is kept at the γ at which it has no overall
quadratic trend over the window, scaled to one clock second per second."""

from __future__ import annotations

from dataclasses import dataclass

import torch

from .geometry import Fits, Tracks, clock_at, fit_tracks

#: Fits further than this from their track (rms, px) do not vote on the clock.
MAX_VOTE_RMS = 3.0


@dataclass
class Clock:
    first: int
    #: Particle time at each frame of the window (clock seconds, tau[0] = 0, one clock second per second on average).
    tau: torch.Tensor
    #: Clock speed over each frame's step from the previous one (clock seconds per second; speed[0] repeats speed[1]).
    speed: torch.Tensor
    #: Particle steps that measured each frame's clock step.
    evidence: torch.Tensor

    def at(self, frame: torch.Tensor) -> torch.Tensor:
        return clock_at(self.tau, frame, self.first)


@dataclass
class ClockFit:
    clock: Clock
    #: The tracks that took part and their fits in the final clock's time.
    tracks: Tracks
    fits: Fits


def straighten(tau: torch.Tensor, frame_rate: float) -> torch.Tensor:
    """The clock warped by τ / (1 + γτ) to no quadratic trend, then scaled to one clock second per second."""
    t = torch.arange(len(tau), dtype=tau.dtype, device=tau.device) / frame_rate
    design = torch.stack([torch.ones_like(t), t, t * t], 1)
    for _ in range(4):
        c = torch.linalg.lstsq(design, tau[:, None]).solution.flatten()
        if float(c[1]) <= 0:
            break
        gamma = c[2] / (c[1] * c[1])
        warped = 1 + gamma * tau
        if bool((warped <= 0.05).any()):
            break
        tau = tau / warped
    tau = tau - tau[0]
    return tau * (t[-1] / tau[-1].clamp(min=1e-9))


def refine_clock(tracks: Tracks, first: int, tau: torch.Tensor, frame_rate: float, iterations: int = 20, delta: float = 1.5) -> torch.Tensor:
    """Joint fit of the clock to every track point (Huber loss, `delta` px), from the clock `tau`."""
    total = tau[-1].clone()
    # Steps as softplus(u) frames of clock time: repeated frames of 30 fps sources need steps near zero.
    step = ((tau[1:] - tau[:-1]) * frame_rate).clamp(min=1e-4)
    u = torch.where(step > 20, step, torch.log(torch.expm1(step))).detach().requires_grad_()
    count = len(tracks.x)

    def clock() -> torch.Tensor:
        speed = torch.nn.functional.softplus(u)
        cumulative = torch.cat([speed.new_zeros(1), torch.cumsum(speed, 0)])
        return cumulative * (total / cumulative[-1])

    def loss() -> torch.Tensor:
        t = clock_at(clock(), tracks.frame, first)
        fits = fit_tracks(tracks, t)
        qx, qy = fits.position(t - fits.tau0[tracks.owner], tracks.owner)
        r = torch.hypot(tracks.x - qx, tracks.y - qy)
        ok = fits.valid[tracks.owner] & torch.isfinite(r)
        return torch.nn.functional.huber_loss(torch.where(ok, r, torch.zeros_like(r)), torch.zeros_like(r), delta=delta, reduction="sum") / count

    optimizer = torch.optim.LBFGS([u], lr=1.0, max_iter=iterations, history_size=20, tolerance_grad=1e-10, tolerance_change=1e-12, line_search_fn="strong_wolfe")

    def closure() -> torch.Tensor:
        optimizer.zero_grad()
        value = loss()
        value.backward()
        return value

    optimizer.step(closure)
    with torch.no_grad():
        return straighten(clock(), frame_rate)


def fit_clock(tracks: Tracks, first: int, frames: int, frame_rate: float, iterations: int = 6, min_points: int = 8, refine: int = 20) -> ClockFit:
    device = tracks.device
    used = tracks.select(tracks.sizes >= min_points)
    tau = torch.arange(frames, dtype=torch.float64, device=device) / frame_rate
    step = torch.full((frames,), 1 / frame_rate, dtype=torch.float64, device=device)
    o = used.owner
    later = torch.nonzero((o[1:] == o[:-1]) & (used.frame[1:] - used.frame[:-1] == 1)).flatten() + 1
    k = used.frame[later] - first
    inside = (k >= 1) & (k < frames)
    later, k = later[inside], k[inside]
    owner = o[later]
    dx = used.x[later] - used.x[later - 1]
    dy = used.y[later] - used.y[later - 1]
    evidence = torch.zeros(frames, dtype=torch.float64, device=device)
    for iteration in range(iterations):
        fits = fit_tracks(used, clock_at(tau, used.frame, first))
        votes = (fits.valid & (fits.rms <= MAX_VOTE_RMS))[owner].double()
        a = 0.5 * (tau[k] + tau[k - 1]) - fits.tau0[owner]
        gx, gy = fits.velocity(a, owner)
        if iteration == 0:
            weight = votes
        else:
            miss = torch.hypot(dx - gx * step[k], dy - gy * step[k])
            weight = votes * torch.clamp(1 / miss.clamp(min=1e-6), max=1)
        num = torch.zeros_like(tau).index_add_(0, k, weight * (dx * gx + dy * gy))
        den = torch.zeros_like(tau).index_add_(0, k, weight * (gx * gx + gy * gy))
        evidence = torch.zeros_like(tau).index_add_(0, k, votes)
        known = den > 1e-9
        known[0] = False
        measured = torch.where(known, torch.clamp(num / den.clamp(min=1e-12), min=0), torch.zeros_like(num))
        mean = measured[known].mean() if known.any() else torch.tensor(1 / frame_rate, dtype=torch.float64, device=device)
        step = torch.where(known, measured, mean)
        tau = straighten(torch.cat([tau.new_zeros(1), torch.cumsum(step[1:], 0)]), frame_rate)
        step = torch.cat([step[:1], tau[1:] - tau[:-1]])
    if refine:
        tau = refine_clock(used, first, tau, frame_rate, refine)
        step = torch.cat([step[:1], tau[1:] - tau[:-1]])
    fits = fit_tracks(used, clock_at(tau, used.frame, first))
    speed = step * frame_rate
    speed[0] = speed[1] if frames > 1 else 1.0
    return ClockFit(Clock(first, tau, speed, evidence), used, fits)
