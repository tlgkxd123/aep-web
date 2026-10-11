"""The particles the reference shows, as states at birth: tracks are stitched where the tracker lost a
particle for a while, fitted in the clock's time with a prior on sideways velocity, and extrapolated back
to a birth when the particle came out from behind something and on to a death when it left the analysed
area. States are in model units (src/extra/pmatch/model.ts): screen coordinates relative to the emitter in
frame heights, with the particle at depth 1 at its birth."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .dataset import FRAME, X, Y, Analysis
from .geometry import B_PRIOR, MIN_DEPTH, Fits, Tracks, fit_tracks, fits_well
from .motion import Clock


@dataclass
class StitchOptions:
    #: Longest gap bridged (frames).
    max_gap: int = 90
    #: Fragments need this many points to predict across a gap.
    min_points: int = 4
    #: Gate: px plus this share of the distance across the gap.
    gate_base: float = 3.0
    gate_share: float = 0.05
    #: Joined tracks that do not fit well fall apart into their fragments again.
    max_rms: float = 2.0
    max_lag: float = 2.5


def stitch(tracks: Tracks, clock: Clock, options: StitchOptions = StitchOptions(), chunk: int = 2048) -> tuple[Tracks, int]:
    """Joins the fragments of one particle's flight: a fragment's end joins a later fragment's start when
    each one's fit predicts the other across the gap (cheapest pairs first)."""
    device = tracks.device
    fits = fit_tracks(tracks, clock.at(tracks.frame), ridge=B_PRIOR)
    usable = fits.valid & (tracks.sizes >= options.min_points)
    first, last = tracks.first, tracks.last
    first_frame, last_frame = tracks.frame[first], tracks.frame[last]
    fx, fy, lx, ly = tracks.x[first], tracks.y[first], tracks.x[last], tracks.y[last]
    candidates = torch.nonzero(usable).flatten()
    candidates = candidates[torch.argsort(first_frame[candidates], stable=True)]
    starts = first_frame[candidates]
    heads = torch.nonzero(usable).flatten()
    found_i, found_j, found_cost = [], [], []
    for begin in range(0, len(heads), chunk):
        i = heads[begin : begin + chunk]
        lo = torch.searchsorted(starts, last_frame[i] + 1, right=False)
        hi = torch.searchsorted(starts, last_frame[i] + options.max_gap, right=True)
        counts = (hi - lo).clamp(min=0)
        total = int(counts.sum())
        if not total:
            continue
        ii = torch.repeat_interleave(i, counts)
        offset = torch.arange(total, device=device) - torch.repeat_interleave(torch.cumsum(counts, 0) - counts, counts)
        jj = candidates[torch.repeat_interleave(lo, counts) + offset]
        a1 = clock.at(first_frame[jj]) - fits.tau0[ii]
        a2 = clock.at(last_frame[ii]) - fits.tau0[jj]
        ahead_ok = 1 - fits.w[ii] * a1 >= MIN_DEPTH
        back_ok = 1 - fits.w[jj] * a2 >= MIN_DEPTH
        px, py = fits.position(a1, ii)
        bx, by = fits.position(a2, jj)
        gate = options.gate_base + options.gate_share * torch.hypot(fx[jj] - lx[ii], fy[jj] - ly[ii])
        d1 = torch.hypot(px - fx[jj], py - fy[jj])
        d2 = torch.hypot(bx - lx[ii], by - ly[ii])
        keep = ahead_ok & back_ok & (d1 <= gate) & (d2 <= gate)
        found_i.append(ii[keep])
        found_j.append(jj[keep])
        found_cost.append(((d1 + d2) / gate)[keep])
    following = [-1] * tracks.count
    previous = [-1] * tracks.count
    if found_i:
        cost = torch.cat(found_cost)
        order = torch.argsort(cost, stable=True)
        for i, j in zip(torch.cat(found_i)[order].tolist(), torch.cat(found_j)[order].tolist()):
            if following[i] < 0 and previous[j] < 0:
                following[i] = j
                previous[j] = i
    chains: list[list[int]] = []
    for i in range(tracks.count):
        if previous[i] >= 0:
            continue
        chain = [i]
        while following[chain[-1]] >= 0:
            chain.append(following[chain[-1]])
        chains.append(chain)
    joined = [c for c in chains if len(c) > 1]
    accepted: set[int] = set()
    if joined:
        trial = tracks.chains(joined)
        good = fits_well(trial, fit_tracks(trial, clock.at(trial.frame), ridge=B_PRIOR), options.max_rms, options.max_lag)
        accepted = {id(c) for c, ok in zip(joined, good.tolist()) if ok}
    out: list[list[int]] = []
    links = 0
    for chain in chains:
        if len(chain) == 1 or id(chain) in accepted:
            out.append(chain)
            links += len(chain) - 1
        else:
            out.extend([k] for k in chain)
    return tracks.chains(out), links


@dataclass
class PopulationOptions:
    #: Tracks with fewer points, or that their fits do not fit well, are not used.
    min_points: int = 8
    max_rms: float = 1.5
    max_lag: float = 2.5
    #: Particles that come out from behind something are born where their radius was this share of the first seen one.
    birth_share: float = 0.5
    #: Longest extrapolation before the first point and after the last (clock seconds).
    max_back: float = 10.0
    max_ahead: float = 6.0
    #: Particles fly on until this many px past the frame's edge.
    frame_margin: float = 24.0


@dataclass
class Population:
    tracks: Tracks
    fits: Fits
    #: Birth and death, clock seconds from each track's first point (birth <= 0 < death).
    birth: torch.Tensor
    death: torch.Tensor
    emerged: torch.Tensor
    censored: torch.Tensor
    #: Velocity (vx, vy, vz) and birth offset (ox, oy) in model units, depth 1 at birth.
    motion: torch.Tensor
    #: Births per clock second seen on the analysed side (before calibration), and the clock's span.
    rate: float
    links: int

    @property
    def life(self) -> torch.Tensor:
        return self.death - self.birth

    @property
    def fully_seen(self) -> torch.Tensor:
        return ~self.emerged & ~self.censored

    def depth(self, a: torch.Tensor, index: torch.Tensor) -> torch.Tensor:
        """Depth at clock time a since the first point, relative to the depth at birth."""
        w = self.fits.w[index]
        return (1 - w * a) / (1 - w * self.birth[index])


def build_population(analysis: Analysis, all_tracks: Tracks, clock: Clock, options: PopulationOptions = PopulationOptions(), stitching: StitchOptions = StitchOptions()) -> Population:
    stitched, links = stitch(all_tracks, clock, stitching)
    fits = fit_tracks(stitched, clock.at(stitched.frame), ridge=B_PRIOR)
    used = (stitched.sizes >= options.min_points) & fits_well(stitched, fits, options.max_rms, options.max_lag)
    tracks = stitched.select(used)
    fits = fit_tracks(tracks, clock.at(tracks.frame), ridge=B_PRIOR)
    device = tracks.device
    clear = torch.as_tensor(analysis.clear, device=device)
    clear_first = clear[[s[0] for s in tracks.sources], 0]
    clear_last = clear[[s[-1] for s in tracks.sources], 1]
    first_frame = tracks.frame[tracks.first]
    last_frame = tracks.frame[tracks.last]
    window_end = clock.first + len(clock.tau) - 1
    emerged = (first_frame - clock.first < 2) | ~clear_first
    censored = (window_end - last_frame < 2) | ~clear_last

    def radius(a: torch.Tensor) -> torch.Tensor:
        x, y = fits.position(a)
        return torch.hypot(x, y)

    # Birth: back along the fit until the radius has shrunk to birth_share of the first seen one.
    r0 = torch.hypot(fits.ax, fits.ay)
    target = options.birth_share * r0
    lo = torch.full_like(r0, -options.max_back)
    hi = torch.zeros_like(r0)
    far = radius(lo) > target
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        outside = radius(mid) > target
        hi = torch.where(outside, mid, hi)
        lo = torch.where(outside, lo, mid)
    birth = torch.where(emerged, torch.where(far, torch.full_like(r0, -options.max_back), hi), torch.zeros_like(r0))

    # Death: the last point, or on along the fit until the particle leaves the frame.
    dt = 1 / 60
    end = clock.at(last_frame) - fits.tau0
    limit = torch.where(fits.w > 0, torch.minimum(end + options.max_ahead, (1 - MIN_DEPTH) / fits.w.clamp(min=1e-12)), end + options.max_ahead)
    steps = int(np.ceil(options.max_ahead / dt)) + 2
    a = end[:, None] + torch.arange(steps, device=device, dtype=torch.float64)[None, :] * dt
    x, y = fits.position(a, torch.arange(tracks.count, device=device)[:, None])
    cx, cy = analysis.center
    m = options.frame_margin
    inside = (x + cx >= -m) & (y + cy >= -m) & (x + cx <= analysis.width + m) & (y + cy <= analysis.height + m) & torch.isfinite(x) & torch.isfinite(y)
    stop = ~inside | (a >= limit[:, None])
    first_stop = torch.where(stop.any(1), stop.float().argmax(1), torch.full_like(end, steps - 1, dtype=torch.long))
    reached = a.gather(1, first_stop[:, None]).squeeze(1)
    death = torch.where(censored, torch.maximum(end + dt, torch.minimum(reached, limit)), end + dt)

    d = 1 - fits.w * birth
    H = analysis.height
    keep = (death - birth > 0) & (d > MIN_DEPTH)
    motion = torch.stack([fits.bx / (d * H), fits.by / (d * H), -fits.w / d, (fits.ax + fits.bx * birth) / (d * H), (fits.ay + fits.by * birth) / (d * H)], 1)
    if not bool(keep.all()):
        index = torch.nonzero(keep).flatten()
        tracks = tracks.select(keep)
        fits = fit_tracks(tracks, clock.at(tracks.frame), ridge=B_PRIOR)
        birth, death, emerged, censored, motion = birth[index], death[index], emerged[index], censored[index], motion[index]
    span = float(clock.tau[-1] - clock.tau[0])
    rate = max(1, tracks.count) / max(1e-6, span)
    return Population(tracks, fits, birth, death, emerged, censored, motion, rate, links)


def two_frame_steps(tracks: Tracks) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Outward steps over two frames, as metrics.ts measures them: each step's track, radius between and px per frame."""
    index = torch.arange(len(tracks.frame), device=tracks.device)
    pairs = []
    # The point two frames on is the next one, or the one after when the frame between was seen too.
    for k in (1, 2):
        p, q = index[:-k], index[k:]
        ok = (tracks.owner[p] == tracks.owner[q]) & (tracks.frame[q] - tracks.frame[p] == 2)
        pairs.append((p[ok], q[ok]))
    p = torch.cat([a for a, _ in pairs])
    q = torch.cat([b for _, b in pairs])
    r0 = torch.hypot(tracks.x[p], tracks.y[p])
    r1 = torch.hypot(tracks.x[q], tracks.y[q])
    return tracks.owner[p], 0.5 * (r0 + r1), 0.5 * (r1 - r0)


def selection_weights(all_tracks: Tracks, population: Population, radius_bins: int = 10, speed_bins: int = 8, limit: float = 5.0) -> torch.Tensor:
    """How much each particle of the population stands for: the tracker loses fast particles more often, and
    only long, well-fitting tracks become particles, so the population under-represents some motions.

    Steps over two frames are binned by radius and outward speed at the quantiles of all tracks' steps; in each
    bin the share of steps that the population's tracks made is how likely a motion there was to be kept, and a
    particle's weight is the geometric mean of the inverse share over its own steps (within 1 / limit .. limit,
    normalized to a mean of 1). Both sides are measured by the same detector and tracker."""
    _, r_all, s_all = two_frame_steps(all_tracks)
    owner, r_used, s_used = two_frame_steps(population.tracks)
    count = population.tracks.count
    if len(r_all) < radius_bins * speed_bins or not len(r_used):
        return torch.ones(count, dtype=torch.float64, device=all_tracks.device)

    def edges(values: torch.Tensor, n: int) -> torch.Tensor:
        return torch.quantile(values, torch.arange(1, n, device=values.device, dtype=values.dtype) / n)

    r_edges, s_edges = edges(r_all, radius_bins), edges(s_all, speed_bins)

    def bins(r: torch.Tensor, s: torch.Tensor) -> torch.Tensor:
        return torch.bucketize(r, r_edges) * speed_bins + torch.bucketize(s, s_edges)

    total = torch.bincount(bins(r_all, s_all), minlength=radius_bins * speed_bins).double()
    used_bins = bins(r_used, s_used)
    kept = torch.bincount(used_bins, minlength=radius_bins * speed_bins).double()
    share = (kept + 1) / (total + 1)
    log_inverse = -torch.log(share)[used_bins]
    steps = torch.zeros(count, dtype=torch.float64, device=all_tracks.device).index_add_(0, owner, torch.ones_like(log_inverse))
    mean = torch.zeros(count, dtype=torch.float64, device=all_tracks.device).index_add_(0, owner, log_inverse) / steps.clamp(min=1)
    weights = torch.where(steps > 0, torch.exp(mean), torch.ones_like(mean))
    weights = (weights / weights.mean()).clamp(1 / limit, limit)
    return weights / weights.mean()


def track_medians(tracks: Tracks, values: torch.Tensor) -> torch.Tensor:
    """Each track's median value (the upper one of an even count, as the browser takes it)."""
    order = torch.argsort(values, stable=True)
    order = order[torch.argsort(tracks.owner[order], stable=True)]
    start = tracks.start[:-1]
    return values[order][start + tracks.sizes // 2]


def sprite_classes(analysis: Analysis, population: Population, crop_labels: np.ndarray) -> tuple[torch.Tensor, torch.Tensor]:
    """Sprite class per particle: its own crop's, else the nearest cropped particle's by size and light; and
    which particles have a crop of their own."""
    tracks = population.tracks
    owner_of_source = {}
    for t, sources in enumerate(tracks.sources):
        for s in sources:
            owner_of_source[s] = t
    points = analysis.points
    source_of_point = np.repeat(np.arange(analysis.track_count), np.diff(analysis.track_start))
    at_point = {(int(round(p[FRAME])), float(np.float32(p[X])), float(np.float32(p[Y]))): int(s) for p, s in zip(points, source_of_point)}
    classes = np.full(tracks.count, -1, dtype=np.int64)
    for (frame, x, y), label in zip(analysis.crop_at, crop_labels):
        if label < 0:
            continue
        source = at_point.get((int(round(frame)), float(np.float32(x)), float(np.float32(y))))
        t = owner_of_source.get(source) if source is not None else None
        if t is not None and classes[t] < 0:
            classes[t] = label
    spread = track_medians(tracks, tracks.spread).clamp(min=0.3).log()
    peak = track_medians(tracks, tracks.peak).clamp(min=1e-3).log()
    signature = torch.stack([spread, peak], 1).cpu().numpy()
    known = classes >= 0
    if not known.any():
        return torch.zeros(tracks.count, dtype=torch.long, device=tracks.device), torch.zeros(tracks.count, dtype=torch.bool, device=tracks.device)
    labelled, labels = signature[known], classes[known]
    for t in np.nonzero(~known)[0]:
        classes[t] = labels[np.argmin(((labelled - signature[t]) ** 2).sum(1))]
    return torch.as_tensor(classes, device=tracks.device), torch.as_tensor(known, device=tracks.device)
