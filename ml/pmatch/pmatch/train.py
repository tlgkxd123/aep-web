"""Trains the world model on the browser's analysis of a reference window.

Stages: the clock (motion.py), the population (population.py), the sprites (sprites.py), the appearance
(appearance.py), the audio network (dynamics.py) and the particle flow (generator.py)."""

from __future__ import annotations

import math
import platform
import time
from dataclasses import dataclass, field
from typing import Callable

import torch

from .appearance import fit_appearance
from .dataset import Analysis
from .dynamics import DynamicsOptions, DynamicsResult, train_dynamics
from .generator import FlowOptions, sample_bank, train_flow
from .geometry import Tracks
from .matching import bank_occupancy, match_steps
from .model import ParticleWorldModel, Settings
from .motion import fit_clock
from .nets import AudioTCN
from .population import PopulationOptions, StitchOptions, build_population, selection_weights, sprite_classes, two_frame_steps
from .sprites import learn_codebook

Progress = Callable[[str, float], None]


@dataclass
class TrainOptions:
    device: str | None = None
    seed: int = 1
    #: Particles in the bank the effect draws from (pairs of mirror images for a mirrored reference).
    bank: int = 2048
    #: Render-time jitter of a drawn particle: log speed, direction (radians), log size, log amplitude, log life.
    jitter: tuple[float, ...] = (0.03, 0.02, 0.04, 0.04, 0.04)
    dynamics: DynamicsOptions = field(default_factory=DynamicsOptions)
    flow: FlowOptions = field(default_factory=FlowOptions)
    population: PopulationOptions = field(default_factory=PopulationOptions)
    stitching: StitchOptions = field(default_factory=StitchOptions)


def pick_device(name: str | None) -> torch.device:
    if name:
        return torch.device(name)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def device_name(device: torch.device) -> str:
    if device.type == "cuda":
        return torch.cuda.get_device_name(device)
    return platform.processor() or platform.machine() or "CPU"


def silent_dynamics(analysis: Analysis, options: DynamicsOptions) -> DynamicsResult:
    """Without a sound track the clock runs at its mean speed and the shake at its mean amplitude."""
    network = AudioTCN(analysis.features.shape[1] if analysis.features.ndim == 2 else 16, options.channels, options.kernel, options.dilations, 3, 0.0)
    with torch.no_grad():
        network.head.bias[2] = analysis.shake.level if analysis.shake else 0.0
    return DynamicsResult(network.eval(), 0.0, 0.0, 0.0, False, 0)


def train(analysis: Analysis, options: TrainOptions = TrainOptions(), progress: Progress = lambda stage, share: None) -> ParticleWorldModel:
    started = time.perf_counter()
    device = pick_device(options.device)
    torch.manual_seed(options.seed)
    # The same analysis trains the same model: no GPU atomics or autotuned kernels that reorder sums.
    torch.use_deterministic_algorithms(True, warn_only=True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    seconds_in: dict[str, float] = {}
    current = ("", time.perf_counter())

    def stage(name: str, key: str, share: float) -> None:
        """Starts stage `key` (shown as `name`), timing the one before it."""
        nonlocal current
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        now = time.perf_counter()
        if current[0]:
            seconds_in[current[0]] = now - current[1]
        current = (key, now)
        progress(name, share)

    stage("Fitting the clock to the tracks", "Clock", 0.0)
    tracks = Tracks.from_analysis(analysis, analysis.center, device)
    clock_fit = fit_clock(tracks, analysis.first, analysis.frames, analysis.frame_rate)
    clock = clock_fit.clock

    stage("Joining particles across gaps", "Population", 0.08)
    population = build_population(analysis, tracks, clock, options.population, options.stitching)

    stage("Learning the sprites", "Sprites", 0.16)
    generator = torch.Generator(device=device).manual_seed(options.seed + 2)
    codebook = learn_codebook(torch.as_tensor(analysis.crop_templates, device=device), torch.as_tensor(analysis.crop_tint, device=device), generator)
    classes, cropped = sprite_classes(analysis, population, codebook.labels.cpu().numpy())

    stage("Learning how particles look over depth and life", "Appearance", 0.2)
    appearance = fit_appearance(population, clock)

    stage("Training the audio network", "Dynamics", 0.3)
    has_sound = analysis.features.ndim == 2 and len(analysis.features) > 0
    dynamics = train_dynamics(analysis, clock, device, options.dynamics, options.seed) if has_sound else silent_dynamics(analysis, options.dynamics)

    stage("Training the particle flow", "Flow", 0.55)
    height = analysis.height
    states = torch.cat(
        [population.motion, torch.log(appearance.size.double() / height)[:, None], torch.log(appearance.amplitude.double())[:, None], torch.log(population.life)[:, None]], 1
    ).float()
    weights = selection_weights(tracks, population)
    flow = train_flow(states, classes, codebook.templates.shape[0], options.flow, options.seed + 6, weights, cropped)
    bank, bank_sprites = sample_bank(flow, options.bank, options.flow.mirror, options.seed + 10)

    stage("Matching the particles' motion", "Matching", 0.92)
    _, r_steps, s_steps = two_frame_steps(tracks)
    r_edges = torch.quantile(r_steps, torch.arange(1, 10, device=device, dtype=r_steps.dtype) / 10)
    s_edges = torch.quantile(s_steps, torch.arange(1, 8, device=device, dtype=s_steps.dtype) / 8)
    reference = torch.bincount(torch.bucketize(r_steps, r_edges) * 8 + torch.bucketize(s_steps, s_edges), minlength=80).double()
    occupancy = bank_occupancy(bank, r_edges, s_edges, height, analysis.center, analysis.region, appearance.light_depth, appearance.opacity, analysis.min_peak, analysis.frame_rate)
    matching = match_steps(occupancy, reference / reference.sum(), options.flow.mirror)

    stage("Exporting", "Export", 0.97)
    mirror = 2 if options.flow.mirror else 1
    life = torch.exp(bank[:, -1])
    seconds = time.perf_counter() - started
    shake = analysis.shake
    report = {
        "tracks": analysis.track_count,
        "links": population.links,
        "used": population.tracks.count,
        "emerged": int(population.emerged.sum()),
        "censored": int(population.censored.sum()),
        "prototypes": len(bank),
        "bankPairs": 1 if options.flow.mirror else 0,
        "sprites": int(codebook.templates.shape[0]),
        "mirrored": 1 if analysis.mirror_axis is not None else 0,
        "mirrorAxis": analysis.mirror_axis if analysis.mirror_axis is not None else -1,
        "mirrorScore": analysis.mirror_score,
        "emitterX": analysis.center[0],
        "emitterY": analysis.center[1],
        "audio": 1 if has_sound else 0,
        "clockR2": dynamics.r2_valid,
        "clockR2Train": dynamics.r2_train,
        "clockSteps": dynamics.steps,
        "shaken": 1 if shake else 0,
        "shakeRms": shake.rms if shake else 0,
        "shakeTiltRms": shake.tilt_rms if shake else 0,
        "shakeR2": dynamics.shake_r2,
        "shakeFrequency": shake.frequency if shake else 0,
        "sizeDepth": appearance.size_depth,
        "lightDepth": appearance.light_depth,
        "curvePoints": appearance.curve_points,
        "flowNll": flow.nll_train,
        "flowNllValid": flow.nll_valid,
        "flowSteps": flow.steps,
        "spriteAccuracy": flow.sprite_accuracy,
        "selectionWeightMax": float(weights.max()),
        "selectionEffective": float(weights.sum() ** 2 / (weights * weights).sum() / len(weights)),
        "bankStepDistance": matching.distance_before,
        "bankStepDistanceMatched": matching.distance_after,
        "trainSeconds": seconds,
        **{f"seconds{key}": v for key, v in seconds_in.items()},
    }
    settings = Settings(
        rate=population.rate * mirror,
        pre_run=float(life.max()) if len(life) else 2.0,
        size_depth=appearance.size_depth,
        light_depth=appearance.light_depth,
        feature_rate=analysis.feature_rate,
        sprite_reach=analysis.template_reach,
        jitter=tuple(options.jitter),
        shake=None if shake is None else {"frequency": shake.frequency, "x": shake.x, "y": shake.y, "tilt": shake.tilt, "level": shake.level},
        source={
            "name": analysis.name,
            "width": analysis.width,
            "height": analysis.height,
            "frameRate": analysis.frame_rate,
            "mirrorAxis": analysis.mirror_axis,
            "center": list(analysis.center),
            "train": list(analysis.train),
        },
        trainer={"framework": "pytorch", "version": torch.__version__, "device": device.type, "deviceName": device_name(device), "seconds": seconds},
        report={k: float(v) for k, v in report.items() if isinstance(v, (int, float)) and math.isfinite(float(v))},
    )
    model = ParticleWorldModel(dynamics.network.cpu(), flow.flow.cpu(), codebook.templates.cpu(), codebook.tint.cpu(), appearance.opacity.cpu(), bank.cpu(), bank_sprites.cpu(), settings)
    model.bank_weights.copy_(matching.weights.float().cpu())
    progress("Done", 1.0)
    return model
